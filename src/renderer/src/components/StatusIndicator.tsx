import { useEffect, useRef, useState } from 'react';
import type { StatusIndicatorPhase } from '../hooks/useCommands';

interface StatusIndicatorProps {
  phase: StatusIndicatorPhase;
}

// Phase 4 Chunk 6 polish: 200ms cross-fade on phase transitions.
//
// Two layers are absolutely stacked in a relatively-positioned container.
// When `phase` changes, the old label becomes the outgoing layer (runs
// the fade-out keyframe) and the new label mounts as the incoming layer
// (runs fade-in). After 200ms the outgoing layer is unmounted.
//
// The container reserves a fixed height (h-[20px]) so the page doesn't
// reflow during the fade. The first phase (no previous label) renders
// without any outgoing layer — just a clean fade-in.
const PHASE_LABEL: Record<Exclude<StatusIndicatorPhase, null>, string> = {
  examining: 'Examining…',
  running: 'Running…',
  reviewing: 'Reviewing…',
};

export function StatusIndicator({ phase }: StatusIndicatorProps) {
  // `current` mirrors the live phase prop; `previous` holds the prior
  // value for the 200ms fade-out window, then nulls out.
  const [current, setCurrent] = useState<StatusIndicatorPhase>(phase);
  const [previous, setPrevious] = useState<StatusIndicatorPhase>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // No transition needed if the phase didn't actually change.
    if (phase === current) return;
    // Cancel any in-flight fade-out timer — back-to-back phase changes
    // shouldn't strand a stale label on screen.
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setPrevious(current);
    setCurrent(phase);
    timeoutRef.current = setTimeout(() => {
      setPrevious(null);
      timeoutRef.current = null;
    }, 200);
    return () => {
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [phase, current]);

  // Pure null → null: render nothing at all. Saves a layout slot when
  // the indicator is fully off (e.g. terminal states like 'done').
  if (current === null && previous === null) return null;

  return (
    <div className="relative h-[20px]">
      {/* Outgoing layer — fades from 1 → 0 over 200ms then unmounts. */}
      {previous !== null && (
        <div
          key={`prev-${previous}`}
          className="absolute inset-0 font-serif text-[13px] italic text-ink-micro animate-fade-out"
        >
          {PHASE_LABEL[previous]}
        </div>
      )}
      {/* Incoming layer — fades from 0 → 1 over 200ms.
          `key` is the phase string so React mounts a fresh element on
          every change and the keyframe restarts. */}
      {current !== null && (
        <div
          key={`curr-${current}`}
          className="absolute inset-0 font-serif text-[13px] italic text-ink-micro animate-fade-in"
        >
          {PHASE_LABEL[current]}
        </div>
      )}
    </div>
  );
}
