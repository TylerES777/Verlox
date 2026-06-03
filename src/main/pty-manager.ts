import { homedir } from 'node:os';
import * as nodePty from '@homebridge/node-pty-prebuilt-multiarch';
import type { IPty } from '@homebridge/node-pty-prebuilt-multiarch';
import type { WebContents } from 'electron';
import { IpcChannels } from '@shared/ipc-channels';
import type { PtyDataEvent, PtyExitEvent } from '@shared/types';
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
}

const sessions = new Map<string, Session>();

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
    // Force the older WinPTY backend on Windows. The modern ConPTY backend
    // ships a helper (conpty_console_list_agent) that crashes with
    // "AttachConsole failed" under Electron here, which kills the shell
    // the instant it starts. WinPTY has no such helper and hosts
    // interactive CLIs (Claude Code, REPLs) reliably. No-op off Windows.
    useConpty: false,
  });

  sessions.set(id, { pty, sender });

  // Only the PTY currently registered under `id` is the "live" one. In dev,
  // React StrictMode mounts → unmounts → remounts a component, so a tab can
  // spawn a shell, kill it, then spawn a replacement under the same id. The
  // killed shell's data/exit callbacks fire slightly later; without this
  // guard, that stale shell's delayed exit would delete the replacement's
  // session and tell the renderer the terminal had died.
  const isCurrent = () => sessions.get(id)?.pty === pty;

  pty.onData((data: string) => {
    if (!isCurrent()) return;
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
