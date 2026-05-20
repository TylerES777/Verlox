import { useEffect, useRef, useState } from 'react';
import type { StatusIndicatorPhase } from '../hooks/useCommands';

interface StatusIndicatorProps {
  phase: StatusIndicatorPhase;
}

// Each phase has several calm labels that rotate while the phase
// persists, so the indicator never reads as stuck on a single word
// when the backend is sitting on one beat (most reply turns only
// ever pass through 'examining', for instance — without rotation
// the user just sees "examining…" for the whole wait).
const PHASE_LABELS: Record<Exclude<StatusIndicatorPhase, null>, string[]> = {
  examining: ['examining…', 'thinking…', 'composing…'],
  running: ['running…', 'watching output…'],
  reviewing: ['reviewing…', 'writing reply…'],
};

// How long each label is shown before rotating to the next within
// the same phase. Slow enough to read, fast enough to feel alive.
const ROTATE_MS = 2000;

// Cross-fade duration when the label swaps. Matches the existing
// fade-in / fade-out keyframes in tailwind.config.
const FADE_MS = 200;

// Phase 4 Chunk 6 polish: 200ms cross-fade on label transitions.
//
// Two layers absolutely stacked in a relatively-positioned container.
// When the label changes — either because the orchestrator pushed a
// new phase, or because the within-phase rotation timer ticked — the
// old label runs the fade-out keyframe and the new one fades in.
// After 200ms the outgoing layer is unmounted.
//
// The container reserves a fixed height (h-[20px]) so the page
// doesn't reflow during the fade. The first label (no previous) just
// fades in cleanly.
export function StatusIndicator({ phase }: StatusIndicatorProps) {
  // The phase the indicator is currently showing. Tracks the prop
  // but lags behind a fade window when the prop changes.
  const [shownPhase, setShownPhase] = useState<StatusIndicatorPhase>(phase);
  // Index within the current phase's label rotation.
  const [labelIndex, setLabelIndex] = useState(0);
  // The outgoing label string mid-fade-out, if any.
  const [outgoingLabel, setOutgoingLabel] = useState<string | null>(null);

  const fadeOutTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Helper used by both the phase-change effect and the rotation
  // interval — set outgoingLabel for FADE_MS, then clear it.
  function startFadeOut(label: string | null) {
    if (fadeOutTimeoutRef.current !== null) {
      clearTimeout(fadeOutTimeoutRef.current);
    }
    setOutgoingLabel(label);
    fadeOutTimeoutRef.current = setTimeout(() => {
      setOutgoingLabel(null);
      fadeOutTimeoutRef.current = null;
    }, FADE_MS);
  }

  // React to phase changes from the orchestrator. Resets the
  // within-phase rotation to the first label of the new phase.
  useEffect(() => {
    if (phase === shownPhase) return;
    const oldLabel =
      shownPhase !== null ? PHASE_LABELS[shownPhase][labelIndex] ?? null : null;
    startFadeOut(oldLabel);
    setShownPhase(phase);
    setLabelIndex(0);
    // labelIndex is intentionally read but not in deps — we only want
    // to capture its current value at the moment the phase changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, shownPhase]);

  // Rotate labels within the current phase. The interval restarts
  // only when the phase changes, so a long-running phase keeps the
  // same heartbeat across many ticks.
  useEffect(() => {
    if (shownPhase === null) return;
    const labels = PHASE_LABELS[shownPhase];
    if (labels.length <= 1) return;
    const interval = setInterval(() => {
      setLabelIndex((prev) => {
        const oldLabel = labels[prev];
        startFadeOut(oldLabel);
        return (prev + 1) % labels.length;
      });
    }, ROTATE_MS);
    return () => clearInterval(interval);
  }, [shownPhase]);

  // Clean up any pending fade timer on unmount.
  useEffect(() => {
    return () => {
      if (fadeOutTimeoutRef.current !== null) {
        clearTimeout(fadeOutTimeoutRef.current);
      }
    };
  }, []);

  // Pure null → null with no outgoing label: render nothing.
  if (shownPhase === null && outgoingLabel === null) return null;

  const currentLabel =
    shownPhase !== null ? PHASE_LABELS[shownPhase][labelIndex] : null;

  return (
    <div className="relative h-[20px]">
      {outgoingLabel !== null && (
        <div
          key={`out-${outgoingLabel}`}
          className="absolute inset-0 font-mono text-[12px] text-ink-micro animate-fade-out"
        >
          {outgoingLabel}
        </div>
      )}
      {currentLabel !== null && (
        <div
          key={`in-${currentLabel}`}
          className="absolute inset-0 font-mono text-[12px] text-ink-micro animate-fade-in"
        >
          {currentLabel}
        </div>
      )}
    </div>
  );
}
