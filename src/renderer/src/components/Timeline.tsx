import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import {
  usePromptHistory,
  type PromptHistoryEntry,
  type PromptHistoryStatus,
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
// Hovering a row opens a small dropdown-style preview card to the
// right with the commands that ran and a short conclusion — so the
// user gets context (what happened) without re-opening the turn.
// The card renders via a portal to document.body so the sidebar's
// overflow-hidden (needed for the collapse animation) doesn't clip
// it.
export function Timeline({ onSelect }: TimelineProps) {
  const entries = usePromptHistory();
  const groups = useMemo(() => groupByDay(entries), [entries]);

  // Currently hovered entry — set by individual rows when the mouse
  // enters them; cleared on leave (with a tiny grace period so
  // entry-to-entry hover doesn't flicker the card).
  const [hovered, setHovered] = useState<HoverState | null>(null);
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function setHoveredEntry(entry: PromptHistoryEntry, rect: DOMRect) {
    if (leaveTimerRef.current !== null) {
      clearTimeout(leaveTimerRef.current);
      leaveTimerRef.current = null;
    }
    setHovered({ entry, rect });
  }
  function clearHovered() {
    if (leaveTimerRef.current !== null) {
      clearTimeout(leaveTimerRef.current);
    }
    leaveTimerRef.current = setTimeout(() => {
      setHovered(null);
      leaveTimerRef.current = null;
    }, 120);
  }

  useEffect(
    () => () => {
      if (leaveTimerRef.current !== null) clearTimeout(leaveTimerRef.current);
    },
    [],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center px-5 pb-4 pt-5">
        <h2 className="text-[14px] font-semibold text-ink">Timeline</h2>
      </div>
      {entries.length === 0 ? (
        <p className="px-5 py-2 text-[12.5px] leading-relaxed text-ink-label">
          Your prompts will appear here as you go.
        </p>
      ) : (
        <div className="relative min-h-0 flex-1 overflow-y-auto px-5 pb-8">
          {/* The connecting vertical line — runs from near the first
              dot to near the last. Positioned at the dot column. */}
          <div
            className="pointer-events-none absolute bottom-8 left-[24px] top-8 w-px bg-hairline"
            aria-hidden="true"
          />
          {groups.map((group, gi) => (
            <TimelineGroup
              key={group.heading}
              group={group}
              onSelect={onSelect}
              onHoverEntry={setHoveredEntry}
              onLeaveEntry={clearHovered}
              isFirst={gi === 0}
            />
          ))}
        </div>
      )}
      {hovered &&
        createPortal(
          <TimelineHoverCard hovered={hovered} />,
          document.body,
        )}
    </div>
  );
}

interface HoverState {
  entry: PromptHistoryEntry;
  rect: DOMRect;
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
  onHoverEntry,
  onLeaveEntry,
  isFirst,
}: {
  group: TimelineGroupData;
  onSelect: (text: string) => void;
  onHoverEntry: (entry: PromptHistoryEntry, rect: DOMRect) => void;
  onLeaveEntry: () => void;
  isFirst: boolean;
}) {
  return (
    <div className={isFirst ? '' : 'mt-7'}>
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
      <ul className="mt-3 space-y-2">
        {group.entries.map((entry, i) => (
          <TimelineEntry
            key={entry.id || `${entry.timestamp}-${i}`}
            entry={entry}
            onSelect={onSelect}
            onHoverEntry={onHoverEntry}
            onLeaveEntry={onLeaveEntry}
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
  onHoverEntry,
  onLeaveEntry,
  faded,
}: {
  entry: PromptHistoryEntry;
  onSelect: (text: string) => void;
  onHoverEntry: (entry: PromptHistoryEntry, rect: DOMRect) => void;
  onLeaveEntry: () => void;
  faded: boolean;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dotColor = statusDotColor(entry.status, faded);
  function handleEnter() {
    const el = buttonRef.current;
    if (!el) return;
    onHoverEntry(entry, el.getBoundingClientRect());
  }
  return (
    <li className="relative">
      <span
        className={`absolute left-[20px] top-[10px] h-1.5 w-1.5 -translate-x-1/2 rounded-full ${dotColor}`}
        aria-hidden="true"
      />
      <button
        ref={buttonRef}
        type="button"
        onClick={() => onSelect(entry.text)}
        onMouseEnter={handleEnter}
        onMouseLeave={onLeaveEntry}
        onFocus={handleEnter}
        onBlur={onLeaveEntry}
        className={`w-full rounded-md py-1.5 pl-7 pr-2 text-left text-[12.5px] leading-snug transition-colors hover:bg-surface-subtle focus:outline-none ${
          faded ? 'text-ink-label hover:text-ink' : 'text-ink-body hover:text-ink'
        }`}
      >
        <span className="line-clamp-2 break-words">{entry.text}</span>
      </button>
    </li>
  );
}

// Hover card rendered via portal so the sidebar's overflow-hidden
// doesn't clip it. Position is fixed against the hovered entry's
// bounding rect — to the right with a small gap, top-aligned. Falls
// back to a left-side position if it would otherwise spill past the
// right edge of the viewport.
function TimelineHoverCard({ hovered }: { hovered: HoverState }) {
  const { entry, rect } = hovered;
  const hasContent =
    entry.commands.length > 0 || (entry.outcome && entry.outcome.length > 0);

  const CARD_WIDTH = 320;
  const GAP = 12;
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 0;
  // Prefer right; flip left if there isn't room.
  const fitsRight = rect.right + GAP + CARD_WIDTH < viewportWidth - 16;
  const left = fitsRight
    ? rect.right + GAP
    : Math.max(16, rect.left - GAP - CARD_WIDTH);
  const style: CSSProperties = {
    position: 'fixed',
    top: rect.top,
    left,
    width: CARD_WIDTH,
    zIndex: 80,
  };

  return (
    <div
      style={style}
      className="pointer-events-none animate-fade-in"
      aria-hidden="true"
    >
      <div className="rounded-xl border border-subtle-border bg-card p-3.5 shadow-popover">
        <div className="text-[12.5px] font-semibold leading-snug text-ink">
          {entry.text}
        </div>
        <div className="mt-1 text-[10.5px] uppercase tracking-[0.08em] text-ink-micro">
          {formatStatusLabel(entry.status)} · {formatExactTime(entry.timestamp)}
        </div>
        {hasContent && (
          <div className="mt-3 space-y-3">
            {entry.commands.length > 0 && (
              <div>
                <div className="text-[10px] uppercase tracking-[0.08em] text-ink-micro">
                  Ran
                </div>
                <ul className="mt-1 space-y-1">
                  {entry.commands.map((c, i) => (
                    <li
                      key={i}
                      className="break-all font-mono text-[11.5px] leading-snug text-ink-body"
                    >
                      {c}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {entry.outcome && entry.outcome.length > 0 && (
              <div>
                <div className="text-[10px] uppercase tracking-[0.08em] text-ink-micro">
                  Outcome
                </div>
                <p className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-ink-label">
                  {entry.outcome}
                </p>
              </div>
            )}
          </div>
        )}
        {!hasContent && entry.status === 'pending' && (
          <p className="mt-2 text-[12px] italic text-ink-micro">
            Still in flight…
          </p>
        )}
      </div>
    </div>
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
  return Array.from(map.values());
}

function startOfDay(date: Date): Date {
  const out = new Date(date);
  out.setHours(0, 0, 0, 0);
  return out;
}

function statusDotColor(status: PromptHistoryStatus, faded: boolean): string {
  if (status === 'error') return 'bg-step-failed';
  if (status === 'cancelled') return 'bg-ink-hint';
  if (status === 'pending') return 'bg-amber animate-flicker';
  return faded ? 'bg-ink-micro' : 'bg-ink-hint';
}

function formatStatusLabel(status: PromptHistoryStatus): string {
  switch (status) {
    case 'pending':
      return 'In progress';
    case 'done':
      return 'Done';
    case 'replied':
      return 'Reply';
    case 'cd':
      return 'Folder switch';
    case 'list':
      return 'Listing';
    case 'history':
      return 'History';
    case 'cancelled':
      return 'Stopped';
    case 'error':
      return 'Error';
  }
}

function formatExactTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}
