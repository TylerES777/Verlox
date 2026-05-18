import { execSync, spawn, type ChildProcess } from 'node:child_process';
import type { WebContents } from 'electron';
import { IpcChannels } from '@shared/ipc-channels';
import type { CommandExitEvent, CommandOutputEvent } from '@shared/types';

const running = new Map<string, ChildProcess>();

// Set of command ids that have been kill-requested by the user via
// stopCommand(). Cross-platform "killed by user" tracking — Windows's
// TerminateProcess (via taskkill /F) doesn't translate to a Unix signal
// name, so Node reports {code: 1, signal: null} on a successful taskkill,
// indistinguishable from a natural exit. Tracking the request explicitly
// in this Set lets finish() override signal to a non-null sentinel
// (`'SIGTERM'`) when sending the CommandExit IPC, so the renderer's
// `signal != null = killed-by-user` check works the same on every platform.
//
// Lifecycle: added in stopCommand(), removed in finish() (or manually if
// the process exited naturally between request and reaping).
const killRequested = new Set<string>();

function shellFor(): string | true {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'cmd.exe';
  }
  return '/bin/sh';
}

function killProcess(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid != null) {
    // taskkill /T terminates the entire process tree, /F forces termination.
    // Killing cmd.exe alone leaves spawned children (e.g. `ping -t`) orphaned.
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
    });
  } else {
    child.kill('SIGTERM');
    setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
    }, 2000).unref();
  }
}

export function startCommand(
  webContents: WebContents,
  id: string,
  command: string,
  cwd: string,
): void {
  if (running.has(id)) return;

  // `cwd` is supplied by the renderer per-conversation — each conversation
  // tracks its own working directory (or none, in which case the renderer
  // passes the user's home directory). Each command runs in a fresh shell,
  // so a `cd` inside a command does not affect Vorlox's tracked cwd; the
  // AI layer handles `cd` as a special case that updates the conversation's
  // cwd via setCwd().
  const child = spawn(command, {
    shell: shellFor(),
    cwd,
    env: process.env,
    windowsHide: true,
  });

  running.set(id, child);

  const send = (channel: string, payload: CommandOutputEvent | CommandExitEvent) => {
    if (!webContents.isDestroyed()) {
      webContents.send(channel, payload);
    }
  };

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');

  child.stdout?.on('data', (data: string) => {
    send(IpcChannels.CommandOutput, { id, stream: 'stdout', data });
  });

  child.stderr?.on('data', (data: string) => {
    send(IpcChannels.CommandOutput, { id, stream: 'stderr', data });
  });

  const finish = (code: number | null, signal: string | null) => {
    if (!running.has(id)) return;
    running.delete(id);
    const wasKilled = killRequested.has(id);
    killRequested.delete(id);
    // Cross-platform "killed by user" sentinel. On POSIX the actual signal
    // (e.g. 'SIGTERM') is preserved when present. On Windows, taskkill /F
    // produces {signal: null, code: <usually 1>} even on success — we
    // override to 'SIGTERM' when wasKilled so the renderer's
    // `signal != null` check identifies the kill correctly.
    const effectiveSignal = wasKilled ? (signal ?? 'SIGTERM') : signal;
    send(IpcChannels.CommandExit, { id, code, signal: effectiveSignal });
  };

  child.on('exit', (code, signal) => finish(code, signal));
  child.on('error', (err) => {
    send(IpcChannels.CommandOutput, {
      id,
      stream: 'stderr',
      data: `vorlox: ${err.message}\n`,
    });
    finish(null, null);
  });
}

export function stopCommand(id: string): void {
  const child = running.get(id);
  if (!child) return;
  killRequested.add(id);
  killProcess(child);
}

export function killAll(): void {
  for (const child of running.values()) {
    killProcess(child);
  }
  running.clear();
  killRequested.clear();
}

// Synchronous variant for use during app shutdown. The async killProcess above
// uses spawn(), which queues the kill on libuv's threadpool — by the time
// taskkill actually launches, Electron's main process has already exited and
// the spawn never happens. execSync blocks the main process until taskkill
// finishes, which is the only reliable way to clean up before quit.
function killProcessSync(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid != null) {
    try {
      execSync(`taskkill /pid ${child.pid} /T /F`, {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      // Process may have already exited, or taskkill itself failed; ignore.
    }
  } else {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already dead.
    }
  }
}

export function killAllSync(): void {
  for (const child of running.values()) {
    killProcessSync(child);
  }
  running.clear();
  killRequested.clear();
}
