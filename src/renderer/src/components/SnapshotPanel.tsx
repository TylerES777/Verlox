import { useCallback, useEffect, useState } from 'react';
import type { SnapshotChange, SnapshotRecord, SnapshotStatus } from '@shared/types';

interface SnapshotPanelProps {
  // Close the panel (the shield toggle in TerminalView owns the open state).
  onClose: () => void;
}

// Turn an epoch-ms timestamp into a calm relative label ("just now",
// "4 min ago", "2 hr ago"), falling back to a date for older points.
function relativeTime(ts: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 10) return 'just now';
  if (secs < 60) return `${secs} sec ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return new Date(ts).toLocaleString();
}

// Shorten a long absolute path for display, keeping the meaningful tail
// (the folder you actually recognize) rather than the drive root.
function shortPath(p: string): string {
  if (p.length <= 42) return p;
  return `…${p.slice(-41)}`;
}

// Just the file name (last path segment) for the per-point change list —
// the full relative path is kept in a tooltip.
function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

// Per-change-kind glyph + color. Removed files get the warm accent so the
// moment a file vanished stands out in the timeline.
const CHANGE_STYLE: Record<
  SnapshotChange['kind'],
  { glyph: string; className: string; verb: string }
> = {
  added: { glyph: '+', className: 'text-[#3E7A53]', verb: 'added' },
  removed: { glyph: '−', className: 'text-[#B4632F]', verb: 'removed' },
  modified: { glyph: '~', className: 'text-[#6A6A6A]', verb: 'changed' },
  other: { glyph: '·', className: 'text-[#6A6A6A]', verb: 'changed' },
};

// The recovery half of Verlox, made visible: a timeline of restore points
// for the protected folder. Phase 1 is manual — choose a folder, checkpoint
// on demand, and rewind the whole folder to any earlier point. The heavy
// lifting lives in main/snapshot-manager.ts (a hidden per-folder git vault);
// this panel just drives it.
export function SnapshotPanel({ onClose }: SnapshotPanelProps) {
  const [status, setStatus] = useState<SnapshotStatus | null>(null);
  const [snaps, setSnaps] = useState<SnapshotRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // Which point is awaiting a "yes, rewind" confirmation (rewind overwrites
  // current files, so we never do it on a single click).
  const [confirmId, setConfirmId] = useState<string | null>(null);
  // Points whose full changed-files list is expanded (collapsed shows the
  // first few). A set so several points can be open at once.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    const s = await window.api.snapshotStatus();
    setStatus(s);
    if (s.guardedFolder && s.gitAvailable) {
      setSnaps(await window.api.snapshotList());
    } else {
      setSnaps([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // While the panel is open on a protected folder, poll so automatic
  // snapshots (file-watcher / before-command) show up live without the
  // user reopening the panel.
  useEffect(() => {
    if (!status?.guardedFolder || !status.gitAvailable) return;
    const t = setInterval(() => {
      void refresh();
    }, 4000);
    return () => clearInterval(t);
  }, [status?.guardedFolder, status?.gitAvailable, refresh]);

  const chooseFolder = useCallback(async () => {
    const folder = await window.api.snapshotPickFolder();
    if (!folder) return;
    setBusy(true);
    setMessage(null);
    const res = await window.api.snapshotSetFolder(folder);
    setMessage(res.ok ? 'Now protecting this folder.' : res.error ?? 'Could not protect that folder.');
    await refresh();
    setBusy(false);
  }, [refresh]);

  const doCheckpoint = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    const res = await window.api.snapshotCheckpoint();
    setMessage(
      res.ok
        ? res.created
          ? 'Saved a restore point.'
          : 'Nothing changed since the last point.'
        : res.error ?? 'Could not save a restore point.',
    );
    await refresh();
    setBusy(false);
  }, [refresh]);

  const doRestore = useCallback(
    async (id: string) => {
      setBusy(true);
      setMessage(null);
      setConfirmId(null);
      const res = await window.api.snapshotRestore(id);
      setMessage(res.ok ? 'Rewound the folder to that point.' : res.error ?? 'Could not rewind.');
      await refresh();
      setBusy(false);
    },
    [refresh],
  );

  // Flip automatic saving on or off. When on, Verlox quietly saves a point
  // after you edit files and just before a command runs; when off, points
  // are only made when you press "Checkpoint now".
  const toggleAuto = useCallback(async () => {
    if (!status) return;
    setBusy(true);
    const s = await window.api.snapshotSetAuto(!status.autoEnabled);
    setStatus(s);
    setBusy(false);
  }, [status]);

  const gitMissing = status !== null && !status.gitAvailable;
  const hasFolder = !!status?.guardedFolder;

  return (
    <div className="absolute right-2 top-12 z-20 flex max-h-[calc(100%-3.5rem)] w-80 flex-col overflow-hidden rounded-xl border border-black/10 bg-white shadow-xl">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-black/10 px-3 py-2">
        <div className="text-sm font-medium text-[#3A3A3A]">Restore points</div>
        <button
          onClick={onClose}
          className="rounded px-1.5 py-0.5 text-xs text-[#8A8A8A] hover:bg-black/5 hover:text-[#3A3A3A]"
          aria-label="Close restore points"
        >
          ✕
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {gitMissing ? (
          <div className="px-3 py-4 text-xs leading-relaxed text-[#6A6A6A]">
            Restore points need Git installed on this computer. Install Git, then
            reopen this panel.
          </div>
        ) : !hasFolder ? (
          <div className="px-3 py-4 text-xs leading-relaxed text-[#6A6A6A]">
            <p className="mb-3">
              Pick a project folder for Verlox to protect. It quietly keeps a
              history of that folder so you can rewind if a command deletes or
              breaks something.
            </p>
            <button
              onClick={chooseFolder}
              disabled={busy}
              className="rounded-lg bg-[#3A3A3A] px-3 py-1.5 text-xs font-medium text-white hover:bg-black disabled:opacity-50"
            >
              Choose a folder to protect
            </button>
          </div>
        ) : (
          <>
            {/* Protected folder + actions */}
            <div className="border-b border-black/5 px-3 py-2">
              <div className="text-[11px] uppercase tracking-wide text-[#9A9A9A]">
                Protecting
              </div>
              <div
                className="truncate text-xs text-[#3A3A3A]"
                title={status?.guardedFolder ?? ''}
              >
                {shortPath(status?.guardedFolder ?? '')}
              </div>
              <div className="mt-2 flex gap-2">
                <button
                  onClick={doCheckpoint}
                  disabled={busy}
                  className="rounded-lg bg-[#3A3A3A] px-2.5 py-1 text-xs font-medium text-white hover:bg-black disabled:opacity-50"
                >
                  Checkpoint now
                </button>
                <button
                  onClick={chooseFolder}
                  disabled={busy}
                  className="rounded-lg border border-black/10 px-2.5 py-1 text-xs text-[#6A6A6A] hover:bg-black/5 disabled:opacity-50"
                >
                  Change folder
                </button>
              </div>

              {/* Automatic saving toggle */}
              <button
                onClick={toggleAuto}
                disabled={busy}
                className="mt-2 flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left hover:bg-black/5 disabled:opacity-50"
                title={
                  status?.autoEnabled
                    ? 'Verlox is saving points automatically as you work'
                    : 'Turn on to save points automatically as you work'
                }
              >
                <div className="min-w-0">
                  <div className="text-xs text-[#3A3A3A]">Save automatically</div>
                  <div className="text-[11px] text-[#9A9A9A]">
                    {status?.autoEnabled
                      ? 'Saving as you edit and before commands'
                      : 'Only when you press Checkpoint'}
                  </div>
                </div>
                {/* Simple pill switch */}
                <span
                  className={`relative ml-2 inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${
                    status?.autoEnabled ? 'bg-[#3A3A3A]' : 'bg-black/15'
                  }`}
                  aria-hidden
                >
                  <span
                    className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                      status?.autoEnabled ? 'translate-x-3.5' : 'translate-x-0.5'
                    }`}
                  />
                </span>
              </button>
            </div>

            {/* Timeline */}
            <div className="min-h-0 flex-1 overflow-y-auto">
              {snaps.length > 0 && (
                <div className="border-b border-black/5 px-3 py-2 text-[11px] leading-relaxed text-[#9A9A9A]">
                  Rewinding makes the folder look exactly like it did at that
                  point. To bring back a deleted file, pick a point from before
                  it was removed.
                </div>
              )}
              {snaps.length === 0 ? (
                <div className="px-3 py-4 text-xs text-[#9A9A9A]">
                  No restore points yet.
                </div>
              ) : (
                <ul className="divide-y divide-black/5">
                  {snaps.map((s, i) => {
                    const removed = s.changes.filter((c) => c.kind === 'removed');
                    const totalFiles = s.filesChanged ?? s.changes.length;
                    const expanded = expandedIds.has(s.id);
                    const visibleChanges = expanded ? s.changes : s.changes.slice(0, 5);
                    // Files the engine didn't include (it caps the per-point
                    // list); only possible on very large points.
                    const notListed = Math.max(0, totalFiles - s.changes.length);
                    return (
                    <li key={s.id} className="px-3 py-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-xs text-[#3A3A3A]" title={s.label}>
                            {i === 0 ? '● ' : ''}
                            {s.label}
                          </div>
                          <div className="text-[11px] text-[#9A9A9A]">
                            {relativeTime(s.timestamp)}
                            {s.filesChanged != null
                              ? ` · ${s.filesChanged} file${s.filesChanged === 1 ? '' : 's'} changed`
                              : ''}
                          </div>
                          {removed.length > 0 && (
                            <div className="mt-0.5 text-[11px] font-medium text-[#B4632F]">
                              {removed.length === 1
                                ? `Removed ${baseName(removed[0].path)}`
                                : `Removed ${removed.length} files`}
                            </div>
                          )}
                          {s.changes.length > 0 && (
                            <ul className="mt-1 space-y-0.5">
                              {visibleChanges.map((c) => {
                                const st = CHANGE_STYLE[c.kind];
                                return (
                                  <li
                                    key={c.kind + c.path}
                                    className="flex items-center gap-1 text-[11px] text-[#7A7A7A]"
                                    title={`${c.path} (${st.verb})`}
                                  >
                                    <span className={`${st.className} w-2 shrink-0 text-center font-semibold`}>
                                      {st.glyph}
                                    </span>
                                    <span className="truncate">{baseName(c.path)}</span>
                                  </li>
                                );
                              })}
                              {expanded && notListed > 0 && (
                                <li className="text-[11px] text-[#9A9A9A]">
                                  and {notListed} more not listed
                                </li>
                              )}
                              {totalFiles > 5 && (
                                <li>
                                  <button
                                    onClick={() => toggleExpand(s.id)}
                                    className="text-[11px] text-[#8A8A8A] underline-offset-2 hover:text-[#3A3A3A] hover:underline"
                                  >
                                    {expanded ? 'Show less' : `Show all ${totalFiles} files`}
                                  </button>
                                </li>
                              )}
                            </ul>
                          )}
                        </div>
                        {confirmId === s.id ? (
                          <div className="flex shrink-0 gap-1">
                            <button
                              onClick={() => doRestore(s.id)}
                              disabled={busy}
                              className="rounded bg-[#B4632F] px-2 py-0.5 text-[11px] font-medium text-white hover:bg-[#9c5128] disabled:opacity-50"
                            >
                              Rewind
                            </button>
                            <button
                              onClick={() => setConfirmId(null)}
                              disabled={busy}
                              className="rounded px-1.5 py-0.5 text-[11px] text-[#8A8A8A] hover:bg-black/5"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setConfirmId(s.id)}
                            disabled={busy}
                            className="shrink-0 rounded border border-black/10 px-2 py-0.5 text-[11px] text-[#6A6A6A] hover:bg-black/5 disabled:opacity-40"
                            title={
                              i === 0
                                ? 'Rewind to this point (discards changes made since)'
                                : 'Rewind the folder to this point'
                            }
                          >
                            Restore
                          </button>
                        )}
                      </div>
                    </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </>
        )}

        {message && (
          <div className="border-t border-black/10 px-3 py-2 text-[11px] text-[#6A6A6A]">
            {message}
          </div>
        )}
      </div>
    </div>
  );
}
