import { useEffect, useRef, useState } from 'react';

export interface ConversationTab {
  id: string;
  title: string;
  // 'conversation' — the plain-English plan/approve/run flow (legacy).
  // 'terminal' — a real interactive PTY the user types into directly,
  // able to host interactive CLIs (Claude Code, vim, REPLs).
  // 'sql' — a SQL console connected to a database.
  kind: 'conversation' | 'terminal' | 'sql';
}

interface TabBarProps {
  tabs: ConversationTab[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  // Opens a new terminal tab.
  onNew: () => void;
  // Opens a new SQL console tab.
  onNewSql: () => void;
}

// The tab strip. A rounded gray segmented-control holds all open tabs; the
// active one is white so it reads as belonging to the surface below. The
// new-tab button sits outside the control and opens a small card of the
// surfaces you can spawn — a terminal today, more (SQL, …) as they land.
export function TabBar({ tabs, activeId, onSelect, onClose, onNew, onNewSql }: TabBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Close the new-tab card on an outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  return (
    <div className="flex shrink-0 items-center gap-2">
      {/* Segmented-control container — gray pill holding all tabs. Scrolls
          horizontally on its own so the new-tab button stays put. */}
      <div className="flex items-center gap-1 overflow-x-auto rounded-xl bg-surface-subtle p-1">
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          return (
            <div
              key={tab.id}
              className={`group flex shrink-0 items-center gap-1 rounded-lg px-1 transition-colors ${
                active
                  ? 'bg-card shadow-[0_1px_2px_rgba(0,0,0,0.06)]'
                  : 'hover:bg-card/60'
              }`}
            >
              <button
                type="button"
                onClick={() => onSelect(tab.id)}
                className={`flex max-w-[180px] items-center gap-1.5 truncate py-1 pl-2 text-[12.5px] focus:outline-none ${
                  active
                    ? 'font-medium text-ink'
                    : 'text-ink-label group-hover:text-ink'
                }`}
              >
                {tab.kind === 'sql' ? (
                  <SqlGlyph />
                ) : tab.kind === 'terminal' ? (
                  <TerminalGlyph />
                ) : null}
                <span className="truncate">{tab.title}</span>
              </button>
              <button
                type="button"
                onClick={() => onClose(tab.id)}
                aria-label="Close conversation"
                className={`flex h-4 w-4 items-center justify-center rounded text-ink-micro transition-opacity hover:text-ink focus:outline-none ${
                  active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                }`}
              >
                <CloseGlyph />
              </button>
            </div>
          );
        })}
      </div>

      {/* New-tab affordance — opens a small card of surfaces to spawn. */}
      <div className="relative" ref={menuRef}>
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="New tab"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl text-ink-label transition-colors hover:bg-surface-subtle hover:text-ink focus:outline-none"
        >
          <PlusGlyph />
        </button>

        {menuOpen && (
          <div
            role="menu"
            className="absolute left-0 top-full z-30 mt-1.5 w-60 overflow-hidden rounded-xl border border-hairline bg-card p-1 shadow-xl"
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onNew();
                setMenuOpen(false);
              }}
              className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-surface-subtle focus:outline-none"
            >
              <span className="mt-0.5 text-ink-label">
                <TerminalGlyph />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium text-ink">Terminal</span>
                <span className="block text-[11px] leading-snug text-ink-hint">
                  A real shell — approve, decline, rewind
                </span>
              </span>
            </button>

            {/* SQL console — same safe approve/decline engine, for databases. */}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onNewSql();
                setMenuOpen(false);
              }}
              className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-surface-subtle focus:outline-none"
            >
              <span className="mt-0.5 text-ink-label">
                <SqlGlyph />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium text-ink">SQL console</span>
                <span className="block text-[11px] leading-snug text-ink-hint">
                  Run SQL on a Postgres database
                </span>
              </span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function TerminalGlyph() {
  return (
    <svg
      viewBox="0 0 14 14"
      className="h-3.5 w-3.5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="1" y="2.5" width="12" height="9" rx="1.5" />
      <path d="M3.5 5.5L6 7l-2.5 1.5" />
      <line x1="7.5" y1="8.5" x2="10" y2="8.5" />
    </svg>
  );
}

function SqlGlyph() {
  return (
    <svg
      viewBox="0 0 14 14"
      className="h-3.5 w-3.5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <ellipse cx="7" cy="3.2" rx="4.5" ry="1.8" />
      <path d="M2.5 3.2v7.6c0 1 2 1.8 4.5 1.8s4.5-.8 4.5-1.8V3.2" />
      <path d="M2.5 7c0 1 2 1.8 4.5 1.8s4.5-.8 4.5-1.8" />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg
      viewBox="0 0 10 10"
      className="h-2.5 w-2.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <line x1="1.5" y1="1.5" x2="8.5" y2="8.5" />
      <line x1="8.5" y1="1.5" x2="1.5" y2="8.5" />
    </svg>
  );
}

function PlusGlyph() {
  return (
    <svg
      viewBox="0 0 12 12"
      className="h-3 w-3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <line x1="6" y1="1.5" x2="6" y2="10.5" />
      <line x1="1.5" y1="6" x2="10.5" y2="6" />
    </svg>
  );
}
