import Store from 'electron-store';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { statSync } from 'node:fs';
import { tildify } from '@shared/path-utils';
import type { CwdInfo } from '@shared/types';

interface StoreSchema {
  cwd: string;
}

const store = new Store<StoreSchema>({
  defaults: { cwd: homedir() },
  schema: {
    cwd: { type: 'string', minLength: 1 },
  },
});

function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function describe(absolute: string): CwdInfo {
  return { absolute, display: tildify(absolute, homedir()) };
}

/**
 * Expand a leading `~` or `~/` (or `~\` on Windows) to the user's home
 * directory. Inputs that don't start with `~` pass through unchanged.
 *
 * The desktop app (renderer) doesn't have access to os.homedir(), so the
 * /api/translate prompt instructs Claude to return ~/-prefixed paths when
 * referencing the user's home. This is where they get expanded.
 */
function expandTilde(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return join(homedir(), input.slice(2));
  }
  return input;
}

export function initCwd(): CwdInfo {
  const stored = store.get('cwd');
  if (isExistingDirectory(stored)) {
    return describe(stored);
  }
  const fallback = homedir();
  store.set('cwd', fallback);
  return describe(fallback);
}

export function getCwd(): CwdInfo {
  return describe(store.get('cwd'));
}

export function setCwd(nextPath: string): CwdInfo {
  if (typeof nextPath !== 'string' || nextPath.length === 0) {
    throw new Error('Path must be a non-empty string');
  }
  const expanded = expandTilde(nextPath);
  let stat;
  try {
    stat = statSync(expanded);
  } catch {
    throw new Error(`Path does not exist: ${nextPath}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${nextPath}`);
  }
  store.set('cwd', expanded);
  return describe(expanded);
}
