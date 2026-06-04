import { useCallback, useEffect, useMemo, useState } from 'react';
import type { VaultEntry, VaultRetention } from '@shared/types';
import { useTier } from '../contexts/TierContext';
import { useUpgrade } from '../contexts/UpgradeContext';

// Recovery Vault page — a card opened from the top-bar vault button. Lists
// everything Verlox has deleted (copied here before deletion), with search,
// filters, per-item expiry control, one-click Restore, and a type-to-confirm
// permanent delete. Loads via IPC and refreshes on the 'verlox:vault-changed'
// event that the agent fires after a capture.

const RETENTIONS: { value: VaultRetention; label: string }[] = [
  { value: 'day', label: 'Keep 24 hours' },
  { value: 'week', label: 'Keep 7 days' },
  { value: 'forever', label: 'Keep forever' },
];

type SortKey = 'recent' | 'oldest';
type TypeKey = 'all' | 'file' | 'folder';

function parentOf(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx > 0 ? p.slice(0, idx) : p;
}

function fmtDateTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function fmtExpiry(e: VaultEntry): string {
  if (e.expiresAt === null) return 'Never';
  return new Date(e.expiresAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

function FolderIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4 shrink-0 text-ink-hint"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 7a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4 shrink-0 text-ink-hint"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 3h7l5 5v13a0 0 0 0 1 0 0H6a0 0 0 0 1 0 0V3Z" />
      <path d="M13 3v5h5" />
    </svg>
  );
}

