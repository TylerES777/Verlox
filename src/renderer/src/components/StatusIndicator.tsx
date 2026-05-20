import { useEffect, useRef, useState } from 'react';
import type { StatusInfo, StatusIndicatorState } from '../hooks/useCommands';

interface StatusIndicatorProps {
  info: StatusIndicatorState;
}

// How long each label is shown before rotating to the next within
// the same StatusInfo. Slow enough to read, fast enough to feel alive.
const ROTATE_MS = 2000;

// Cross-fade duration when the label swaps. Matches the existing
// fade-in / fade-out keyframes in tailwind.config.
const FADE_MS = 200;

// The status indicator that sits under the user input while a turn
// is in motion. The orchestrator pushes specific, current labels into
// `info` ("Running ping google.com"), and the indicator rotates
// through the optional `alts` every 2s while that info persists so a
// long step never reads as stuck on one word.
//
// Two layers absolutely stacked: outgoing fades out, incoming fades
// in. The container reserves a fixed height (h-[20px]) so the page
// doesn't reflow during the fade.
export function StatusIndicator({ info }: StatusIndicatorProps) {
  // The StatusInfo the indicator is currently animating against —
  // lags behind the `info` prop by a fade window when it changes.
  const [shownInfo, setShownInfo] = useState<StatusIndicatorState>(info);
  // Index within the sequence [shownInfo.label, ...shownInfo.alts].
  const [labelIndex, setLabelIndex] = useState(0);
  // The outgoing label string mid-fade-out, if any.
  const [outgoingLabel, setOutgoingLabel] = useState<string | null>(null);

  const fadeOutTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // React to changes in the `info` prop pushed by the orchestrator.
  // When the content differs from what we're showing, fade the
  // current label out and reset the rotation to the new info's first
  // label.
  useEffect(() => {
    if (sameInfo(shownInfo, info)) return;
    const oldLabel =
      shownInfo !== null
        ? sequenceFor(shownInfo)[labelIndex] ?? null
        : null;
    startFadeOut(oldLabel);
    setShownInfo(info);
    setLabelIndex(0);
    // labelIndex is intentionally read but excluded from deps — we
    // only need its current value at the moment info changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info]);

  // Rotate through the alts while the same StatusInfo persists. The
  // interval restarts only when shownInfo changes (so a long-lived
  // info keeps a steady heartbeat).
  useEffect(() => {
    if (shownInfo === null) return;
    const sequence = sequenceFor(shownInfo);
    if (sequence.length <= 1) return;
    const interval = setInterval(() => {
      setLabelIndex((prev) => {
        const oldLabel = sequence[prev];
        startFadeOut(oldLabel);
        return (prev + 1) % sequence.length;
      });
    }, ROTATE_MS);
    return () => clearInterval(interval);
  }, [shownInfo]);

  // Clean up any pending fade timer on unmount.
  useEffect(() => {
    return () => {
      if (fadeOutTimeoutRef.current !== null) {
        clearTimeout(fadeOutTimeoutRef.current);
      }
    };
  }, []);

  if (shownInfo === null && outgoingLabel === null) return null;

  const currentLabel =
    shownInfo !== null ? sequenceFor(shownInfo)[labelIndex] ?? null : null;

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

// The full label sequence the indicator cycles through for a given
// info: the primary label first, then each alt in order.
function sequenceFor(info: StatusInfo): string[] {
  return [info.label, ...info.alts];
}

// Treat two StatusInfo objects as the same when their label and
// alts are content-equal. Reducer dispatches create fresh objects
// even when the content matches, so a deep compare keeps the
// indicator from re-running its fade on noop updates.
function sameInfo(a: StatusIndicatorState, b: StatusIndicatorState): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a.label !== b.label) return false;
  if (a.alts.length !== b.alts.length) return false;
  for (let i = 0; i < a.alts.length; i += 1) {
    if (a.alts[i] !== b.alts[i]) return false;
  }
  return true;
}
