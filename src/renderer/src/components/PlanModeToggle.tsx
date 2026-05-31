import { useTier } from '../contexts/TierContext';
import { useUpgrade } from '../contexts/UpgradeContext';
import { Tooltip } from './Tooltip';

interface PlanModeToggleProps {
  on: boolean;
  onChange: (value: boolean) => void;
}

// Header-row pill toggle for session-wide Plan Mode.
//
// Plan Mode is a Pro feature. For free users the pill is locked: it
// shows a lock, can't be toggled on, and a tooltip explains why.
// (Dangerous commands still get footgun review for everyone — Plan Mode
// is only the optional "review everything" power control.)
//
// Pro visual contract (user-locked):
//   - Off state: outlined pill, ink-label text. "Available but inactive."
//   - On state: filled deep-ink pill, card-coloured text. "Engaged."
export function PlanModeToggle({ on, onChange }: PlanModeToggleProps) {
  const { isPro } = useTier();
  const { openUpgrade } = useUpgrade();

  if (!isPro) {
    return (
      <Tooltip label="Plan Mode is a Pro feature — click to upgrade">
        <button
          type="button"
          onClick={() => openUpgrade({ feature: 'Plan Mode' })}
          className="flex select-none items-center gap-1 rounded-full border-[0.5px] border-subtle-border px-2.5 py-1 text-[10.5px] font-medium uppercase tracking-[0.08em] text-ink-micro transition-colors hover:border-ink-hint hover:text-ink-label focus:outline-none"
        >
          Plan Mode
          <LockGlyph />
        </button>
      </Tooltip>
    );
  }

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

function LockGlyph() {
  return (
    <svg
      viewBox="0 0 12 12"
      className="h-2.5 w-2.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      aria-hidden="true"
    >
      <rect x="2.5" y="5.5" width="7" height="5" rx="1" />
      <path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" />
    </svg>
  );
}
