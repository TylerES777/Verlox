import { homedir } from 'node:os';
import * as nodePty from '@homebridge/node-pty-prebuilt-multiarch';
import type { IPty } from '@homebridge/node-pty-prebuilt-multiarch';
import type { WebContents } from 'electron';
import { IpcChannels } from '@shared/ipc-channels';
import type { PtyBlockEvent, PtyDataEvent, PtyExitEvent } from '@shared/types';
import { noteCommandRun } from './snapshot-manager';
import { buildSafeShell } from './shell-safety';

// Owns the live pseudo-terminals that back interactive terminal tabs.
// Distinct from command-runner.ts: that module runs discrete one-shot
// commands (ANSI stripped, output relayed as plain text) for the
// plan-execution flow. A PTY here is a real interactive terminal — the
// user types into it directly and it can host interactive CLIs (Claude
// Code, vim, REPLs), which a plain spawn() can never do.

interface Session {
  pty: IPty;
  // The window the data/exit events fan out to. Captured at start; there's
  // a single window today, but keeping it per-session means a destroyed
  // sender never receives a send (which would throw).
  sender: WebContents;
  // Command-block tracking state (driven by the OSC 133 marks the shell
  // emits — see shell-safety.ts).
  block: BlockState;
}

const sessions = new Map<string, Session>();

// --- Command blocks (OSC 133 shell integration) ---------------------------
// The shell emits invisible markers around each prompt/command/output:
//   ESC]133;A  prompt start    ESC]133;B  command start (after prompt)
//   ESC]133;C  output start    ESC]133;D;<exit>  command finished
// We parse the byte stream as it flows by, accumulate the command text
// (B→C) and its output (C→D), and emit a structured block on D. This is the
// foundation for rendering Warp-style blocks (Phase 2) and the AI toggle.

interface BlockState {
  phase: 'idle' | 'prompt' | 'command' | 'output';
  command: string;
  output: string;
  startedAt: number;
  // Holds a partial OSC sequence split across two data chunks.
  pending: string;
}

function newBlockState(): BlockState {
  return { phase: 'idle', command: '', output: '', startedAt: 0, pending: '' };
}

const OSC133 = '\x1b]133;';

// Length of the trailing substring of `tail` that is a prefix of OSC133 — so
// a marker split across chunks isn't mistaken for output and lost.
function partialPrefixLen(tail: string): number {
  for (let k = Math.min(OSC133.length - 1, tail.length); k > 0; k--) {
    if (tail.slice(-k) === OSC133.slice(0, k)) return k;
  }
  return 0;
}

function appendBlockText(state: BlockState, text: string): void {
  if (!text) return;
  if (state.phase === 'command') state.command += text;
  else if (state.phase === 'output') state.output += text;
}

function handleBlockMark(
  sender: WebContents,
  id: string,
  state: BlockState,
  payload: string,
): void {
  const kind = payload[0];
  if (kind === 'A') {
    // New prompt — start a fresh pending block.
    state.phase = 'prompt';
    state.command = '';
    state.output = '';
  } else if (kind === 'B') {
    state.phase = 'command';
  } else if (kind === 'C') {
    // payload is "C;<command>" — the command text rides in the marker.
    state.command = payload.slice(2);
    state.output = '';
    state.startedAt = Date.now();
    state.phase = 'output';
  } else if (kind === 'D') {
    const raw = payload.split(';')[1];
    const exitNum = raw !== undefined && raw !== '' ? Number(raw) : NaN;
    const block: PtyBlockEvent = {
      id,
      command: state.command,
      output: state.output,
      exitCode: Number.isFinite(exitNum) ? exitNum : null,
      durationMs: state.startedAt ? Date.now() - state.startedAt : 0,
    };
    if (!sender.isDestroyed()) sender.send(IpcChannels.PtyBlock, block);
    state.phase = 'idle';
    state.command = '';
    state.output = '';
  }
}

