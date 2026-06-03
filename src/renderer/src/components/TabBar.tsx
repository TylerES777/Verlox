import { Tooltip } from './Tooltip';

export interface ConversationTab {
  id: string;
  title: string;
  // 'conversation' — the plain-English plan/approve/run flow (default).
  // 'terminal' — a real interactive PTY the user types into directly,
  // able to host interactive CLIs (Claude Code, vim, REPLs).
  kind: 'conversation' | 'terminal';
}

interface TabBarProps {
  tabs: ConversationTab[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  // Opens a new terminal tab (the only tab kind now).
  onNew: () => void;
}

// The conversation tab strip. A rounded gray segmented-control holds
// all open tabs; the active one is white so it reads as belonging to
// the white app surface below the strip. The new-tab button sits
// outside the segmented control, like the new-tab affordance in
// Chrome. Each tab is an independent conversation (own history, own
// folder). Closing the last tab clears it rather than leaving an
// empty app — ConversationsShell handles that.
export function TabBar({
  tabs,
  activeId,
  onSelect,
  onClose,
  onNew,
}: TabBarProps) {
  return (
    <div className="flex shrink-0 items-center gap-2 overflow-x-auto">
      {/* Segmented-control container — gray pill holding all tabs. */}
      <div className="flex items-center gap-1 rounded-xl bg-surface-subtle p-1">
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
                {tab.kind === 'terminal' && <TerminalGlyph />}
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
      {/* New-tab affordance — opens another terminal. */}
      <Tooltip label="New terminal">
        <button
          type="button"
          onClick={onNew}
          aria-label="New terminal"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl text-ink-label transition-colors hover:bg-surface-subtle hover:text-ink focus:outline-none"
        >
          <PlusGlyph />
        </button>
      </Tooltip>
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
