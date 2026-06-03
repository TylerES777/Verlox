import { app, BrowserWindow, dialog } from 'electron';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type {
  SnapshotActionResult,
  SnapshotChange,
  SnapshotRecord,
  SnapshotStatus,
} from '@shared/types';

// The recovery half of Verlox's safety story (see the design discussion):
// a rewind button for the user's project. We keep a running history of a
// chosen "guarded folder" so that when a command — typed by the user or run
// by an AI agent — deletes or mangles files, they can snap the whole folder
// back to how it was moments earlier.
//
// How it works without polluting the user's project: we drive the same
// engine developers already trust (git), but point its metadata at a HIDDEN
// VAULT under the app's userData dir (the --git-dir) while treating the
// project as the working tree (the --work-tree). Nothing is ever written
// into the project folder itself — no stray .git, no conflict with the
// user's own version control. Snapshots store only what changed between
// them, so a long history stays small.
//
// Phase 1 is MANUAL: the user picks a folder and clicks "checkpoint now" /
// "restore". Phase 2 will trigger checkpoints automatically (file-watch +
// before each command).

let guardedFolder: string | null = null;
let vaultDir: string | null = null;
// Cached after the first probe; null means "not checked yet".
let gitAvailable: boolean | null = null;

// --- Phase 2: automatic snapshots -----------------------------------------
// Two triggers keep the timeline fresh without the user thinking about it:
//   1. A recursive file-watcher on the guarded folder. After changes settle
//      (a short quiet period), it saves an "Auto-saved" point.
//   2. A "Before a command" point taken when the user presses Enter in a
//      terminal — closing the window where you edit a file and immediately
//      run something destructive before the watcher has fired.
// autoEnabled gates both; the user can switch it off from the panel.
let autoEnabled = true;
let watcher: FSWatcher | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
// Set while a restore rewrites the working tree, so the watcher doesn't
// turn the restore's own file changes into a redundant "Auto-saved" point.
let suspendWatch = false;
// Epoch ms of the last auto point we actually created — throttles the
// per-command hook so a burst of Enters can't spam checkpoints.
let lastAutoTs = 0;

// Wait this long after the last file change before saving an auto point, so
// a flurry of edits (an agent rewriting ten files) becomes one snapshot.
const AUTO_DEBOUNCE_MS = 2000;
// Minimum gap between command-triggered checkpoints.
const CMD_THROTTLE_MS = 5000;

// Directory names whose contents are regenerable or irrelevant; the watcher
// ignores changes inside them so builds / installs don't churn snapshots.
// Mirrors the snapshot exclude list.
const EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules',
  '.verlox-trash',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.parcel-cache',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  'bin',
  'obj',
]);

function isExcludedPath(rel: string): boolean {
  if (!rel) return false;
  return rel.split(/[\\/]/).some((seg) => EXCLUDED_DIRS.has(seg));
}

function stopWatch(): void {
  if (watcher) {
    try {
      watcher.close();
    } catch {
      // Already closed.
    }
    watcher = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

function startWatch(): void {
  stopWatch();
  if (!guardedFolder || !autoEnabled) return;
  try {
    watcher = watch(guardedFolder, { recursive: true }, (_event, filename) => {
      if (suspendWatch) return;
      // filename is null on some platforms/events — treat as "something
      // changed" and let the debounce + clean-tree no-op sort it out.
      if (typeof filename === 'string' && isExcludedPath(filename)) return;
      scheduleAutoCheckpoint();
    });
    watcher.on('error', () => stopWatch());
  } catch {
    // Folder vanished or recursive watch unsupported; auto-watch is a
    // best-effort enhancement, so we simply stay in manual mode.
    watcher = null;
  }
}

function scheduleAutoCheckpoint(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void runAutoCheckpoint('Auto-saved');
  }, AUTO_DEBOUNCE_MS);
}

async function runAutoCheckpoint(label: string): Promise<void> {
  if (!autoEnabled || !guardedFolder) return;
  const res = await checkpoint(label);
  if (res.ok && res.created) lastAutoTs = Date.now();
}

