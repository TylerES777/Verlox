import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import type { DirEntry, DirListing } from '@shared/types';

// Backs the IpcChannels.DirList handler — the path picker's only window
// into the filesystem. The renderer is sandboxed and has no fs access,
// so every browse step round-trips here.

function expandTilde(input: string): string {
  if (input === '' || input === '~') return homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return join(homedir(), input.slice(2));
  }
  return input;
}

// Parent of `absPath`, or null when `absPath` is already a filesystem
// root (path.dirname returns the input unchanged at a root).
function parentOf(absPath: string): string | null {
  const parent = dirname(absPath);
  if (parent === absPath) return null;
  // On Windows, dirname of `C:\` is `C:\` (handled above), but dirname
  // of `C:\Users` is `C:\` — fine. parse().root guards the edge where
  // the path normalizes oddly.
  if (parent === parse(absPath).root && parent === absPath) return null;
  return parent;
}

/**
 * Lists the contents of a directory for the path picker. Folders are
 * sorted before files; each group is alphabetical (case-insensitive).
 * Entries that can't be stat'd (broken symlinks, permission quirks on a
 * single child) are skipped rather than failing the whole listing.
 *
 * Never throws — a failed listing comes back with a non-null `error`.
 */
export function listDirectory(requestedPath: string): DirListing {
  const absPath = expandTilde(requestedPath);

  let names: string[];
  try {
    const stat = statSync(absPath);
    if (!stat.isDirectory()) {
      return {
        path: absPath,
        parent: parentOf(absPath),
        entries: [],
        error: 'Not a directory',
      };
    }
    names = readdirSync(absPath);
  } catch {
    return {
      path: absPath,
      parent: parentOf(absPath),
      entries: [],
      error: "Couldn't open that folder",
    };
  }

  const entries: DirEntry[] = [];
  for (const name of names) {
    const childPath = join(absPath, name);
    try {
      const isDirectory = statSync(childPath).isDirectory();
      entries.push({ name, path: childPath, isDirectory });
    } catch {
      // Unreadable child (permission, broken link) — skip it silently.
    }
  }

  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });

  return {
    path: absPath,
    parent: parentOf(absPath),
    entries,
    error: null,
  };
}
