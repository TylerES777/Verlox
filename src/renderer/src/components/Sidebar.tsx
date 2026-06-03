import { useCallback, useEffect, useState } from 'react';
import type { SnapshotStatus } from '@shared/types';
import type { ConversationTab } from './TabBar';
import { Tooltip } from './Tooltip';
import { useRunningProcesses } from '../hooks/useRunningProcesses';

interface SidebarProps {
  tabs: ConversationTab[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}

// Left sidebar. Four stacked sections: a search box, the open tabs, the
// Rewind timeline (restore points the app makes on its own — no folder to
// pick), and the live-running processes. The terminal sits as a centered
// board to the right (see ConversationsShell). The new-terminal button lives
// at the top of the board area, not here.
export function Sidebar({ tabs, activeId, onSelect, onClose }: SidebarProps) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const visibleTabs = q
    ? tabs.filter((t) => t.title.toLowerCase().includes(q))
    : tabs;

  return (
    <aside className="flex min-h-0 w-64 shrink-0 flex-col overflow-hidden rounded-xl border border-hairline bg-surface-faint shadow-sm">
      {/* Brand + Undo/Redo */}
      <div className="flex items-center gap-2 px-4 pb-3 pt-4">
        <span className="text-base leading-none text-ink-label" aria-hidden="true">
          ✦
        </span>
        <span className="text-sm font-medium tracking-tight text-ink">Verlox</span>
        <div className="ml-auto">
          <RewindControls />
        </div>
      </div>

      {/* Search */}
      <div className="px-3 pb-3">
        <div className="relative">
          <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-hint">
            <SearchGlyph />
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tabs…"
            className="w-full rounded-lg border border-hairline bg-card py-1.5 pl-7 pr-2 text-[12.5px] text-ink placeholder:text-ink-hint focus:border-ink/20 focus:outline-none"
          />
        </div>
      </div>

      {/* Tabs */}
      <div className="px-2">
        <SectionLabel>Tabs</SectionLabel>
        <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto">
          {visibleTabs.map((tab) => {
            const active = tab.id === activeId;
            return (
              <li key={tab.id}>
                <div
                  onClick={() => onSelect(tab.id)}
                  className={`group flex cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-[12.5px] ${
                    active
                      ? 'bg-card text-ink shadow-[0_1px_2px_rgba(0,0,0,0.05)]'
                      : 'text-ink-label hover:bg-black/[0.04] hover:text-ink'
                  }`}
                >
                  {tab.kind === 'sql' ? <SqlGlyph /> : <TerminalGlyph />}
                  <span className="min-w-0 flex-1 truncate">{tab.title}</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onClose(tab.id);
                    }}
                    aria-label="Close tab"
                    className={`flex h-4 w-4 items-center justify-center rounded text-ink-micro hover:text-ink ${
                      active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                    }`}
                  >
                    <CloseGlyph />
                  </button>
                </div>
              </li>
            );
          })}
          {visibleTabs.length === 0 && (
            <li className="px-2 py-1 text-[11.5px] text-ink-hint">No tabs match.</li>
          )}
        </ul>
      </div>

      <Divider />

      {/* Live running processes. */}
      <RunningSection onSelect={onSelect} />
    </aside>
  );
}

// --- Rewind ----------------------------------------------------------------

function RewindControls() {
  const [status, setStatus] = useState<SnapshotStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await window.api.snapshotStatus());
    } catch {
      // Best-effort; keep the last good state on screen.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll so the buttons reflect points the app makes on its own (file-watch /
  // before a command) without any user action.
  useEffect(() => {
    const t = setInterval(() => void refresh(), 4000);
    return () => clearInterval(t);
  }, [refresh]);

  const step = useCallback(async (dir: 'undo' | 'redo') => {
    setBusy(true);
    try {
      setStatus(
        dir === 'undo'
          ? await window.api.snapshotUndo()
          : await window.api.snapshotRedo(),
      );
    } finally {
      setBusy(false);
    }
  }, []);

  const canUndo = !!status?.canUndo;
  const canRedo = !!status?.canRedo;
  const btn =
    'flex h-7 w-7 items-center justify-center rounded-lg text-ink-label transition-colors hover:bg-black/[0.05] hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-ink-label';

  // App-level Undo / Redo, shown at the top of the sidebar. Hover shows the
  // change each direction would affect.
  return (
    <div className="flex items-center gap-0.5">
      <Tooltip
        label={canUndo ? `Undo · ${status?.undoSummary ?? 'last change'}` : 'Nothing to undo'}
      >
        <button
          type="button"
          aria-label="Undo"
          onClick={() => void step('undo')}
          disabled={busy || !canUndo}
          className={btn}
        >
          <UndoGlyph />
        </button>
      </Tooltip>
      <Tooltip
        label={canRedo ? `Redo · ${status?.redoSummary ?? 'next change'}` : 'Nothing to redo'}
      >
        <button
          type="button"
          aria-label="Redo"
          onClick={() => void step('redo')}
          disabled={busy || !canRedo}
          className={btn}
        >
          <RedoGlyph />
        </button>
      </Tooltip>
    </div>
  );
}

