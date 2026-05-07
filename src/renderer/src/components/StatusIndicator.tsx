import type { StatusIndicatorPhase } from '../hooks/useCommands';

interface StatusIndicatorProps {
  phase: StatusIndicatorPhase;
}

// Phase 4 Chunk 2a renders the status word with a hard swap on phase
// change. Chunk 6 polish layers a 200ms opacity cross-fade on top via a
// `key` prop trick — leaving the visual contract intentionally minimal
// here so the polish pass has room to land cleanly.
const PHASE_LABEL: Record<Exclude<StatusIndicatorPhase, null>, string> = {
  examining: 'Examining…',
  running: 'Running…',
  reviewing: 'Reviewing…',
};

export function StatusIndicator({ phase }: StatusIndicatorProps) {
  if (phase === null) return null;
  return (
    <div className="font-serif text-[13px] italic text-ink-micro">
      {PHASE_LABEL[phase]}
    </div>
  );
}