// Called by the PTY manager when a terminal sees Enter, just before the
// keystroke reaches the shell. Fires (without blocking input) a checkpoint
// of the pre-command state, throttled so rapid commands don't pile up.
export function noteCommandRun(): void {
  if (!autoEnabled || !guardedFolder) return;
  if (Date.now() - lastAutoTs < CMD_THROTTLE_MS) return;
  // Claim the slot immediately so a burst of Enters checkpoints once.
  lastAutoTs = Date.now();
  void runAutoCheckpoint('Before a command');
}

// Turn automatic snapshots on or off (the panel's Auto-save toggle).
// Returns the updated status so the UI can reflect it without a round-trip.
export async function setAuto(enabled: boolean): Promise<SnapshotStatus> {
  autoEnabled = enabled;
  if (enabled) startWatch();
  else stopWatch();
  return getStatus();
}

// Run a git command and resolve (never reject) with its exit code + output.
// A missing git binary (ENOENT) surfaces as a non-zero code, which the
// callers treat as "git unavailable".
function runGit(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      // 256 MiB ceiling so `git log` / `add` on a big project can't blow the
      // default 1 MiB stdout buffer and spuriously fail.
      { windowsHide: true, maxBuffer: 256 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as NodeJS.ErrnoException).code === 'number'
            ? ((err as unknown as { code: number }).code)
            : err
              ? 1
              : 0;
        resolve({
          code,
          stdout: stdout?.toString() ?? '',
          stderr: stderr?.toString() ?? '',
        });
      },
    );
  });
}

// Is git on this machine? Probed once and cached. Phase 1 leans on the
// system git; if it's absent we degrade gracefully (the UI explains it)
// rather than crash. A future hardening pass can bundle git or swap in a
// pure-JS implementation so there's zero external dependency.
async function ensureGit(): Promise<boolean> {
  if (gitAvailable !== null) return gitAvailable;
  const res = await runGit(['--version']);
  gitAvailable = res.code === 0 && /git version/i.test(res.stdout);
  return gitAvailable;
}

// Each guarded folder gets its own vault, named by a short stable hash of
// its absolute path. Lower-cased first because Windows paths are
// case-insensitive (C:\Foo and c:\foo are the same folder).
function vaultFor(folder: string): string {
  const key = createHash('sha1')
    .update(folder.toLowerCase())
    .digest('hex')
    .slice(0, 16);
  return join(app.getPath('userData'), 'snapshots', key);
}

// The shared prefix for every git call against the vault: point the repo at
// the vault, the work tree at the project, and pin identity/config so
// commits succeed on a machine with no global git setup. core.autocrlf is
// off so we snapshot bytes verbatim (never rewrite the user's line endings).
function gitBase(): string[] {
  if (!vaultDir || !guardedFolder) {
    throw new Error('No guarded folder set.');
  }
  return [
    '--git-dir',
    vaultDir,
    '--work-tree',
    guardedFolder,
    '-c',
    'user.name=Verlox',
    '-c',
    'user.email=verlox@local',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'core.autocrlf=false',
    '-c',
    'core.safecrlf=false',
    '-c',
    'core.quotepath=false',
  ];
}

// Things we never want in a snapshot: the user's own git history (huge and
// pointless to duplicate), dependency/build output (regenerable, often
// enormous), our own delete-quarantine bin, and OS cruft. Written into the
// vault's info/exclude so it applies only to our snapshots.
const EXCLUDE = `# Verlox snapshot excludes — regenerable or irrelevant paths.
.git/
node_modules/
.verlox-trash/
.DS_Store
Thumbs.db
*.log
dist/
build/
out/
.next/
.nuxt/
.cache/
.turbo/
.parcel-cache/
coverage/
__pycache__/
*.pyc
.venv/
venv/
target/
bin/
obj/
`;

export async function getStatus(): Promise<SnapshotStatus> {
  return { guardedFolder, gitAvailable: await ensureGit(), autoEnabled };
}

