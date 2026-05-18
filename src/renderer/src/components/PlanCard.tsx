import { useEffect, useRef } from 'react';
import type { PlanAffects, PlanResponse } from '@shared/types';
import { StepRow } from './StepRow';
import type { MessageStep } from '../hooks/useCommands';

interface PlanCardProps {
  plan: PlanResponse;
  // Steps mirrored from the CommandMessage. Reusing the same MessageStep
  // shape (rather than rendering plan.steps directly) means the Plan Card
  // and the post-Run execution panel share the exact same StepRow
  // identities — the visual continuity is intentional.
  steps: MessageStep[];
  onConfirm: () => void;
  onCancel: () => void;
}

// Phase 4 Chunk 4. Renders inline in the conversation between the intent
// heading and what would be the execution surface. Pauses the orchestrator
// until the user clicks Run or Cancel.
//
// Two render variants (Chunk 5 adds the second):
//   - Plan Mode: caption "PLAN MODE", plan prose visible, button "Run".
//                Triggered by the session-wide planMode flag.
//   - Footgun:   caption "REVIEW NEEDED", reason banner under intent,
//                plan prose hidden, button "Run anyway".
//                Triggered by backend's footgunDetected on any step.
//                Composition rule: when BOTH planMode is on AND a footgun
//                is flagged, the footgun variant wins — it's the stricter
//                gate, and a Plan Mode user already opted into review.
//
// Keyboard contract (mirrors Phase 3.4's TranslationCard):
//   - Cancel button is auto-focused on mount.
//   - Enter on focused Cancel → fires onCancel (browser default).
//   - Tab moves focus to Run.
//   - Enter on focused Run → fires onConfirm (browser default).
//   - Escape from anywhere inside the card → fires onCancel.
// Input bar stays unfocused while the card is up so reflexive Enter
// can't bypass the review step.
export function PlanCard({ plan, steps, onConfirm, onCancel }: PlanCardProps) {
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Variant selection. Footgun wins when both apply.
  const isFootgun = plan.footgunDetected !== false;
  const captionText = isFootgun ? 'Review needed' : 'Plan Mode';
  const runLabel = isFootgun ? 'Run anyway' : 'Run';
  // The full sentence form reads as a complete thought. Backend reasons
  // are written as fragments ("recursive force delete", "drop a database,
  // schema, or table") so we prepend "This will " and append a period.
  const footgunSentence =
    plan.footgunDetected !== false
      ? `This will ${plan.footgunDetected.reason}.`
      : null;

  // Steal focus to the Cancel button on mount. The dependency is empty
  // because PlanCard only mounts when status is 'awaiting-confirmation',
  // and the component unmounts on confirm/cancel.
  useEffect(() => {
    cancelButtonRef.current?.focus();
  }, []);

  // Escape key handler — scoped to keydown on document so the user
  // doesn't have to click the card first. Only active while this card
  // is mounted.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  return (
    <div
      ref={containerRef}
      className="my-3 rounded-lg border-[0.5px] border-subtle-border bg-surface-faint p-5"
    >
      {/* Caption — deep black, uppercase, tracked out. Same treatment for
          both variants; the only difference is the word. Reads as
          "engaged," not "warning." (User: NOT amber.) */}
      <div className="mb-3 text-[10.5px] font-medium uppercase tracking-[0.08em] text-ink">
        {captionText}
      </div>

      {/* Intent — the model's interpretation of what was asked, in tight
          sans, surfaced for explicit confirmation. */}
      <p
        className="mb-3 text-[15px] font-semibold text-ink leading-snug"
        style={{ letterSpacing: '-0.01em' }}
      >
        {plan.intent}
      </p>

      {/* Footgun reason banner — only in the footgun variant. Italic,
          slightly heavier text colour than the plan prose to draw the
          eye without resorting to a color accent. Replaces (not
          augments) the plan prose below. */}
      {footgunSentence && (
        <p className="mb-4 text-[14px] italic leading-relaxed text-ink-body">
          {footgunSentence}
        </p>
      )}

      {/* Plan prose — one-paragraph approach summary in Inter. Hidden
          in the footgun variant since the reason banner above is the
          focal explanation; layering the model's prose on top dilutes
          the warning. */}
      {!isFootgun && plan.plan && (
        <p className="mb-4 text-[14px] leading-relaxed text-ink-body">
          {plan.plan}
        </p>
      )}

      {/* Steps — full list with commands always shown. Peek default
          does not apply in Plan Mode: the user opted into review, so
          there's no scenario where hiding the command serves them. */}
      {steps.length > 0 && (
        <div className="mb-4 space-y-1">
          {steps.map((s) => (
            <StepRow key={s.index} step={s} showCommand />
          ))}
        </div>
      )}

      {/* Affects — always renders. Read-only with empty arrays renders a
          single reassuring line; otherwise grouped by category. */}
      <AffectsBlock affects={plan.affects} />

      {/* Action row — Cancel first in DOM (so first in tab order) and
          auto-focused. Run is the visual primary (filled dark) but
          requires a deliberate tab to reach via keyboard. */}
      <div className="mt-5 flex items-center justify-end gap-3">
        <button
          ref={cancelButtonRef}
          type="button"
          onClick={onCancel}
          className="text-[13px] text-ink-label hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/20 rounded px-2 py-1 transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="rounded-md bg-ink px-4 py-1.5 text-[13px] font-medium text-card hover:bg-black focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 transition-colors"
        >
          {runLabel}
        </button>
      </div>
    </div>
  );
}

// "Affects" section — surfaces what the plan will touch. Three cases:
//   1. readOnly === true AND all arrays empty → single calm line.
//   2. Any array non-empty → grouped rows for each non-empty category.
//   3. readOnly === false with all arrays empty → still surface the
//      "will modify" intent via an empty-affects "Modifies state" line
//      so the user knows this isn't read-only even if the model didn't
//      enumerate specifics.
function AffectsBlock({ affects }: { affects: PlanAffects }) {
  const { files, network, permissions, readOnly } = affects;
  const allEmpty =
    files.length === 0 && network.length === 0 && permissions.length === 0;

  if (readOnly && allEmpty) {
    return (
      <p className="text-[13px] italic text-ink-label">
        Read-only. Nothing will be modified.
      </p>
    );
  }

  return (
    <div className="space-y-1.5 text-[13px]">
      {files.length > 0 && (
        <div>
          <span className="text-ink-label">Files: </span>
          <span className="font-mono text-ink-body break-all">
            {files.join(', ')}
          </span>
        </div>
      )}
      {network.length > 0 && (
        <div>
          <span className="text-ink-label">Network: </span>
          <span className="text-ink-body">{network.join(', ')}</span>
        </div>
      )}
      {permissions.length > 0 && (
        <div>
          <span className="text-ink-label">Permissions: </span>
          <span className="text-ink-body">{permissions.join(', ')}</span>
        </div>
      )}
      {!readOnly && allEmpty && (
        <p className="italic text-ink-label">Will modify state.</p>
      )}
    </div>
  );
}
