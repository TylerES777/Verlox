import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Context data for the command bar's Tab completion: things only the
// machine knows and the renderer can't read itself. Everything here is
// best-effort — a completion source that fails just offers nothing.

export type CompletionKind = 'git-branches' | 'npm-scripts';

export async function completionContext(
  kind: CompletionKind,
  cwd: string,
): Promise<string[]> {
  if (!cwd) return [];
  if (kind === 'git-branches') return gitBranches(cwd);
  if (kind === 'npm-scripts') return npmScripts(cwd);
  return [];
}

// Local branches, current first (git lists it first with this format when
// sorted by -committerdate... it doesn't — keep git's order, which puts
// HEAD's branch wherever it falls; recency sort makes the likely target
// land at the top of the chips).
function gitBranches(cwd: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['branch', '--sort=-committerdate', '--format=%(refname:short)'],
      { cwd, windowsHide: true, timeout: 3000 },
      (err, stdout) => {
        if (err) return resolve([]);
        resolve(
          stdout
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)
            .slice(0, 40),
        );
      },
    );
  });
}

async function npmScripts(cwd: string): Promise<string[]> {
  try {
    const raw = await readFile(join(cwd, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    return Object.keys(pkg.scripts ?? {}).slice(0, 40);
  } catch {
    return [];
  }
}