// Open a native folder picker so the user can choose what to protect.
// Returns the chosen absolute path, or null if they cancelled.
export async function pickFolder(): Promise<string | null> {
  const parent = BrowserWindow.getFocusedWindow() ?? undefined;
  const result = await (parent
    ? dialog.showOpenDialog(parent, {
        title: 'Choose a folder for Verlox to protect',
        properties: ['openDirectory'],
      })
    : dialog.showOpenDialog({
        title: 'Choose a folder for Verlox to protect',
        properties: ['openDirectory'],
      }));
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
}

// Point the safety net at `folder`: create its vault if new, install the
// excludes, and take a baseline snapshot so there's always something to
// restore to.
export async function setGuardedFolder(
  folder: string,
): Promise<SnapshotActionResult> {
  if (!(await ensureGit())) {
    return {
      ok: false,
      error:
        'Git was not found on this machine. Verlox uses it to keep restore points. Install Git, then try again.',
    };
  }

  const vault = vaultFor(folder);
  try {
    mkdirSync(vault, { recursive: true });
  } catch (e) {
    return { ok: false, error: `Could not create the snapshot vault: ${String(e)}` };
  }

  // Stop watching any previous folder before switching targets.
  stopWatch();
  // Switch the module's active target before issuing git commands.
  guardedFolder = folder;
  vaultDir = vault;

  // Initialize the vault repo (idempotent — re-init on an existing repo is
  // a no-op that just reports "Reinitialized").
  const init = await runGit([...gitBase(), 'init', '-q']);
  if (init.code !== 0) {
    guardedFolder = null;
    vaultDir = null;
    return { ok: false, error: init.stderr || 'Could not initialize the snapshot vault.' };
  }

  // (Re)write the exclude list. The vault IS the git-dir, so info/exclude
  // lives directly under it.
  try {
    mkdirSync(join(vault, 'info'), { recursive: true });
    writeFileSync(join(vault, 'info', 'exclude'), EXCLUDE, 'utf8');
  } catch {
    // Non-fatal: snapshots still work, they just include more than ideal.
  }

  // Baseline snapshot. allowEmpty so even an empty folder gets a root
  // commit, guaranteeing the timeline always has at least one entry.
  await checkpoint('Started protecting this folder', { allowEmpty: true });
  lastAutoTs = Date.now();

  // Begin watching for changes (no-op if the user has auto-save off).
  startWatch();
  return { ok: true };
}

// Save a restore point. `created` is false (with ok:true) when nothing has
// changed since the last one — a no-op the UI can report calmly rather than
// as an error.
export async function checkpoint(
  label?: string,
  opts: { allowEmpty?: boolean } = {},
): Promise<SnapshotActionResult> {
  if (!guardedFolder || !vaultDir) {
    return { ok: false, error: 'Pick a folder to protect first.' };
  }
  const add = await runGit([...gitBase(), 'add', '-A']);
  if (add.code !== 0) {
    return { ok: false, error: add.stderr || 'Could not stage files for the snapshot.' };
  }
  const args = [...gitBase(), 'commit', '--no-verify', '-m', label?.trim() || 'Checkpoint'];
  if (opts.allowEmpty) args.push('--allow-empty');
  const commit = await runGit(args);
  if (commit.code !== 0) {
    const out = `${commit.stdout}\n${commit.stderr}`;
    if (/nothing to commit|no changes added|working tree clean/i.test(out)) {
      return { ok: true, created: false };
    }
    return { ok: false, error: commit.stderr || commit.stdout || 'Could not create the snapshot.' };
  }
  return { ok: true, created: true };
}

// How many changed files we keep per point. A point that touches hundreds
// of files (e.g. a big install slipped past the excludes) would bloat the
// payload and the UI; we cap and let the count convey the rest.
const MAX_CHANGES_PER_POINT = 25;

// Map a git name-status code to our plain-language change kind. Renames and
// copies arrive as "R100"/"C75"; we lump those under 'other'.
function changeKindFor(code: string): SnapshotChange['kind'] {
  const c = code[0]?.toUpperCase();
  if (c === 'A') return 'added';
  if (c === 'D') return 'removed';
  if (c === 'M') return 'modified';
  return 'other';
}