// --- Running ---------------------------------------------------------------

function RunningSection({ onSelect }: { onSelect: (id: string) => void }) {
  const procs = useRunningProcesses();
  const live = procs.filter((p) => p.status === 'running');

  return (
    <div className="shrink-0 px-2 pb-3 pt-1">
      <div className="flex items-center gap-1.5 px-2">
        <SectionLabel>Running</SectionLabel>
        {live.length > 0 && (
          <span className="rounded-full bg-[#EAF3ED] px-1.5 text-[10px] font-medium text-[#3E7A53]">
            {live.length}
          </span>
        )}
      </div>

      {live.length === 0 ? (
        <p className="px-2 py-2 text-[11.5px] text-ink-hint">Nothing running.</p>
      ) : (
        <ul className="mt-1 max-h-44 space-y-0.5 overflow-y-auto">
          {live.map((p) => (
            <li key={p.stepId}>
              <div className="flex items-center gap-1.5 rounded-md px-2 py-1.5 hover:bg-black/[0.04]">
                <button
                  type="button"
                  onClick={() =>
                    p.detectedUrl
                      ? window.api.openExternal(p.detectedUrl as string)
                      : onSelect(p.conversationId)
                  }
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  title={p.detectedUrl ? `Open ${p.detectedUrl}` : p.command}
                >
                  <GlobeGlyph />
                  <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink">
                    {p.command}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => window.api.stopCommand(p.stepId)}
                  aria-label="Stop"
                  title="Stop"
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-label transition-colors hover:bg-[#FBF1EA] hover:text-[#B4632F]"
                >
                  <StopGlyph />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --- small shared bits -----------------------------------------------------

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="px-2 text-[10.5px] font-medium uppercase tracking-wider text-ink-micro">
      {children}
    </span>
  );
}

function Divider() {
  return <div className="mx-3 my-2 border-t border-hairline" />;
}

function GlobeGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5 shrink-0 text-[#3E7A53]"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6" />
      <ellipse cx="8" cy="8" rx="2.6" ry="6" />
      <line x1="2" y1="8" x2="14" y2="8" />
    </svg>
  );
}

function StopGlyph() {
  return (
    <svg viewBox="0 0 16 16" className="h-3 w-3 shrink-0" fill="currentColor" aria-hidden="true">
      <rect x="3.5" y="3.5" width="9" height="9" rx="1.6" />
    </svg>
  );
}

// --- glyphs ----------------------------------------------------------------

function SearchGlyph() {
  return (
    <svg viewBox="0 0 14 14" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <circle cx="6" cy="6" r="4" />
      <line x1="9" y1="9" x2="12.5" y2="12.5" />
    </svg>
  );
}

function TerminalGlyph() {
  return (
    <svg viewBox="0 0 14 14" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1" y="2.5" width="12" height="9" rx="1.5" />
      <path d="M3.5 5.5L6 7l-2.5 1.5" />
      <line x1="7.5" y1="8.5" x2="10" y2="8.5" />
    </svg>
  );
}

function UndoGlyph() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 4 3 7l3 3" />
      <path d="M3 7h6.5a3.5 3.5 0 0 1 0 7H6" />
    </svg>
  );
}

function RedoGlyph() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 4l3 3-3 3" />
      <path d="M13 7H6.5a3.5 3.5 0 0 0 0 7H10" />
    </svg>
  );
}

function SqlGlyph() {
  return (
    <svg viewBox="0 0 14 14" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <ellipse cx="7" cy="3.2" rx="4.5" ry="1.8" />
      <path d="M2.5 3.2v7.6c0 1 2 1.8 4.5 1.8s4.5-.8 4.5-1.8V3.2" />
      <path d="M2.5 7c0 1 2 1.8 4.5 1.8s4.5-.8 4.5-1.8" />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg viewBox="0 0 10 10" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <line x1="1.5" y1="1.5" x2="8.5" y2="8.5" />
      <line x1="8.5" y1="1.5" x2="1.5" y2="8.5" />
    </svg>
  );
}