// Feed a raw PTY chunk through the block parser. Extracts complete OSC 133
// markers, routes the text between them to the current command/output buffer,
// and buffers any marker split across the chunk boundary.
function ingestBlocks(
  sender: WebContents,
  id: string,
  state: BlockState,
  chunk: string,
): void {
  const data = state.pending + chunk;
  state.pending = '';
  let i = 0;
  while (i < data.length) {
    const mark = data.indexOf(OSC133, i);
    if (mark === -1) {
      const tail = data.slice(i);
      const hold = partialPrefixLen(tail);
      if (hold > 0) {
        appendBlockText(state, tail.slice(0, tail.length - hold));
        state.pending = tail.slice(tail.length - hold);
      } else {
        appendBlockText(state, tail);
      }
      break;
    }
    appendBlockText(state, data.slice(i, mark));
    const bel = data.indexOf('\x07', mark);
    if (bel === -1) {
      // Marker not finished yet — wait for the next chunk.
      state.pending = data.slice(mark);
      break;
    }
    handleBlockMark(sender, id, state, data.slice(mark + OSC133.length, bel));
    i = bel + 1;
  }
}

export function ptyStart(
  sender: WebContents,
  id: string,
  cwd: string | undefined,
  cols: number,
  rows: number,
): void {
  // Idempotent: a remount that re-issues start for a live id is a no-op,
  // so we never orphan a running shell or double-spawn.
  if (sessions.has(id)) return;

  // A real terminal should feel like the user's own shell — so we DON'T
  // strip the profile (aliases, prompt, PATH tweaks are part of what they
  // expect). On Windows this also injects Verlox's safe-delete override so
  // deletions go to the Recycle Bin (see shell-safety.ts).
  const { file, args } = buildSafeShell();
  const pty = nodePty.spawn(file, args, {
    name: 'xterm-color',
    cols: cols > 0 ? cols : 80,
    rows: rows > 0 ? rows : 24,
    cwd: cwd && cwd.length > 0 ? cwd : homedir(),
    env: process.env as Record<string, string>,
    // Force the older WinPTY backend on Windows — ConPTY logs "AttachConsole
    // failed" under Electron here and is unstable. NOTE: WinPTY also strips the
    // invisible OSC 133 markers the shell emits, so command-block detection
    // (Phase 1, see shell-safety.ts) is dormant on this backend. Visual
    // command blocks need ConPTY stabilized first.
    useConpty: false,
  });

  sessions.set(id, { pty, sender, block: newBlockState() });

  // Only the PTY currently registered under `id` is the "live" one. In dev,
  // React StrictMode mounts → unmounts → remounts a component, so a tab can
  // spawn a shell, kill it, then spawn a replacement under the same id. The
  // killed shell's data/exit callbacks fire slightly later; without this
  // guard, that stale shell's delayed exit would delete the replacement's
  // session and tell the renderer the terminal had died.
  const isCurrent = () => sessions.get(id)?.pty === pty;

  pty.onData((data: string) => {
    if (!isCurrent()) return;
    // Parse command-block boundaries from the stream before forwarding the
    // raw bytes to xterm (the OSC 133 marks are invisible there).
    const session = sessions.get(id);
    if (session) ingestBlocks(sender, id, session.block, data);
    if (!sender.isDestroyed()) {
      const event: PtyDataEvent = { id, data };
      sender.send(IpcChannels.PtyData, event);
    }
  });

  pty.onExit(({ exitCode }) => {
    if (!isCurrent()) return;
    sessions.delete(id);
    if (!sender.isDestroyed()) {
      const event: PtyExitEvent = { id, exitCode };
      sender.send(IpcChannels.PtyExit, event);
    }
  });
}

export function ptyInput(id: string, data: string): void {
  // A carriage return means the user is submitting a line — a shell command,
  // or a prompt to an interactive CLI. Just before it reaches the shell, ask
  // the snapshot manager to capture the pre-command state (throttled and
  // non-blocking, so it never delays the keystroke).
  if (data.includes('\r')) noteCommandRun();
  sessions.get(id)?.pty.write(data);
}

export function ptyResize(id: string, cols: number, rows: number): void {
  const session = sessions.get(id);
  if (!session) return;
  // node-pty throws if given non-positive dimensions (can happen when a
  // hidden/zero-size tab reports its size). Clamp to a sane floor.
  try {
    session.pty.resize(Math.max(1, cols), Math.max(1, rows));
  } catch {
    // Transient bad geometry during layout; the next resize corrects it.
  }
}

export function ptyKill(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  try {
    session.pty.kill();
  } catch {
    // Already exited.
  }
}

// Tear down every live PTY. Called on app quit and when a window is
// destroyed, so no shell process is left orphaned.
export function killAllPtys(): void {
  for (const { pty } of sessions.values()) {
    try {
      pty.kill();
    } catch {
      // Already exited.
    }
  }
  sessions.clear();
}
