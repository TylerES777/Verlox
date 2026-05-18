import { useState } from 'react';
import type { CommandMessage, MessageStep } from '../hooks/useCommands';
import { StatusIndicator } from './StatusIndicator';
import { StepRow } from './StepRow';
import { DetailsPanel } from './DetailsPanel';
import { PlanCard } from './PlanCard';

interface MessageProps {
  message: CommandMessage;
  onStop: (id: string) => void;
  // Per-turn peek toggle (Chunk 3). Flips the message's peekEnabled
  // flag. Only invoked for summary-mode turns where the toggle UI is
  // visible — verbatim and step-less turns don't render the affordance.
  onTogglePeek: (id: string) => void;
  // Plan Card actions (Chunk 4). Called when the user clicks Run or
  // Cancel on a paused turn. Resolve the orchestrator's awaited promise
  // inside useCommands.
  onConfirmPlan: (id: string) => void;
  onCancelPlan: (id: string) => void;
}

// Phase 4 Chunk 2b: adds StepRow list (in a collapsible DetailsPanel) and
// the verbatim raw-output block. Chunk 3 adds the peek toggle and raw
// command access; Chunks 4–5 add Plan Card and footgun review.
//
// Visual hierarchy per turn:
//   [intent — "› " prompt + tight sans]  ← user's natural-language input
//   [optional status indicator]          ← lowercase mono, gray
//   [optional response prose]            ← Inter 15px, reveal-smoothed
//   [verbatim raw output blocks]         ← only when displayMode='verbatim'
//   [optional error / cd / killed line]  ← context-specific footers
//   [Stop button]                        ← only while executing
//   [details panel: steps]               ← collapsible, default open
export function Message({
  message,
  onStop,
  onTogglePeek,
  onConfirmPlan,
  onCancelPlan,
}: MessageProps) {
  const {
    status,
    statusIndicator,
    finalResponse,
    errorMessage,
    steps,
    displayMode,
    peekEnabled,
    plan,
  } = message;

  // The details panel becomes visible the moment we have any steps to
  // show. Hidden for refusal / cd / planning-error turns where steps
  // never get initialized. Also hidden during the Plan Mode pause and
  // after a cancellation — the Plan Card already shows the steps list,
  // and "Plan discarded." turns have nothing to expand into.
  const showDetails =
    steps.length > 0 &&
    status !== 'awaiting-confirmation' &&
    status !== 'cancelled-before-run';

  // Auto-open while the turn is in motion, auto-collapse once it
  // settles. The DetailsPanel honours this UNTIL the user manually
  // toggles — after that, the user's choice wins for the rest of the
  // message's life.
  //
  // 'killed' is included so the panel stays open after a stop: the
  // cancelled step (and any skipped ones) are the whole reason the user
  // pressed stop, so auto-collapsing them out of sight reads as the app
  // hiding the outcome. 'done' still auto-collapses — a clean finish
  // doesn't need the steps in the user's face.
  const detailsDesiredOpen =
    status === 'executing' ||
    status === 'synthesizing' ||
    status === 'streaming' ||
    status === 'killed';

  // Verbatim raw-output blocks render only in verbatim mode after at
  // least one step has produced output. We render once the turn is
  // executing or done — during execution the blocks fill in live.
  const showVerbatim =
    displayMode === 'verbatim' &&
    (status === 'executing' || status === 'done' || status === 'killed');

  // Peek toggle visibility (Chunk 3). Only summary-mode turns get the
  // affordance — verbatim turns already show every command in their
  // VerbatimBlock, and refusal/cd/planning-error turns have no steps.
  const showPeekToggle = showDetails && displayMode === 'summary';

  // showCommand on each StepRow follows the same gate. Verbatim mode
  // never shows commands inside StepRows (the verbatim block above is
  // the canonical surface for those).
  const stepShowCommand = peekEnabled && displayMode === 'summary';

  // Counter bumped every time the peek toggle is clicked. Passed to
  // DetailsPanel as expandSignal so a click while the panel is collapsed
  // expands it — otherwise toggling "show/hide command" produces no
  // visible change and the click feels dead.
  const [peekExpandSignal, setPeekExpandSignal] = useState(0);

  return (
    <article className="mb-8">
      {/* Intent — the user's request, framed as a terminal prompt line:
          an amber "›" marker + the text in tight sans. Reads as a
          command entered, not an article headline. */}
      <h2
        className="mb-3 flex items-start gap-2 text-[16px] font-semibold text-ink leading-snug"
        style={{ letterSpacing: '-0.01em' }}
      >
        <span
          className="shrink-0 select-none font-mono font-medium text-amber"
          aria-hidden="true"
        >
          ›
        </span>
        <span className="min-w-0">{message.userInput}</span>
      </h2>

      {/* Status indicator — visible during translating / executing /
          synthesizing phases. Hidden as soon as the response starts
          streaming or any terminal status is reached. */}
      {statusIndicator !== null && <StatusIndicator phase={statusIndicator} />}

      {/* Plan Card — only visible while the orchestrator is paused
          awaiting confirmation. The card itself is the UI surface;
          status indicator is null in this state. */}
      {status === 'awaiting-confirmation' && plan && (
        <PlanCard
          plan={plan}
          steps={steps}
          onConfirm={() => onConfirmPlan(message.id)}
          onCancel={() => onCancelPlan(message.id)}
        />
      )}

      {/* Cancelled-before-run footer — terminal state when the user
          clicks Cancel on the Plan Card. The intent heading above stays
          visible so scroll-back history is honest. */}
      {status === 'cancelled-before-run' && (
        <p className="text-[14px] leading-relaxed text-ink-label italic">
          Plan discarded.
        </p>
      )}

      {/* AI response prose — visible in streaming, done, refused, and
          synthesize-error states. Inter 15px, reveal-smoothed. Only
          rendered for summary mode (verbatim mode has no synthesize
          prose; the raw output blocks below stand in). */}
      {finalResponse.length > 0 && (
        <p className="whitespace-pre-wrap text-[15px] leading-[1.65] text-[#3A3A3A]">
          {finalResponse}
        </p>
      )}

      {/* Verbatim raw-output blocks — one per step that has run. Each
          block is a left-bordered group: the command header (JetBrains
          Mono weight 500, ink) sits above the raw output (JetBrains Mono
          regular, ink-body). Steps still queued or skipped don't render
          a block; cancelled steps DO render — they ran for a moment and
          their partial output is still meaningful. */}
      {showVerbatim && (
        <div className="mt-3 space-y-4">
          {steps
            .filter((s) => s.status !== 'queued' && s.status !== 'skipped')
            .map((s) => (
              <VerbatimBlock key={s.index} step={s} />
            ))}
        </div>
      )}

      {/* cd-success: single calm line, hard-rendered. */}
      {status === 'cd-success' && message.cdResolvedDisplay && (
        <p className="text-[14px] text-ink-body">
          Switched to {message.cdResolvedDisplay}.
        </p>
      )}

      {/* cd-error / planning-error: single calm error line. */}
      {(status === 'cd-error' || status === 'planning-error') && errorMessage && (
        <p className="text-[14px] leading-relaxed text-ink-label">{errorMessage}</p>
      )}

      {/* synthesize-error: response (whatever streamed in before the error)
          stays visible above; error footer follows. */}
      {status === 'synthesize-error' && errorMessage && (
        <p className="mt-3 text-[12px] text-ink-micro">{errorMessage}</p>
      )}

      {/* Killed: footer line. The Stop button itself moves into the
          details panel header in Chunk 3 — for 2b it stays inline below. */}
      {status === 'killed' && (
        <p className="mt-3 text-[12px] text-ink-micro">Stopped.</p>
      )}

      {/* Stop affordance during execution. Quiet, gray, hover ink. */}
      {status === 'executing' && (
        <button
          type="button"
          onClick={() => onStop(message.id)}
          className="mt-2 text-[12px] text-ink-hint hover:text-ink focus:outline-none"
        >
          stop
        </button>
      )}

      {/* Steps list — collapsible. Open while the turn is running so the
          user sees live progress, auto-collapses when status settles to
          done/killed. The user can manually expand a settled turn or
          collapse a running one — DetailsPanel locks in the manual
          choice from that point on. */}
      {showDetails && (
        <DetailsPanel
          label={`Steps (${steps.length})`}
          desiredOpen={detailsDesiredOpen}
          expandSignal={peekExpandSignal}
          headerRight={
            showPeekToggle ? (
              <button
                type="button"
                onClick={() => {
                  onTogglePeek(message.id);
                  // Bump the signal so DetailsPanel expands — makes the
                  // toggle visible even when the panel was collapsed.
                  setPeekExpandSignal((n) => n + 1);
                }}
                className="text-[12px] text-ink-label hover:text-ink focus:outline-none transition-colors"
              >
                {peekEnabled ? 'hide command' : 'show command'}
              </button>
            ) : undefined
          }
        >
          <div className="space-y-1">
            {steps.map((s) => (
              <StepRow key={s.index} step={s} showCommand={stepShowCommand} />
            ))}
          </div>
        </DetailsPanel>
      )}
    </article>
  );
}

// Per-step raw output block for verbatim mode — a contained terminal
// block: a command-prompt header strip, a hairline divider, then the raw
// output. The boxed surface reads as a discrete unit (like a Warp block
// or a code block), not a blog pullquote.
function VerbatimBlock({ step }: { step: MessageStep }) {
  return (
    <div className="overflow-hidden rounded-lg border border-subtle-border bg-surface-subtle">
      {/* Command header — the prompt line. */}
      <div className="flex gap-2 px-3 py-2 font-mono text-[12.5px] font-medium text-ink">
        <span className="shrink-0 select-none text-amber" aria-hidden="true">
          ›
        </span>
        <span className="min-w-0 break-all">{step.command}</span>
      </div>
      {step.output.length > 0 && (
        <pre className="whitespace-pre-wrap border-t border-subtle-border bg-surface-faint px-3 py-2 font-mono text-[12.5px] font-normal leading-relaxed text-ink-body">
          {step.output}
        </pre>
      )}
    </div>
  );
}