export function VaultView({ onClose }: { onClose: () => void }) {
  const { isPro } = useTier();
  const { openUpgrade } = useUpgrade();
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('recent');
  const [type, setType] = useState<TypeKey>('all');
  const [parent, setParent] = useState('all');
  // Permanent-delete confirmation state.
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setEntries(await window.api.vaultList());
    } catch {
      // Keep the last good list.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onChange = () => void refresh();
    window.addEventListener('verlox:vault-changed', onChange);
    return () => window.removeEventListener('verlox:vault-changed', onChange);
  }, [refresh]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const parents = useMemo(
    () => Array.from(new Set(entries.map((e) => parentOf(e.originalPath)))).sort(),
    [entries],
  );

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries
      .filter((e) => (type === 'all' ? true : e.kind === type))
      .filter((e) => (parent === 'all' ? true : parentOf(e.originalPath) === parent))
      .filter(
        (e) =>
          !q ||
          e.name.toLowerCase().includes(q) ||
          e.originalPath.toLowerCase().includes(q),
      )
      .sort((a, b) =>
        sort === 'recent' ? b.capturedAt - a.capturedAt : a.capturedAt - b.capturedAt,
      );
  }, [entries, query, type, parent, sort]);

  const restore = useCallback(async (id: string) => {
    setError(null);
    const res = await window.api.vaultRestore(id);
    if (res.ok) setEntries((es) => es.filter((e) => e.id !== id));
    else setError(res.error);
  }, []);

  const setRetention = useCallback(async (id: string, r: VaultRetention) => {
    setEntries(await window.api.vaultSetRetention(id, r));
  }, []);

  const confirmDelete = useCallback(
    async (id: string) => {
      setEntries(await window.api.vaultForget(id));
      setConfirmId(null);
      setConfirmText('');
    },
    [],
  );

  const selectClass =
    'rounded-lg border border-hairline bg-surface-subtle px-2 py-1 text-[11px] text-ink-label focus:outline-none';

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/20 p-6 pt-16"
      onMouseDown={onClose}
    >
      <div
        className="flex max-h-full w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-hairline bg-card shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-hairline px-4 py-3">
          <div className="flex items-center gap-2">
            <VaultGlyph />
            <span className="text-sm font-semibold text-ink">Recovery Vault</span>
            <span className="text-[11px] text-ink-hint">
              {entries.length} item{entries.length === 1 ? '' : 's'}
            </span>
          </div>
          <button
            onClick={onClose}
            className="rounded-md px-2 py-0.5 text-sm text-ink-hint hover:bg-black/5 hover:text-ink"
            aria-label="Close vault"
          >
            ✕
          </button>
        </div>

        {/* Toolbar: search + filters */}
        <div className="shrink-0 space-y-2 border-b border-hairline px-4 py-3">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search deleted items…"
            className="w-full rounded-lg border border-hairline bg-surface-subtle px-3 py-1.5 text-xs text-ink placeholder:text-ink-hint focus:outline-none focus:ring-1 focus:ring-black/15"
          />
          <div className="flex flex-wrap items-center gap-2">
            <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className={selectClass}>
              <option value="recent">Most recent</option>
              <option value="oldest">Oldest</option>
            </select>
            <select value={type} onChange={(e) => setType(e.target.value as TypeKey)} className={selectClass}>
              <option value="all">All types</option>
              <option value="folder">Folders</option>
              <option value="file">Files</option>
            </select>
            <select
              value={parent}
              onChange={(e) => setParent(e.target.value)}
              className={`${selectClass} max-w-[200px]`}
              title="Filter by the folder it was deleted from"
            >
              <option value="all">Any location</option>
              {parents.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* List */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {entries.length === 0 ? (
            <div className="py-10 text-center text-sm leading-relaxed text-ink-hint">
              The vault is empty. Anything Verlox deletes is copied here first so
              you can restore it.
            </div>
          ) : shown.length === 0 ? (
            <div className="py-10 text-center text-sm text-ink-hint">
              No items match your search/filters.
            </div>
          ) : (
            <ul className="space-y-2">
              {shown.map((e) => {
                const phrase = `i agree to delete ${e.name}`;
                const confirming = confirmId === e.id;
                const canDelete = confirmText.trim().toLowerCase() === phrase.toLowerCase();
                return (
                  <li
                    key={e.id}
                    className="rounded-xl border border-hairline bg-surface-faint p-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-start gap-2">
                        {e.kind === 'folder' ? <FolderIcon /> : <FileIcon />}
                        <div className="min-w-0">
                          <div className="truncate text-xs font-medium text-ink" title={e.originalPath}>
                            {e.name}
                          </div>
                          <div className="truncate text-[10.5px] text-ink-hint" title={e.originalPath}>
                            {parentOf(e.originalPath)}
                          </div>
                        </div>
                      </div>
                      <div className="flex shrink-0 gap-1.5">
                        <button
                          type="button"
                          onClick={() => void restore(e.id)}
                          className="rounded-lg bg-[#3A3A3A] px-2.5 py-1 text-[11px] font-medium text-white hover:bg-black"
                        >
                          Restore
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setError(null);
                            setConfirmText('');
                            setConfirmId(confirming ? null : e.id);
                          }}
                          className="rounded-lg border border-[#B4322B]/30 px-2.5 py-1 text-[11px] font-medium text-[#B4322B] hover:bg-[#FBEAE8]"
                        >
                          Delete
                        </button>
                      </div>
                    </div>

                    {/* Dates + expiry control */}
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                      <div className="text-[10.5px] text-ink-hint">
                        Deleted {fmtDateTime(e.capturedAt)} · Expires {fmtExpiry(e)}
                      </div>
                      {isPro ? (
                        <select
                          value={e.retention}
                          onChange={(ev) =>
                            void setRetention(e.id, ev.target.value as VaultRetention)
                          }
                          className="rounded border border-hairline bg-surface-subtle px-1.5 py-0.5 text-[10.5px] text-ink-label focus:outline-none"
                        >
                          {RETENTIONS.map((r) => (
                            <option key={r.value} value={r.value}>
                              {r.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <button
                          type="button"
                          onClick={() => openUpgrade({ feature: 'longer recovery' })}
                          title="Free keeps deletes 24h — go Pro to keep them 7 days or forever"
                          className="rounded border border-hairline bg-surface-subtle px-1.5 py-0.5 text-[10.5px] text-ink-hint hover:text-ink"
                        >
                          Keep 24h · Pro to extend
                        </button>
                      )}
                    </div>

                    {/* Type-to-confirm permanent delete */}
                    {confirming && (
                      <div className="mt-2 rounded-lg border border-[#B4322B]/25 bg-[#FDF6F5] p-2">
                        <div className="text-[11px] text-[#B4322B]">
                          This permanently removes it from the vault — it can’t be
                          recovered. Type{' '}
                          <span className="font-mono font-semibold">{phrase}</span> to
                          confirm.
                        </div>
                        <div className="mt-1.5 flex gap-1.5">
                          <input
                            autoFocus
                            value={confirmText}
                            onChange={(ev) => setConfirmText(ev.target.value)}
                            placeholder={phrase}
                            className="min-w-0 flex-1 rounded-md border border-hairline bg-white px-2 py-1 font-mono text-[11px] text-ink focus:outline-none focus:ring-1 focus:ring-[#B4322B]/30"
                          />
                          <button
                            type="button"
                            disabled={!canDelete}
                            onClick={() => void confirmDelete(e.id)}
                            className="shrink-0 rounded-md bg-[#B4322B] px-2.5 py-1 text-[11px] font-medium text-white hover:bg-[#9c2b25] disabled:opacity-40"
                          >
                            Delete forever
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setConfirmId(null);
                              setConfirmText('');
                            }}
                            className="shrink-0 rounded-md px-2 py-1 text-[11px] text-ink-hint hover:bg-black/5 hover:text-ink"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {error && <div className="mt-2 text-[11px] text-[#B4632F]">{error}</div>}
        </div>
      </div>
    </div>
  );
}

// The vault icon — an archive box (lid + body), used in the header and the
// top-bar button.
export function VaultGlyph({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <rect x="3" y="4" width="18" height="4.5" rx="1.2" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M5 8.5V18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M10 12h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
