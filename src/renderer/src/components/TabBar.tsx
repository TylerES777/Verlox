export interface ConversationTab {
  id: string;
  title: string;
}

interface TabBarProps {
  tabs: ConversationTab[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}

// The conversation tab strip. Sits in the gray canvas above the white
// card; the active tab is white so it reads as continuous with the card
// below. Each tab is an independent conversation (own history, own
// folder). Closing the last tab clears it rather than leaving an empty
// app — ConversationsShell handles that.
export function TabBar({ tabs, activeId, onSelect, onClose, onNew }: TabBarProps) {
  return (
    <div className="flex shrink-0 items-center gap-1 overflow-x-auto pb-3">
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        return (
          <div
            key={tab.id}
            className={`group flex shrink-0 items-center gap-1 rounded-xl px-1 transition-colors ${
              active
                ? 'bg-card shadow-[0_1px_2px_rgba(0,0,0,0.04)]'
                : 'hover:bg-surface-subtle'
            }`}
          >
            <button
              type="button"
              onClick={() => onSelect(tab.id)}
              className={`max-w-[180px] truncate py-1.5 pl-2 text-[12.5px] focus:outline-none ${
                active ? 'text-ink' : 'text-ink-label group-hover:text-ink'
              }`}
            >
              {tab.title}
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
      <button
        type="button"
        onClick={onNew}
        aria-label="New conversation"
        title="New conversation"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl text-ink-label transition-colors hover:bg-surface-subtle hover:text-ink focus:outline-none"
      >
        <PlusGlyph />
      </button>
    </div>
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