// The timeline: every restore point, newest first. Parsed from `git log`
// with a record/field separator scheme so labels containing spaces or
// punctuation survive intact. --name-status gives us the exact files that
// changed at each point (with add/modify/delete markers) so the UI can show
// "what changed here" — crucially, which files were removed.
export async function listSnapshots(): Promise<SnapshotRecord[]> {
  if (!guardedFolder || !vaultDir) return [];
  const REC = '\x1e'; // between commits
  const SEP = '\x1f'; // between fields
  const fmt = `${REC}%H${SEP}%ct${SEP}%s`;
  const res = await runGit([
    ...gitBase(),
    'log',
    '-n',
    '200',
    `--pretty=format:${fmt}`,
    '--name-status',
    '--no-color',
  ]);
  if (res.code !== 0) return [];

  const records: SnapshotRecord[] = [];
  for (const chunk of res.stdout.split(REC)) {
    if (!chunk.trim()) continue;
    const lines = chunk.split('\n');
    const head = lines[0];
    const parts = head.split(SEP);
    if (parts.length < 3) continue;
    const id = parts[0];
    const ct = Number(parts[1]);
    const label = parts.slice(2).join(SEP);

    // Each remaining non-empty line is "STATUS\tpath" (rename/copy lines
    // carry two tab-separated paths; we take the destination — the last).
    const changes: SnapshotChange[] = [];
    let total = 0;
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const cols = line.split('\t');
      if (cols.length < 2) continue;
      total++;
      if (changes.length < MAX_CHANGES_PER_POINT) {
        changes.push({
          path: cols[cols.length - 1],
          kind: changeKindFor(cols[0]),
        });
      }
    }

    records.push({
      id,
      label,
      timestamp: Number.isFinite(ct) ? ct * 1000 : Date.now(),
      filesChanged: total > 0 ? total : null,
      isRestore: /^restored\b|^rewound\b/i.test(label),
      changes,
    });
  }
  return records;
}

// Roll the guarded folder back to snapshot `id`. Three steps, in order:
//   1. Checkpoint the CURRENT state first, so the rewind itself is undoable
//      (you can never paint yourself into a corner).
//   2. read-tree --reset -u: make the working tree exactly match `id`,
//      including removing files that were added after it and bringing back
//      files that were deleted (verified semantics).
//   3. Commit the restored state as a NEW point on top, so HEAD never moves
//      backward and the full history stays intact and re-restorable.
export async function restore(id: string): Promise<SnapshotActionResult> {
  if (!guardedFolder || !vaultDir) {
    return { ok: false, error: 'Pick a folder to protect first.' };
  }
  if (!/^[0-9a-f]{7,40}$/i.test(id)) {
    return { ok: false, error: 'That restore point id looks invalid.' };
  }

  // Mute the watcher: the read-tree below rewrites files in the working
  // tree, and we don't want those changes to fire a redundant auto point.
  suspendWatch = true;
  try {
    // 1. Safety net for the rewind itself.
    await checkpoint('Before rewinding to an earlier point', { allowEmpty: true });

    // 2. Make the working tree match the chosen point.
    const readTree = await runGit([...gitBase(), 'read-tree', '--reset', '-u', id]);
    if (readTree.code !== 0) {
      return { ok: false, error: readTree.stderr || 'Could not read that restore point.' };
    }

    // 3. Record the restored state as a fresh point on top of history.
    await runGit([...gitBase(), 'add', '-A']);
    const commit = await runGit([
      ...gitBase(),
      'commit',
      '--no-verify',
      '--allow-empty',
      '-m',
      `Rewound to ${id.slice(0, 8)}`,
    ]);
    if (commit.code !== 0) {
      return { ok: false, error: commit.stderr || 'Restored the files, but could not record the rewind point.' };
    }
    lastAutoTs = Date.now();
    return { ok: true, created: true };
  } finally {
    // Re-arm the watcher shortly after, once the filesystem events from the
    // read-tree have drained, so genuine later edits resume snapshotting.
    setTimeout(() => {
      suspendWatch = false;
    }, 1500);
  }
}
