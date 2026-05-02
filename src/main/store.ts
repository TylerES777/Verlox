import Store from 'electron-store';
import { homedir } from 'node:os';
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
  let stat;
  try {
    stat = statSync(nextPath);
  } catch {
    throw new Error(`Path does not exist: ${nextPath}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${nextPath}`);
  }
  store.set('cwd', nextPath);
  return describe(nextPath);
}
