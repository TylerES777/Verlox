import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import {
  clearPromptHistory,
  usePromptHistory,
  type PromptHistoryEntry,
  type PromptHistoryStatus,
} from '../hooks/usePromptHistory';
import { Tooltip } from './Tooltip';

interface TimelineProps {
  // Click handler — the caller pastes the prompt into the active
  // conversation's input.
  onSelect: (text: string) => void;
}

// Max height of the Timeline's scroll window. The board grows with the
// entries up to this point — about 7 rows plus a day-heading — then
// stops growing and scrolls internally, so the ~8th entry is what trips
// the scrollbar. Tuned by eye against the entry row height (~44px);
// kept in px so it doesn't drift with viewport size like the old 65vh.
const TIMELINE_SCROLL_MAX = '340px';

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

  // Outer tinted frame — same liquid-glass language as the Running
  // pane: warm grey gradient + 1px top highlight + breathing-style
  // soft drop shadow. Wraps the bright white inner card that holds
  // the actual history list.
  const frameStyle: React.CSSProperties = {
    background:
      'linear-gradient(180deg, rgba(244,245,248,0.95) 0%, rgba(240,242,246,0.95) 100%)',
    backdropFilter: 'blur(12px) saturate(140%)',
    WebkitBackdropFilter: 'blur(12px) saturate(140%)',
  };
  const contentStyle: React.CSSProperties = {
    background: 'linear-gradient(180deg, #FFFFFF 0%, #FDFEFE 100%)',
    boxShadow:
      '0 1px 0 rgba(255,255,255,0.9) inset, 0 1px 2px rgba(16,24,40,0.04)',
  };
  return (
    <div className="flex flex-col p-5">
      {/* Title row — "Timeline" as a regular component name (sentence-
          case, semibold), not a tracked uppercase label. Clear sits on
          the right as a subtle text+icon affordance. */}
      <div className="mb-3 flex shrink-0 items-center justify-between px-1">
        <h2 className="text-[15px] font-semibold tracking-tight text-ink">
          Timeline
        </h2>
        {entries.length > 0 && (
          <Tooltip label="Clear history (also clears when you quit Verlox)">
            <button
              type="button"
              onClick={clearPromptHistory}
              aria-label="Clear history"
              className="flex h-6 items-center gap-1 rounded-md px-2 text-[11px] text-ink-micro transition-colors hover:bg-surface-subtle hover:text-ink focus:outline-none"
            >
              <ClearGlyph />
              <span>Clear</span>
            </button>
          </Tooltip>
        )}
      </div>

      {/* Outer board — rounded tinted frame holds the bright white
          inset card with the actual history. Sizes to its content so
          the board only grows with the entries; the inner scroll
          region caps the visible window at ~8 entries (see TIMELINE_
          SCROLL_MAX) and scrolls internally beyond that, so the board
          never marches down the sidebar indefinitely. */}
      <div
        className="relative flex flex-col overflow-hidden rounded-2xl border border-subtle-border"
        style={frameStyle}
      >
        {/* Top-edge highlight — 1px white sheen along the inside top
            of the frame, sells the lifted glass feel. */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/85 to-transparent"
          aria-hidden="true"
        />

        {/* Inner white content card */}
        <div
          className="relative m-2 flex flex-col overflow-hidden rounded-xl border border-subtle-border/70"
          style={contentStyle}
        >
          {entries.length === 0 ? (
            <p className="px-4 py-4 text-[12.5px] leading-relaxed text-ink-label">
              Your prompts will appear here as you go. The Timeline starts
              fresh each time you open Verlox.
            </p>
          ) : (
            <>
              <div
                className="relative overflow-y-auto px-5 pb-6 pt-3
                           [&::-webkit-scrollbar]:w-2
                           [&::-webkit-scrollbar-track]:bg-transparent
                           [&::-webkit-scrollbar-thumb]:rounded-full
                           [&::-webkit-scrollbar-thumb]:bg-black/25
                           hover:[&::-webkit-scrollbar-thumb]:bg-black/40"
                style={{ maxHeight: TIMELINE_SCROLL_MAX }}
              >
                {/* The connecting vertical line behind the dots. Lives
                    in the content flow (not absolute-in-scroll-container,
                    which positions inconsistently once the region
                    scrolls) so it tracks the dots reliably. Its height
                    is set to span from the first dot to the last via the
                    wrapper below. */}
                <div className="relative">
                  <div
                    className="pointer-events-none absolute bottom-2 left-[24px] top-2 w-px bg-black/12"
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
              </div>
              {/* Bottom fade — softens the scroll cut-off into the card.
                  Sits over the scroll region's lower edge; pointer-
                  events-none so it never blocks clicks on the last row. */}
              <div
                className="pointer-events-none absolute inset-x-0 bottom-0 h-10 rounded-b-xl bg-gradient-to-b from-transparent via-white/70 to-white"
                aria-hidden="true"
              />
            </>
          )}
        </div>
      </div>
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
    <div className={isFirst ? '' : 'mt-8'}>
      <h3
        className={`text-[15px] font-semibold ${
          group.isToday ? 'text-ink' : 'text-ink-label'
        }`}
      >
        {group.heading}
      </h3>
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
  function handleEnter() {
    const el = buttonRef.current;
    if (!el) return;
    onHoverEntry(entry, el.getBoundingClientRect());
  }
  return (
    <li>
      {/* Each entry is its own rounded card with a small clock icon at
          the left. Hover lifts the border / lightens the background; no
          more colored status dots — the card affordance carries the
          interaction, and status detail still lives on the hover card. */}
      <button
        ref={buttonRef}
        type="button"
        onClick={() => onSelect(entry.text)}
        onMouseEnter={handleEnter}
        onMouseLeave={onLeaveEntry}
        onFocus={handleEnter}
        onBlur={onLeaveEntry}
        className={`flex w-full items-start gap-2.5 rounded-xl border border-subtle-border bg-card px-3 py-2.5 text-left text-[14px] leading-snug transition-colors hover:border-ink-hint hover:bg-surface-subtle focus:outline-none ${
          faded ? 'text-ink-label hover:text-ink' : 'text-ink-body hover:text-ink'
        }`}
      >
        <ClockGlyph className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-micro" />
        <span className="break-words">{entry.text}</span>
      </button>
    </li>
  );
}

// Small clock face used as the entry leading icon — replaces the old
// colored status dot. Stroke uses currentColor so the parent button
// drives muted-vs-active tinting via text-* classes.
function ClockGlyph({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5 V8 L10.5 9.5" />
    </svg>
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

// (Per-status entry dot + group-heading dot helpers were removed when
// each entry became a rounded card with a leading clock glyph. Status
// detail still surfaces on the hover card — see formatStatusLabel.)

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

// Reload-style circular arrow — same glyph the Header's Clear button
// uses on a conversation. Keeps the "reset / start over" visual
// language consistent across surfaces.
function ClearGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3 w-3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 8a5 5 0 1 0 1.6-3.7" />
      <polyline points="3,2 3,5 6,5" />
    </svg>
  );
}
