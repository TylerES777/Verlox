import { useEffect, useRef, useState, type ReactNode } from 'react';

interface DetailsPanelProps {
  // Caller-derived "should this be open right now?" — typically true while
  // the turn is actively running (executing / synthesizing / streaming) and
  // false once it settles (done / killed). The panel auto-syncs to this
  // value UNTIL the user manually toggles, after which the user's choice
  // wins for the rest of the turn.
  desiredOpen: boolean;
  // Content shown next to the chevron — an icon, a count, a label.
  label: ReactNode;
  // Optional slot rendered to the right of the label, on the same line as
  // the chevron — used for per-turn affordances like the Chunk 3 peek
  // toggle. The slot stays in the document flow regardless of open state
  // (it's part of the header, not the collapsible body) so users can flip
  // peek without expanding the panel first.
  headerRight?: ReactNode;
  // Optional "force open" signal. Each time this number changes, the
  // panel opens (and locks in as manually-toggled so it won't auto-
  // collapse afterward). Used by the peek toggle: clicking "show/hide
  // command" while the panel is collapsed would otherwise produce no
  // visible change, so the toggle bumps this signal to surface the
  // step list. The number's value is meaningless — only changes matter.
  expandSignal?: number;
  children: ReactNode;
}

// Phase 4 Chunk 2b. Collapsible region for the per-step list.
//
// Open-state policy:
//   1. On mount, open follows desiredOpen.
//   2. While the user has NOT manually toggled, open keeps tracking
//      desiredOpen. So a turn opens during execution and auto-collapses
//      when it transitions to done/killed.
//   3. The first manual toggle "locks in" the user's intent —
//      manuallyToggled flips true and desiredOpen no longer drives the
//      panel. The user's last choice persists for the lifetime of this
//      message.
//
// The smooth animation uses the grid-template-rows fractional trick:
// wrap the content in a CSS grid where the only row's max is `1fr` when
// open and `0fr` when closed, with overflow-hidden on the inner div.
// Tailwind doesn't ship `grid-rows-[0fr]`/`grid-rows-[1fr]` arbitrary
// values out of the box but they render fine via the JIT bracket syntax.
//
// Why grid + 1fr/0fr instead of max-height: max-height needs a magic
// number that breaks when content grows past it; 1fr correctly tracks
// the natural height of the content with a real CSS transition.
export function DetailsPanel({
  desiredOpen,
  label,
  headerRight,
  expandSignal,
  children,
}: DetailsPanelProps) {
  const [open, setOpen] = useState(desiredOpen);
  const manuallyToggledRef = useRef(false);
  // Tracks the last expandSignal value acted on. Initialized to the
  // prop's mount value so the effect below skips the initial render
  // and only fires on genuine changes.
  const expandSignalSeenRef = useRef(expandSignal);

  // Sync open to desiredOpen until the user takes manual control.
  useEffect(() => {
    if (manuallyToggledRef.current) return;
    setOpen(desiredOpen);
  }, [desiredOpen]);

  // Force-open on every expandSignal change. Treated as a manual toggle
  // (the user clicked something that implies intent to see the steps),
  // so it also locks out the desiredOpen auto-sync from here on.
  useEffect(() => {
    if (expandSignal === expandSignalSeenRef.current) return;
    expandSignalSeenRef.current = expandSignal;
    manuallyToggledRef.current = true;
    setOpen(true);
  }, [expandSignal]);

  const handleToggle = () => {
    manuallyToggledRef.current = true;
    setOpen((v) => !v);
  };

  return (
    <div className="mt-4">
      {/* Header row: chevron+label on the left (toggles the panel), the
          optional headerRight slot on the right. The slot lives in its
          own sibling so clicks inside it don't bubble into the toggle. */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={handleToggle}
          className="flex items-center gap-1.5 text-[12px] text-ink-label hover:text-ink focus:outline-none transition-colors"
        >
          <Chevron open={open} />
          {label}
        </button>
        {headerRight !== undefined && <div>{headerRight}</div>}
      </div>

      <div
        className={`grid transition-[grid-template-rows] duration-200 ease-out ${
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        }`}
      >
        <div className="overflow-hidden">
          <div className="pt-2">{children}</div>
        </div>
      </div>
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 12 12"
      className={`w-3 h-3 transition-transform duration-200 ${
        open ? 'rotate-90' : ''
      }`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="4,2 8,6 4,10" />
    </svg>
  );
}
