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
    // Always PowerShell on Windows. COMSPEC almost universally points
    // at cmd.exe (Windows's documented default) even for PowerShell
    // users, so trusting it as a "what shell is the user on?" signal
    // gives the wrong answer constantly — and falling back to cmd is
    // worse than useless on Windows 11, where deprecated builtins
    // (wmic, etc.) fail outright. PowerShell ships with every modern
    // Windows install and can run the same external binaries cmd
    // does, so it's a strict superset for planning purposes.
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
