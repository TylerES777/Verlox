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

  // Outer tinted frame — same glass-frame pattern as the Running pane.
  // Footgun variant gets a warmer amber tint so the gate-needed read
  // happens before the user parses the label. Plan-Mode variant stays
  // neutral grey — it's "you opted into review," not a warning.
  const frameBackground = isFootgun
    ? 'linear-gradient(180deg, rgba(252,244,232,0.96) 0%, rgba(250,238,220,0.95) 100%)'
    : 'linear-gradient(180deg, rgba(244,245,248,0.95) 0%, rgba(240,242,246,0.95) 100%)';
  const frameStyle: React.CSSProperties = {
    background: frameBackground,
    backdropFilter: 'blur(12px) saturate(140%)',
    WebkitBackdropFilter: 'blur(12px) saturate(140%)',
    boxShadow: isFootgun
      ? '0 1px 0 rgba(255,255,255,0.7) inset, 0 0 0 0.5px rgba(0,0,0,0.05), 0 12px 32px -16px rgba(180,120,40,0.25), 0 2px 8px -4px rgba(0,0,0,0.06)'
      : '0 1px 0 rgba(255,255,255,0.7) inset, 0 0 0 0.5px rgba(0,0,0,0.04), 0 12px 32px -16px rgba(20,30,60,0.15), 0 2px 8px -4px rgba(0,0,0,0.05)',
  };
  // Inner white content surface — bright card inset within the frame,
  // sitting below the header strip. The contrast against the tinted
  // frame above is what separates the two zones (no hard divider).
  const contentStyle: React.CSSProperties = {
    background: 'linear-gradient(180deg, #FFFFFF 0%, #FDFEFE 100%)',
    boxShadow:
      '0 1px 0 rgba(255,255,255,0.9) inset, 0 1px 2px rgba(16,24,40,0.04)',
  };
  // Run button — dark gradient with a subtle inner highlight + lift
  // shadow, so the primary action reads as elevated rather than a
  // flat fill. Footgun gets a warmer brown-black to echo the frame
  // tint; default stays neutral ink.
  const runStyle: React.CSSProperties = {
    background: isFootgun
      ? 'linear-gradient(180deg, #2A1F12 0%, #15100A 100%)'
      : 'linear-gradient(180deg, #1B1B1F 0%, #0A0A0C 100%)',
    boxShadow:
      '0 1px 0 rgba(255,255,255,0.08) inset, 0 1px 2px rgba(0,0,0,0.15), 0 4px 12px -4px rgba(0,0,0,0.25)',
  };
  // Pip color matches the variant — amber for review/plan, footgun
  // gets a deeper orange. Same lit-glass treatment as the Running
  // pane's dot so visual language stays consistent.
  const pipStyle: React.CSSProperties = isFootgun
    ? {
        background: 'linear-gradient(135deg, #F2B45A 0%, #C76A1F 100%)',
        boxShadow:
          'inset 0 0.5px 0 rgba(255,255,255,0.45), 0 0 6px rgba(220,140,40,0.55)',
      }
    : {
        background: 'linear-gradient(135deg, #E8C36B 0%, #B88A2E 100%)',
        boxShadow:
          'inset 0 0.5px 0 rgba(255,255,255,0.45), 0 0 6px rgba(200,160,70,0.5)',
      };

  return (
    <div
      ref={containerRef}
      className="relative my-3 overflow-hidden rounded-2xl border border-subtle-border"
      style={frameStyle}
    >
      {/* Top-edge highlight — 1px white sheen along the inside of the
          frame's top edge. Sells the lifted glass feel. */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/85 to-transparent"
        aria-hidden="true"
      />

      {/* Header strip — pip + uppercase label, sits on the tinted
          frame. No divider — the contrast with the bright inner card
          below is the separation, matching the Running pane pattern. */}
      <div className="relative flex items-center gap-2 px-5 pt-3 pb-2.5">
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={pipStyle}
          aria-hidden="true"
        />
        <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-label">
          {captionText}
        </span>
      </div>

      {/* Inner white content card — holds intent, prose, steps,
          affects, and the action row. Inset within the frame. */}
      <div
        className="relative mx-2 mb-2 rounded-xl border border-subtle-border/70 px-5 py-4"
        style={contentStyle}
      >
        {/* Intent — the model's interpretation of what was asked. */}
        <p
          className="mb-3 text-[15px] font-semibold leading-snug text-ink"
          style={{ letterSpacing: '-0.01em' }}
        >
          {plan.intent}
        </p>

        {/* Footgun reason banner — replaces (not augments) the plan
            prose below in the footgun variant. */}
        {footgunSentence && (
          <p className="mb-4 text-[14px] italic leading-relaxed text-ink-body">
            {footgunSentence}
          </p>
        )}

        {/* Plan prose — one-paragraph approach summary. Hidden in
            footgun variant so the banner above stays the focal point. */}
        {!isFootgun && plan.plan && (
          <p className="mb-4 text-[14px] leading-relaxed text-ink-body">
            {plan.plan}
          </p>
        )}

        {/* Steps — full list with commands always shown. */}
        {steps.length > 0 && (
          <div className="mb-4 space-y-1">
            {steps.map((s) => (
              <StepRow key={s.index} step={s} showCommand />
            ))}
          </div>
        )}

        {/* Affects — always renders. */}
        <AffectsBlock affects={plan.affects} />

        {/* Action row — Cancel first in DOM for tab order + auto-focus.
            Run carries the lifted dark-gradient treatment so it reads
            as the deliberate primary action. */}
        <div className="mt-5 flex items-center justify-end gap-3">
          <button
            ref={cancelButtonRef}
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-[13px] text-ink-label transition-colors hover:bg-surface-subtle hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/15"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-md px-4 py-1.5 text-[13px] font-medium text-white transition-transform focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 active:scale-[0.98]"
            style={runStyle}
          >
            {runLabel}
          </button>
        </div>
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
