import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  VaultCaptureInput,
  VaultEntry,
  VaultRestoreResult,
  VaultRetention,
} from '@shared/types';

// Recovery Vault — Verlox's trash-bin for AI deletions.
//
// Just before the agent runs a delete, we COPY the targeted paths in here, so
// the deletion is reversible from inside the app regardless of the OS Recycle
// Bin. Each entry is kept for a retention window (24h / 7 days / forever);
// expired entries are purged on read. Restore copies the item back to where it
// was and removes it from the vault.
//
// Layout under userData:
//   recovery-vault/manifest.json        — the list of entries (minus expiresAt)
//   recovery-vault/<id>/<name>          — the stored copy of each item

type StoredEntry = Omit<VaultEntry, 'expiresAt'>;

const RETENTION_MS: Record<VaultRetention, number | null> = {
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  forever: null,
};

// Don't try to vault enormous trees — past this we let the delete proceed
// without a vault copy (the OS Recycle Bin is still the fallback).
const MAX_CAPTURE_BYTES = 500 * 1024 * 1024; // 500 MB

function vaultRoot(): string {
  return join(app.getPath('userData'), 'recovery-vault');
}
function manifestPath(): string {
  return join(vaultRoot(), 'manifest.json');
}
function entryDir(id: string): string {
  return join(vaultRoot(), id);
}

function expiresAt(e: StoredEntry): number | null {
  const ms = RETENTION_MS[e.retention];
  return ms === null ? null : e.capturedAt + ms;
}
function withExpiry(e: StoredEntry): VaultEntry {
  return { ...e, expiresAt: expiresAt(e) };
}

async function readManifest(): Promise<StoredEntry[]> {
  try {
    const raw = await fs.readFile(manifestPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoredEntry[]) : [];
  } catch {
    return [];
  }
}

async function writeManifest(entries: StoredEntry[]): Promise<void> {
  await fs.mkdir(vaultRoot(), { recursive: true });
  await fs.writeFile(manifestPath(), JSON.stringify(entries, null, 2), 'utf8');
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// Sum the size of a file or directory tree (best-effort).
async function treeSize(p: string): Promise<number> {
  let total = 0;
  const stat = await fs.stat(p);
  if (stat.isDirectory()) {
    const entries = await fs.readdir(p);
    for (const name of entries) {
      total += await treeSize(join(p, name));
    }
  } else {
    total = stat.size;
  }
  return total;
}

// Remove entries whose retention window has passed (and their stored copies).
async function purgeExpired(entries: StoredEntry[]): Promise<StoredEntry[]> {
  const now = Date.now();
  const kept: StoredEntry[] = [];
  for (const e of entries) {
    const exp = expiresAt(e);
    if (exp !== null && exp <= now) {
      await fs.rm(entryDir(e.id), { recursive: true, force: true }).catch(() => {});
    } else {
      kept.push(e);
    }
  }
  return kept;
}

// Copy the about-to-be-deleted paths into the vault. Called right before a
// delete step runs, so the originals still exist. Never throws — a failed
// capture must not block the user's command (the Recycle Bin is the fallback).
export async function captureDeletions(input: VaultCaptureInput): Promise<VaultEntry[]> {
  const retention: VaultRetention = input.retention ?? 'week';
  const entries = await readManifest();
  const created: StoredEntry[] = [];

  for (const raw of input.paths) {
    try {
      const abs = isAbsolute(raw) ? raw : resolve(input.cwd, raw);
      if (!(await exists(abs))) continue;
      const stat = await fs.stat(abs);
      const size = await treeSize(abs).catch(() => 0);
      if (size > MAX_CAPTURE_BYTES) continue; // too big to vault safely

      const id = randomUUID();
      const name = basename(abs) || 'item';
      await fs.mkdir(entryDir(id), { recursive: true });
      await fs.cp(abs, join(entryDir(id), name), { recursive: true });

      created.push({
        id,
        name,
        originalPath: abs,
        kind: stat.isDirectory() ? 'folder' : 'file',
        capturedAt: Date.now(),
        retention,
        sizeBytes: size,
        command: input.command,
      });
    } catch {
      // Skip this path; keep going with the rest.
    }
  }

  if (created.length > 0) {
    await writeManifest([...entries, ...created]);
  }
  return created.map(withExpiry);
}

export async function listVault(): Promise<VaultEntry[]> {
  const kept = await purgeExpired(await readManifest());
  await writeManifest(kept);
  return kept
    .map(withExpiry)
    .sort((a, b) => b.capturedAt - a.capturedAt);
}

export async function restoreVault(id: string): Promise<VaultRestoreResult> {
  const entries = await readManifest();
  const entry = entries.find((e) => e.id === id);
  if (!entry) return { ok: false, error: 'That item is no longer in the vault.' };

  const stored = join(entryDir(id), entry.name);
  if (!(await exists(stored))) {
    return { ok: false, error: 'The stored copy is missing.' };
  }
  if (await exists(entry.originalPath)) {
    return {
      ok: false,
      error: 'Something already exists at the original location — move it first.',
    };
  }
  try {
    await fs.mkdir(dirname(entry.originalPath), { recursive: true });
    await fs.cp(stored, entry.originalPath, { recursive: true });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  // Restored → remove from the vault.
  await fs.rm(entryDir(id), { recursive: true, force: true }).catch(() => {});
  await writeManifest(entries.filter((e) => e.id !== id));
  return { ok: true };
}

export async function forgetVault(id: string): Promise<VaultEntry[]> {
  const entries = await readManifest();
  await fs.rm(entryDir(id), { recursive: true, force: true }).catch(() => {});
  const kept = entries.filter((e) => e.id !== id);
  await writeManifest(kept);
  return kept.map(withExpiry).sort((a, b) => b.capturedAt - a.capturedAt);
}

export async function setVaultRetention(
  id: string,
  retention: VaultRetention,
): Promise<VaultEntry[]> {
  const entries = await readManifest();
  const next = entries.map((e) => (e.id === id ? { ...e, retention } : e));
  const kept = await purgeExpired(next);
  await writeManifest(kept);
  return kept.map(withExpiry).sort((a, b) => b.capturedAt - a.capturedAt);
}
