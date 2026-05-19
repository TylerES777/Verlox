import { useEffect, useRef, useState, type ReactNode } from 'react';

interface DetailsPanelProps {
  // Caller-derived "should this be open right now?" — typically true while
  // the turn is actively running (executing / synthesizing / streaming) and
  // false once it settles (done / killed). The panel auto-syncs to this
  // value UNTIL the user manually toggles, after which the user's choice
  // wins for the rest of the turn.
  desiredOpen: boolean;
  children: ReactNode;
}

// Phase 4 Chunk 2b. Collapsible region for the per-step list.
//
// A single eye icon is the whole control: clicking it reveals the steps
// and their raw commands together, clicking again hides them. A slash
// through the eye means the panel is currently closed.
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
export function DetailsPanel({ desiredOpen, children }: DetailsPanelProps) {
  const [open, setOpen] = useState(desiredOpen);
  const manuallyToggledRef = useRef(false);

  // Sync open to desiredOpen until the user takes manual control.
  useEffect(() => {
    if (manuallyToggledRef.current) return;
    setOpen(desiredOpen);
  }, [desiredOpen]);

  const handleToggle = () => {
    manuallyToggledRef.current = true;
    setOpen((v) => !v);
  };

  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={handleToggle}
        aria-label={open ? 'Hide steps and command' : 'Show steps and command'}
        title={open ? 'Hide steps and command' : 'Show steps and command'}
        className={`flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-surface-subtle focus:outline-none ${
          open ? 'text-ink' : 'text-ink-label hover:text-ink'
        }`}
      >
        <EyeGlyph off={!open} />
      </button>

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

// Eye glyph for the panel toggle. `off` draws a slash through it — the
// steps and command are currently hidden.
function EyeGlyph({ off }: { off?: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M1 8s2.6-4.5 7-4.5S15 8 15 8s-2.6 4.5-7 4.5S1 8 1 8z" />
      <circle cx="8" cy="8" r="2" />
      {off && <line x1="2.5" y1="13.5" x2="13.5" y2="2.5" />}
    </svg>
  );
}
