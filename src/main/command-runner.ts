import { execSync, spawn, type ChildProcess } from 'node:child_process';
import type { WebContents } from 'electron';
import { IpcChannels } from '@shared/ipc-channels';
import type {
  CommandExitEvent,
  CommandOutputEvent,
  Shell,
} from '@shared/types';

const running = new Map<string, ChildProcess>();

// ANSI escape sequences — colour codes, cursor moves, window-title sets.
// Many CLI tools emit these; Vorlox renders plain text, so unstripped
// they show as noise. Stripped at the source so output is clean
// everywhere downstream (display, copy, the history sent to the backend).
//
// Both alternatives are anchored on the ESC byte (), so the
// pattern can only ever hit real escape sequences, never ordinary text
// that happens to contain brackets:
//   - CSI: ESC [ <params> <final letter>  — colours, cursor control
//   - OSC: ESC ] <data> BEL               — window-title sets etc.
// Per-chunk: a sequence split across two data chunks can slip through —
// rare, cosmetic at worst, not worth a reassembly buffer.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001B\[[0-9;?]*[A-Za-z]|\u001B\][^\u0007]*\u0007/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

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

// Pick the shell binary + arguments for a command, based on the user's
// actual shell. Spawning the right binary directly is the only way
// PowerShell cmdlets (Get-*, ConvertTo-Csv, etc.) and shell-specific
// syntax work — invoking through cmd.exe would never resolve a
// PowerShell-only cmdlet, and the spawn `shell: 'powershell.exe'`
// shortcut doesn't pass the right flags.
//
// The planner already targets commands at the user's shell, so we just
// need to invoke the matching binary here.
interface ShellInvocation {
  bin: string;
  args: string[];
}

function invocationFor(shell: Shell, command: string): ShellInvocation {
  switch (shell) {
    case 'powershell':
      // -NoProfile avoids loading the user's profile (faster + more
      // predictable). -Command takes the command as a single string.
      return { bin: 'powershell.exe', args: ['-NoProfile', '-Command', command] };
    case 'cmd':
      // /d skips AutoRun, /s + /c is the canonical "run this and exit"
      // pair that preserves quoting per cmd's documented behaviour.
      return {
        bin: process.env.COMSPEC || 'cmd.exe',
        args: ['/d', '/s', '/c', command],
      };
    case 'bash':
      return { bin: '/bin/bash', args: ['-c', command] };
    case 'zsh':
      return { bin: '/bin/zsh', args: ['-c', command] };
    case 'fish':
      return { bin: '/usr/bin/fish', args: ['-c', command] };
  }
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
  shell: Shell,
): void {
  if (running.has(id)) return;

  // `cwd` is supplied by the renderer per-conversation — each conversation
  // tracks its own working directory (or none, in which case the renderer
  // passes the user's home directory). Each command runs in a fresh shell,
  // so a `cd` inside a command does not affect Vorlox's tracked cwd; the
  // AI layer handles `cd` as a special case that updates the conversation's
  // cwd via setCwd().
  const { bin, args } = invocationFor(shell, command);
  const child = spawn(bin, args, {
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
    send(IpcChannels.CommandOutput, { id, stream: 'stdout', data: stripAnsi(data) });
  });

  child.stderr?.on('data', (data: string) => {
    send(IpcChannels.CommandOutput, { id, stream: 'stderr', data: stripAnsi(data) });
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
