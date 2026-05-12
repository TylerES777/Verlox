import type { MessageStep, StepStatus } from '../hooks/useCommands';

interface StepRowProps {
  step: MessageStep;
  // Chunk 3: when true, render the raw shell command in JetBrains Mono
  // below the description. Toggled per-turn by the peek control in the
  // DetailsPanel header. Only meaningful for summary-mode turns —
  // verbatim turns already show commands in their VerbatimBlock above
  // and pass false here.
  showCommand?: boolean;
}

// Phase 4 Chunk 2b. Single row inside the collapsible details panel.
// Layout: 14px status circle + title/description column + right-aligned
// status label. Title is text-ink (Inter 14px). Description is
// text-ink-label (13px). Status label is text-ink-micro (12px) and only
// appears for terminal states — the running indicator is the flicker
// itself, no redundant "Running" word.
//
// Visual map for the 14px circle:
//   queued    → outlined ring,    no fill, full opacity
//   running   → bg-amber + animate-flicker (2.5s ease-in-out, 0.85↔1)
//   done      → bg-step-done with white checkmark SVG
//   failed    → bg-step-failed with white "!" glyph
//   cancelled → outlined ring, opacity-50 (user-stopped, no red)
//   skipped   → outlined ring, opacity-50 (kill aborted while queued)
//
// `cancelled` and `skipped` share the demoted outlined ring deliberately:
// neither finished, and neither is an error. The right-side label
// disambiguates ("Cancelled" vs "Skipped").
//
// The dot is opacity-only animated — color and size stay fixed so the
// row reads calm, not kinetic. Failed rows additionally get a very
// subtle bg-step-failed-tint wash on the row container; cancelled/
// skipped rows do NOT get a tint — they're calm, not concerning.
export function StepRow({ step, showCommand = false }: StepRowProps) {
  const rowTint = step.status === 'failed' ? 'bg-step-failed-tint' : '';
  const titleOpacity =
    step.status === 'skipped' || step.status === 'cancelled' ? 'opacity-50' : '';

  return (
    <div className={`flex items-start gap-3 px-3 py-2 rounded ${rowTint}`}>
      <StatusDot status={step.status} />
      <div className={`flex-1 min-w-0 ${titleOpacity}`}>
        <div className="text-[14px] font-medium text-ink leading-snug">
          {step.title}
        </div>
        {step.description && (
          <div className="text-[13px] text-ink-label leading-snug mt-0.5">
            {step.description}
          </div>
        )}
        {/* Raw command line — only when the per-turn peek is on. JetBrains
            Mono 13px ink-body to match the verbatim block's body styling
            and read as "this is the actual shell input" without competing
            with the title hierarchy. break-all so long commands wrap
            cleanly inside the StepRow's flex column. */}
        {showCommand && (
          <div className="mt-1.5 font-mono text-[13px] text-ink-body leading-relaxed break-all">
            {step.command}
          </div>
        )}
      </div>
      <StatusLabel status={step.status} />
    </div>
  );
}

function StatusDot({ status }: { status: StepStatus }) {
  // Container is always 14×14 so vertical rhythm stays stable across
  // status transitions.
  const base = 'w-3.5 h-3.5 rounded-full flex items-center justify-center shrink-0 mt-0.5';

  if (status === 'queued') {
    return <div className={`${base} border border-ink-hint`} />;
  }
  if (status === 'running') {
    return <div className={`${base} bg-amber animate-flicker`} />;
  }
  if (status === 'done') {
    return (
      <div className={`${base} bg-step-done`}>
        <svg
          viewBox="0 0 8 8"
          className="w-2 h-2"
          fill="none"
          stroke="white"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="1.2,4.4 3.2,6.2 6.8,1.8" />
        </svg>
      </div>
    );
  }
  if (status === 'failed') {
    return (
      <div className={`${base} bg-step-failed`}>
        <span className="text-white text-[10px] font-bold leading-none">!</span>
      </div>
    );
  }
  // cancelled and skipped share the same demoted dot — disambiguated by
  // the right-side StatusLabel.
  return <div className={`${base} border border-ink-hint opacity-50`} />;
}

function StatusLabel({ status }: { status: StepStatus }) {
  if (status === 'queued' || status === 'running') return null;
  const text =
    status === 'done'
      ? 'Done'
      : status === 'failed'
        ? 'Failed'
        : status === 'cancelled'
          ? 'Cancelled'
          : 'Skipped';
  return (
    <span className="text-[12px] text-ink-micro leading-snug mt-0.5">{text}</span>
  );
}
