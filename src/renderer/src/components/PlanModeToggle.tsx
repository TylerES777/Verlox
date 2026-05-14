interface PlanModeToggleProps {
  on: boolean;
  onChange: (value: boolean) => void;
}

// Phase 4 Chunk 4. Header-row pill toggle for session-wide Plan Mode.
//
// Visual contract (user-locked):
//   - Caption "PLAN MODE" — deep black, uppercase, tracked-out 0.08em.
//     NOT amber. Reads as "engaged," not "warning."
//   - Off state: outlined pill, ink-label text. "Available but inactive."
//   - On state: filled deep-ink pill, card-coloured text. "Engaged."
//   - Hover on off state lifts text to ink so the affordance is obvious.
export function PlanModeToggle({ on, onChange }: PlanModeToggleProps) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => onChange(!on)}
      className={`rounded-full px-2.5 py-1 text-[10.5px] font-medium uppercase tracking-[0.08em] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/20 ${
        on
          ? 'bg-ink text-card hover:bg-black'
          : 'border-[0.5px] border-subtle-border text-ink-label hover:text-ink'
      }`}
    >
      Plan Mode
    </button>
  );
}
