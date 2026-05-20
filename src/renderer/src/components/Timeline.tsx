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
  const headingDot = headingDotStyle(group.isToday);
  return (
    <div className={isFirst ? '' : 'mt-8'}>
      <div className="relative flex items-center pl-8">
        {/* Group-heading dot — sits centred on the rail. */}
        <span
          className="absolute left-[24px] h-2.5 w-2.5 -translate-x-1/2 rounded-full"
          style={headingDot}
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
      <ul className="mt-3.5 space-y-2.5">
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
  const dot = entryDotStyle(entry.status, faded);
  function handleEnter() {
    const el = buttonRef.current;
    if (!el) return;
    onHoverEntry(entry, el.getBoundingClientRect());
  }
  return (
    <li className="relative">
      <span
        className={`absolute left-[24px] top-[11px] h-2 w-2 -translate-x-1/2 rounded-full ${dot.extraClass}`}
        style={dot.style}
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
        className={`w-full rounded-md py-1.5 pl-8 pr-2 text-left text-[12.5px] leading-snug transition-colors hover:bg-surface-subtle focus:outline-none ${
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

// Per-status visual for the timeline entry dot. Each dot carries a
// soft diagonal gradient + a coloured outer glow + a faint inner
// highlight along the top edge — matches the diagram cards' glassy
// treatment, just shrunk to a 8px circle. Inline style because the
// multi-stop gradient and layered shadows don't fit cleanly into
// Tailwind arbitrary values.
function entryDotStyle(
  status: PromptHistoryStatus,
  faded: boolean,
): { extraClass: string; style: CSSProperties } {
  if (status === 'error') {
    return {
      extraClass: '',
      style: {
        background: 'linear-gradient(135deg, #F47B7D 0%, #C84147 100%)',
        boxShadow: [
          'inset 0 1px 0 rgba(255,255,255,0.35)',
          '0 0 0 0.5px rgba(200,90,90,0.4)',
          '0 0 8px rgba(220,90,90,0.55)',
        ].join(', '),
      },
    };
  }
  if (status === 'cancelled') {
    return {
      extraClass: '',
      style: {
        background: 'linear-gradient(135deg, #C2C6CC 0%, #7E828A 100%)',
        boxShadow: [
          'inset 0 1px 0 rgba(255,255,255,0.35)',
          '0 0 0 0.5px rgba(120,120,130,0.3)',
          '0 0 6px rgba(140,140,150,0.3)',
        ].join(', '),
      },
    };
  }
  if (status === 'pending') {
    return {
      extraClass: 'animate-flicker',
      style: {
        background: 'linear-gradient(135deg, #FCC97A 0%, #D8923B 100%)',
        boxShadow: [
          'inset 0 1px 0 rgba(255,255,255,0.45)',
          '0 0 0 0.5px rgba(200,150,80,0.4)',
          '0 0 10px rgba(230,170,70,0.6)',
        ].join(', '),
      },
    };
  }
  // Default — done / replied / cd / list / history. Two tones based
  // on whether the group is today (ink-leaning) or older (muted).
  if (faded) {
    return {
      extraClass: '',
      style: {
        background: 'linear-gradient(135deg, #CFD3D9 0%, #969AA4 100%)',
        boxShadow: [
          'inset 0 1px 0 rgba(255,255,255,0.4)',
          '0 0 0 0.5px rgba(150,155,165,0.3)',
          '0 0 6px rgba(150,155,170,0.25)',
        ].join(', '),
      },
    };
  }
  return {
    extraClass: '',
    style: {
      background: 'linear-gradient(135deg, #9AA0AE 0%, #5B6075 100%)',
      boxShadow: [
        'inset 0 1px 0 rgba(255,255,255,0.45)',
        '0 0 0 0.5px rgba(80,90,110,0.35)',
        '0 0 8px rgba(80,95,120,0.4)',
      ].join(', '),
    },
  };
}

// Group-heading dot — slightly more weight than entries. Today gets
// the deepest gradient + strongest glow so it carries the most
// presence; older days fade.
function headingDotStyle(isToday: boolean): CSSProperties {
  if (isToday) {
    return {
      background: 'linear-gradient(135deg, #6F7587 0%, #2A2F40 100%)',
      boxShadow: [
        'inset 0 1px 0 rgba(255,255,255,0.4)',
        '0 0 0 0.5px rgba(60,70,90,0.4)',
        '0 0 10px rgba(60,75,100,0.45)',
      ].join(', '),
    };
  }
  return {
    background: 'linear-gradient(135deg, #B5B9C1 0%, #7B7F8A 100%)',
    boxShadow: [
      'inset 0 1px 0 rgba(255,255,255,0.35)',
      '0 0 0 0.5px rgba(120,130,145,0.3)',
      '0 0 8px rgba(120,130,145,0.3)',
    ].join(', '),
  };
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
