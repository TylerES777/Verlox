import { execSync, spawn, type ChildProcess } from 'node:child_process';
import type { WebContents } from 'electron';
import { IpcChannels } from '@shared/ipc-channels';
import type { CommandExitEvent, CommandOutputEvent } from '@shared/types';
import { getCwd } from './store';

const running = new Map<string, ChildProcess>();

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
): void {
  if (running.has(id)) return;

  const cwd = getCwd().absolute;

  // NOTE: each command runs in a fresh shell, so `cd` inside a command
  // does not affect Vorlox's tracked cwd. Phase 3's AI layer will handle
  // `cd` as a special case that updates the persisted cwd via setCwd().
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
    send(IpcChannels.CommandExit, { id, code, signal });
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
  killProcess(child);
}

export function killAll(): void {
  for (const child of running.values()) {
    killProcess(child);
  }
  running.clear();
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
}
