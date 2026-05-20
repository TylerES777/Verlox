import { useMemo } from 'react';
import {
  usePromptHistory,
  type PromptHistoryEntry,
} from '../hooks/usePromptHistory';

interface TimelineProps {
  // Click handler — the caller pastes the prompt into the active
  // conversation's input.
  onSelect: (text: string) => void;
}

// Persistent ambient history. Always-visible record of the prompts
// the user has sent, grouped by day. Calmer than asking "show me my
// history" every time, and uses the empty left margin that was
// otherwise dead pixels.
//
// Layout — a thin connecting line runs down the left rail with each
// day's header and prompts hanging off it as dots. Today's heading
// is bold ink; previous days are quieter; clicking a prompt pastes
// it back into the input (the caller wires that).
export function Timeline({ onSelect }: TimelineProps) {
  const entries = usePromptHistory();
  const groups = useMemo(() => groupByDay(entries), [entries]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center px-5 pb-3 pt-5">
        <h2 className="text-[14px] font-semibold text-ink">Timeline</h2>
      </div>
      {entries.length === 0 ? (
        <p className="px-5 py-2 text-[12.5px] leading-relaxed text-ink-label">
          Your prompts will appear here as you go.
        </p>
      ) : (
        <div className="relative min-h-0 flex-1 overflow-y-auto px-5 pb-6">
          {/* The connecting vertical line — runs from the first dot to
              the last. Positioned 1px before the dot's center so the
              dots sit cleanly on top. */}
          <div
            className="pointer-events-none absolute bottom-6 left-[24px] top-7 w-px bg-hairline"
            aria-hidden="true"
          />
          {groups.map((group, gi) => (
            <TimelineGroup
              key={group.heading}
              group={group}
              onSelect={onSelect}
              isFirst={gi === 0}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface TimelineGroupData {
  heading: string;
  // When true, this group is "today" — its heading and entries get
  // a small visual lift (ink color vs ink-label).
  isToday: boolean;
  entries: PromptHistoryEntry[];
}

function TimelineGroup({
  group,
  onSelect,
  isFirst,
}: {
  group: TimelineGroupData;
  onSelect: (text: string) => void;
  isFirst: boolean;
}) {
  return (
    <div className={isFirst ? '' : 'mt-4'}>
      <div className="relative flex items-center pl-7">
        {/* Group-heading dot — slightly larger than entry dots. */}
        <span
          className={`absolute left-[20px] h-2 w-2 -translate-x-1/2 rounded-full ${
            group.isToday ? 'bg-ink-label' : 'bg-ink-hint'
          }`}
          aria-hidden="true"
        />
        <h3
          className={`text-[13px] font-semibold ${
            group.isToday ? 'text-ink' : 'text-ink-label'
          }`}
        >
          {group.heading}
        </h3>
      </div>
      <ul className="mt-1">
        {group.entries.map((entry, i) => (
          <TimelineEntry
            key={`${entry.timestamp}-${i}`}
            entry={entry}
            onSelect={onSelect}
            faded={!group.isToday}
          />
        ))}
      </ul>
    </div>
  );
}

function TimelineEntry({
  entry,
  onSelect,
  faded,
}: {
  entry: PromptHistoryEntry;
  onSelect: (text: string) => void;
  faded: boolean;
}) {
  return (
    <li className="relative">
      {/* Entry dot. Smaller than the heading dot, sits on the rail. */}
      <span
        className={`absolute left-[20px] top-[10px] h-1.5 w-1.5 -translate-x-1/2 rounded-full ${
          faded ? 'bg-ink-micro' : 'bg-ink-hint'
        }`}
        aria-hidden="true"
      />
      <button
        type="button"
        onClick={() => onSelect(entry.text)}
        title={entry.text}
        className={`w-full rounded-md py-1 pl-7 pr-2 text-left text-[12.5px] leading-snug transition-colors hover:bg-surface-subtle focus:outline-none ${
          faded ? 'text-ink-label hover:text-ink' : 'text-ink-body hover:text-ink'
        }`}
      >
        <span className="line-clamp-2 break-words">{entry.text}</span>
      </button>
    </li>
  );
}

// Group entries into Today / Yesterday / "MMM D" / "MMM D, YYYY"
// buckets. Today always sits first; older buckets follow in
// reverse-chronological order.
function groupByDay(entries: PromptHistoryEntry[]): TimelineGroupData[] {
  if (entries.length === 0) return [];
  const today = startOfDay(new Date());
  const yesterday = startOfDay(new Date(today.getTime() - 86400000));
  const thisYear = today.getFullYear();

  const map = new Map<string, TimelineGroupData>();
  for (const entry of entries) {
    const d = startOfDay(new Date(entry.timestamp));
    let key: string;
    if (d.getTime() === today.getTime()) key = 'Today';
    else if (d.getTime() === yesterday.getTime()) key = 'Yesterday';
    else if (d.getFullYear() === thisYear) {
      key = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } else {
      key = d.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
    }
    const existing = map.get(key);
    if (existing) {
      existing.entries.push(entry);
    } else {
      map.set(key, {
        heading: key,
        isToday: key === 'Today',
        entries: [entry],
      });
    }
  }
  // Already inserted in entry order (entries is newest-first), so
  // groups are in the right order naturally.
  return Array.from(map.values());
}

function startOfDay(date: Date): Date {
  const out = new Date(date);
  out.setHours(0, 0, 0, 0);
  return out;
}
