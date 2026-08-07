import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
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
  // True once any OSC 133 mark has been seen from this shell. Only then can
  // mark-based liveness checks (below) be trusted.
  sawMarks: boolean;
  // When the last 'C' (command started) mark arrived. ptyRunCommand uses
  // this to verify the shell actually accepted a command, rather than
  // swallowing it into a stuck in-shell prompt.
  lastStartMarkAt: number;
}

const sessions = new Map<string, Session>();

// Set the first time a ConPTY shell fails its health check (or throws at
// spawn). From then on every shell in this app run uses WinPTY — one bad
// backend experience per launch, never a flapping one.
let conptyBroken = false;

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
  const marked = sessions.get(id);
  if (marked) marked.sawMarks = true;
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
    const session = sessions.get(id);
    if (session) session.lastStartMarkAt = Date.now();
    // Tell the renderer a block is opening so it can show a running card
    // and stream output into it, rather than waiting for the command to end.
    if (!sender.isDestroyed()) {
      sender.send(IpcChannels.PtyBlockStart, { id, command: state.command });
    }
  } else if (kind === 'D') {
    // A 'D' with no command ever started (no 'C') is prompt housekeeping:
    // Ctrl+C at an idle prompt redraws it and the prompt hook dutifully
    // emits D. Reporting it would materialize an empty phantom block.
    if (state.phase !== 'output' && !state.command) {
      state.phase = 'idle';
      state.output = '';
      return;
    }
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
  const { file, args, env: shellEnv } = buildSafeShell();
  const useConpty =
    process.platform === 'win32' &&
    !conptyBroken &&
    process.env.VERLOX_FORCE_WINPTY !== '1';
  let pty: IPty;
  try {
    pty = nodePty.spawn(file, args, {
      name: 'xterm-color',
      cols: cols > 0 ? cols : 80,
      rows: rows > 0 ? rows : 24,
      cwd: cwd && cwd.length > 0 ? cwd : homedir(),
      // shellEnv carries the POSIX shell-integration vars (ZDOTDIR and the
      // user's original, so our init can source their real config). When
      // there is none (Windows), pass process.env through untouched rather
      // than a spread copy — node-pty is fussy about the env on Windows.
      env: shellEnv
        ? { ...(process.env as Record<string, string>), ...shellEnv }
        : (process.env as Record<string, string>),
      // ConPTY first: it passes the OSC 133 marks through reliably (real
      // exit codes, no prompt-guessing) and delivers genuine Ctrl+C events
      // that cancel even in-shell prompts — both verified against the real
      // shell. ConPTY has historically been flaky under Electron, so the
      // health check below demotes to WinPTY the moment a shell dies young
      // or never speaks, and remembers the verdict for the whole app run.
      // VERLOX_FORCE_WINPTY=1 skips ConPTY outright.
      useConpty,
    });
  } catch (err) {
    if (!useConpty) throw err;
    conptyBroken = true;
    ptyStart(sender, id, cwd, cols, rows);
    return;
  }

  sessions.set(id, {
    pty,
    sender,
    block: newBlockState(),
    sawMarks: false,
    lastStartMarkAt: 0,
  });

  // ConPTY health check: a shell that produces NOTHING in its first
  // seconds, or exits almost immediately, is the known Electron failure
  // mode. Replace it with a WinPTY shell under the same tab id — the
  // renderer never notices — and stop trying ConPTY for this app run.
  const bornAt = Date.now();
  let spoke = false;
  const demote = () => {
    if (sessions.get(id)?.pty !== pty) return;
    conptyBroken = true;
    sessions.delete(id);
    try {
      pty.kill();
    } catch {
      // Already dead.
    }
    ptyStart(sender, id, cwd, cols, rows);
  };
  if (useConpty) {
    setTimeout(() => {
      if (sessions.get(id)?.pty === pty && !spoke) demote();
    }, 3500);
  }

  // Only the PTY currently registered under `id` is the "live" one. In dev,
  // React StrictMode mounts → unmounts → remounts a component, so a tab can
  // spawn a shell, kill it, then spawn a replacement under the same id. The
  // killed shell's data/exit callbacks fire slightly later; without this
  // guard, that stale shell's delayed exit would delete the replacement's
  // session and tell the renderer the terminal had died.
  const isCurrent = () => sessions.get(id)?.pty === pty;

  pty.onData((data: string) => {
    if (!isCurrent()) return;
    spoke = true;
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
    // A ConPTY shell dying in its first seconds is the Electron failure
    // mode, not the user typing `exit` — demote instead of closing the tab.
    if (useConpty && Date.now() - bornAt < 4000) {
      demote();
      return;
    }
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

// Force-kill every child process of the shell (the foreground program and
// its tree), leaving the shell itself alive. Runs in a helper process;
// `done` fires once the kills have happened, with how many direct children
// existed — zero means whatever is "running" is the shell itself.
function killShellChildren(shellPid: number, done: (killed: number) => void): void {
  execFile(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$c = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=${shellPid}"); ` +
        `$c | ForEach-Object { taskkill.exe /T /F /PID $_.ProcessId } | Out-Null; ` +
        `$c.Count`,
    ],
    { windowsHide: true },
    (_err, stdout) => {
      const n = parseInt((stdout || '').trim(), 10);
      done(Number.isFinite(n) ? n : 0);
    },
  );
}

// Replace a session's shell with a fresh one at `cwd`, keeping the tab id
// and all stream wiring. The escape hatch for a shell wedged inside its own
// prompt: -Confirm / Read-Host reads under WinPTY survive a written ^C, a
// genuine CTRL_C_EVENT (menu just reprints), and have no children to kill —
// all three were tried. Only a new shell gets the tab moving again.
function respawnShell(id: string, cwd: string | undefined): void {
  const session = sessions.get(id);
  if (!session) return;
  const { sender, pty: old } = session;
  const cols = old.cols;
  const rows = old.rows;
  // Deleting first makes the old shell's onExit/onData guards miss, so the
  // renderer never hears "terminal exited" for a tab that lives on.
  sessions.delete(id);
  killShellChildren(old.pid, () => {
    try {
      old.kill();
    } catch {
      // Already dead is fine; we only needed it gone.
    }
    if (!sender.isDestroyed()) ptyStart(sender, id, cwd, cols, rows);
  });
}

// Stop whatever the shell is currently running, without touching the shell
// itself. Layers, because no single one covers everything:
//   1. Ctrl+C — cancels ordinary loops and in-shell line edits.
//   2. Force-kill the shell's child processes — REPLs shrug off a single
//      Ctrl+C (python prints KeyboardInterrupt and stays, node asks for a
//      second one). Stop means stop, so the foreground program and its
//      whole tree go; the shell survives and prints its prompt.
//   3. If the shell was mid-command and its 'D' mark still hasn't arrived,
//      the shell itself is wedged in an in-shell prompt — replace it.
export function ptyStopForeground(id: string, cwd?: string): void {
  const session = sessions.get(id);
  if (!session) return;
  try {
    session.pty.write('\x03');
  } catch {
    return; // Shell already gone.
  }
  if (process.platform !== 'win32') return;
  const wasMidCommand = session.block.phase === 'output';
  killShellChildren(session.pty.pid, (killed) => {
    if (sessions.get(id)?.pty !== session.pty) return;
    if (session.sawMarks) {
      // Marks are trustworthy here: wedged means still mid-command after
      // the kill sweep, with no 'D' arriving.
      if (!wasMidCommand) return;
      setTimeout(() => {
        const s = sessions.get(id);
        if (s && s.pty === session.pty && s.block.phase === 'output') {
          respawnShell(id, cwd);
        }
      }, 1200);
      return;
    }
    // No marks (WinPTY drops them under Electron). Stop is only offered
    // while the renderer sees a command running — so zero children killed
    // means the "running thing" is the shell itself, wedged in its own
    // prompt. A fresh shell is the only reliable way out.
    if (killed === 0) respawnShell(id, cwd);
  });
}

// Stop whatever is running, then run a new command. Lives here rather than
// in the renderer because only main can see the truth: the process table
// says what died, and the shell's own 'C' mark says whether the command was
// actually accepted or swallowed by a wedged in-shell prompt. If nothing was
// running, this degrades to Ctrl+C at an idle prompt followed by the command.
export function ptyRunCommand(id: string, command: string, cwd?: string): void {
  const session = sessions.get(id);
  if (!session) return;
  try {
    session.pty.write('\x03');
  } catch {
    return; // Shell already gone.
  }
  const send = () => {
    try {
      // Newlines in a multi-line command become real Enter presses, so a
      // pasted block (a here-string, a multi-line script) parses exactly
      // as it would if typed.
      sessions.get(id)?.pty.write(`${command.replace(/\r?\n/g, '\r')}\r`);
    } catch {
      // Shell died in the window; nothing to run it in.
    }
  };
  if (process.platform !== 'win32') {
    // POSIX: SIGINT from the ^C reaches the foreground group directly.
    setTimeout(send, 350);
    return;
  }
  // The kills are done when the callback fires; the short beat lets the
  // shell repaint its prompt first.
  killShellChildren(session.pty.pid, (killed) =>
    setTimeout(() => {
      if (sessions.get(id)?.pty !== session.pty) return;
      if (session.sawMarks) {
        const before = session.lastStartMarkAt;
        const wasMidCommand = session.block.phase === 'output';
        send();
        // Verify the command actually STARTED (a fresh 'C' mark). A shell
        // wedged in its own prompt eats the text instead; the only
        // reliable escape is a fresh shell at the same directory, where
        // the command is then re-sent for real.
        if (!wasMidCommand) return;
        setTimeout(() => {
          const s = sessions.get(id);
          if (!s || s.pty !== session.pty) return;
          if (s.lastStartMarkAt > before) return; // accepted, all good
          respawnShell(id, cwd);
          setTimeout(send, 1500);
        }, 1200);
        return;
      }
      // No marks (WinPTY drops them under Electron), so there is nothing
      // to verify acceptance against. The bar only routes here while the
      // renderer sees a command running — so if the kill sweep found a
      // program, the shell is free again and the command can go in; if it
      // found NOTHING, the "running thing" is the shell itself wedged in
      // an in-shell prompt, and writing would just feed that prompt.
      // Replace the shell, then run the command in the fresh one.
      if (killed > 0) {
        send();
        return;
      }
      respawnShell(id, cwd);
      // The new shell needs a beat to draw its first prompt before input.
      setTimeout(send, 1500);
    }, 300),
  );
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
