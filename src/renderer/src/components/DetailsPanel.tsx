import { useState, type ReactNode } from 'react';

interface DetailsPanelProps {
  children: ReactNode;
}

// Collapsible region for the live backend view of a turn.
//
// A single eye icon is the whole control: clicking it reveals the raw
// commands and their output, clicking again hides them. A slash through
// the eye means the panel is currently closed. The panel always starts
// closed — the conversation surface stays calm, and the backend detail
// is there for whoever wants to look.
//
// The smooth animation uses the grid-template-rows fractional trick:
// wrap the content in a CSS grid where the only row's max is `1fr` when
// open and `0fr` when closed, with overflow-hidden on the inner div.
export function DetailsPanel({ children }: DetailsPanelProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? 'Hide backend detail' : 'Show backend detail'}
        title={open ? 'Hide backend detail' : 'Show backend detail'}
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
// backend detail is currently hidden.
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
