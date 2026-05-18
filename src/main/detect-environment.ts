import { basename } from 'node:path';
import { homedir } from 'node:os';
import type { EnvironmentInfo, Platform, Shell } from '@shared/types';

function detectPlatform(): Platform {
  if (process.platform === 'win32') return 'win32';
  if (process.platform === 'darwin') return 'darwin';
  return 'linux';
}

function detectShell(platform: Platform): Shell {
  if (platform === 'win32') {
    // COMSPEC points at the user's command interpreter — usually cmd.exe.
    // PowerShell users typically still have COMSPEC=cmd.exe; detecting
    // PowerShell from env vars is unreliable, so default to powershell on
    // modern Windows (it's the recommended modern shell and matches
    // Microsoft's terminal default since Windows 11).
    const comspec = process.env.COMSPEC?.toLowerCase() ?? '';
    if (comspec.endsWith('powershell.exe') || comspec.endsWith('pwsh.exe')) {
      return 'powershell';
    }
    if (comspec.endsWith('cmd.exe')) return 'cmd';
    return 'powershell';
  }

  // POSIX: SHELL env var holds the path to the user's login shell.
  const shellPath = process.env.SHELL ?? '';
  const name = basename(shellPath).toLowerCase();
  if (name === 'zsh') return 'zsh';
  if (name === 'bash') return 'bash';
  if (name === 'fish') return 'fish';

  // Fallbacks: zsh on macOS (Catalina+ default), bash on Linux.
  return platform === 'darwin' ? 'zsh' : 'bash';
}

let cached: EnvironmentInfo | null = null;

export function getEnvironment(): EnvironmentInfo {
  if (cached) return cached;
  const platform = detectPlatform();
  const shell = detectShell(platform);
  cached = { platform, shell, homeDir: homedir() };
  return cached;
}
