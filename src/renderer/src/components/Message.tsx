import { useState } from 'react';
import type { CommandMessage, MessageStep } from '../hooks/useCommands';
import { StatusIndicator } from './StatusIndicator';
import { StepRow } from './StepRow';
import { DetailsPanel } from './DetailsPanel';
import { PlanCard } from './PlanCard';
import { CopyButton } from './CopyButton';

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

  // A step failed or was cancelled — the turn's outcome isn't obvious
  // from the raw output alone, so the steps panel earns its place.
  const hasTrouble = steps.some(
    (s) => s.status === 'failed' || s.status === 'cancelled',
  );

  // The details panel shows only when it adds something. Summary turns
  // always get it — commands are hidden behind prose, so the panel (and
  // its peek toggle) is the only place to see what ran. Verbatim turns
  // get it only when it isn't pure redundancy with the command+output
  // blocks: more than one step, or a step that failed / was cancelled.
  // A lone command that succeeded shows nothing extra — its block says
  // it all. Never shown for step-less turns, the Plan Mode pause, or
  // cancellations (the Plan Card covers those).
  const showDetails =
    steps.length > 0 &&
    (displayMode === 'summary' || steps.length > 1 || hasTrouble) &&
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
    status === 'killed' ||
    // A failed/cancelled step: open the panel so the outcome is visible
    // without a click — the panel is showing precisely because of it.
    hasTrouble;

  // Verbatim raw-output blocks render only in verbatim mode after at
  // least one step has produced output. We render once the turn is
  // executing or done — during execution the blocks fill in live.
  const showVerbatim =
    displayMode === 'verbatim' &&
    (status === 'executing' || status === 'done' || status === 'killed');

  // The eye toggle (show/hide raw command) only earns its place on
  // summary turns — verbatim turns already show every command in their
  // raw-output blocks, so an eye there would toggle nothing visible.
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
    <article className="mb-8 border-t border-hairline pt-8 first:border-t-0 first:pt-0">
      {/* Intent — the user's request, in tight semibold sans. */}
      <h2
        className="mb-3 text-[16px] font-semibold text-ink leading-snug"
        style={{ letterSpacing: '-0.01em' }}
      >
        {message.userInput}
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

      {/* AI response prose — visible in streaming, done, replied, and
          synthesize-error states. Inter 15px, reveal-smoothed. Only
          rendered for summary mode (verbatim mode has no synthesize
          prose; the raw output blocks below stand in). */}
      {finalResponse.length > 0 && <ProseResponse text={finalResponse} />}

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

      {/* Silent-command backstop. When a running command has gone quiet
          for a while it may be waiting for input — which Vorlox can't
          answer. A calm notice, not an auto-kill: the user decides. */}
      {status === 'executing' && message.stalled && (
        <p className="mt-3 text-[12px] leading-relaxed text-ink-label">
          This has been quiet for a while. If it&rsquo;s waiting for input,
          Vorlox can&rsquo;t answer it — you may want to stop it.
        </p>
      )}

      {/* Stop affordance during execution — a stop icon, quiet until
          hovered. The "Stopped." footer above stays plain text. */}
      {status === 'executing' && (
        <button
          type="button"
          onClick={() => onStop(message.id)}
          aria-label="Stop"
          title="Stop"
          className="mt-2 flex h-6 w-6 items-center justify-center rounded-md text-ink-hint transition-colors hover:bg-surface-subtle hover:text-ink focus:outline-none"
        >
          <StopGlyph />
        </button>
      )}

      {/* Steps list — collapsible. Open while the turn is running so the
          user sees live progress, auto-collapses when status settles to
          done/killed. The user can manually expand a settled turn or
          collapse a running one — DetailsPanel locks in the manual
          choice from that point on. */}
      {showDetails && (
        <DetailsPanel
          label={`${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`}
          desiredOpen={detailsDesiredOpen}
          expandSignal={peekExpandSignal}
          headerRight={
            showPeekToggle ? (
              // The eye IS the show/hide-command control: one icon, no
              // separate text label. A slash through it means the
              // command is currently hidden; clicking reveals it (and
              // expands the panel via the signal bump).
              <button
                type="button"
                onClick={() => {
                  onTogglePeek(message.id);
                  setPeekExpandSignal((n) => n + 1);
                }}
                aria-label={peekEnabled ? 'Hide command' : 'Show command'}
                title={peekEnabled ? 'Hide command' : 'Show command'}
                className={`flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-surface-subtle focus:outline-none ${
                  peekEnabled ? 'text-ink' : 'text-ink-label hover:text-ink'
                }`}
              >
                <EyeGlyph off={!peekEnabled} />
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
  const hasOutput = step.output.length > 0;
  return (
    <div className="overflow-hidden rounded-xl border border-subtle-border bg-surface-subtle">
      {/* Command header — the prompt line, with a copy affordance for the
          output on the right. The "›" is a subtle gray prompt marker —
          terminal-conventional, not an accent. */}
      <div className="flex items-start gap-2 px-3 py-2 font-mono text-[12.5px] font-medium text-ink">
        <span className="shrink-0 select-none text-ink-hint" aria-hidden="true">
          ›
        </span>
        <span className="min-w-0 flex-1 break-all">{step.command}</span>
        {hasOutput && <CopyButton text={step.output} />}
      </div>
      {/* Output — capped height so a huge dump becomes a scroll box
          rather than an endless block that buries the rest of the turn. */}
      {hasOutput && (
        <pre className="max-h-[360px] overflow-y-auto whitespace-pre-wrap border-t border-subtle-border bg-surface-faint px-3 py-2 font-mono text-[12.5px] font-normal leading-relaxed text-ink-body">
          {step.output}
        </pre>
      )}
    </div>
  );
}

// The AI's prose response, with backtick-delimited technical tokens
// (file names, paths, commands) rendered as distinct inline code chips
// instead of literal `backtick` text. Keeps the prose clean — the token
// stands apart on its own tinted chip, no dash-crutch needed.
//
// Only CLOSED backtick pairs become chips. A dangling backtick — which
// happens mid reveal-smoothing, before the closer streams in — stays as
// plain text until its partner arrives, then snaps to a chip.
function ProseResponse({ text }: { text: string }) {
  const segments: { code: boolean; text: string }[] = [];
  const re = /`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      segments.push({ code: false, text: text.slice(last, m.index) });
    }
    segments.push({ code: true, text: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    segments.push({ code: false, text: text.slice(last) });
  }

  return (
    <p className="whitespace-pre-wrap text-[15px] leading-[1.65] text-[#3A3A3A]">
      {segments.map((s, i) =>
        s.code ? (
          <code
            key={i}
            className="rounded-md border-[0.5px] border-subtle-border bg-[#eef1f6] px-1.5 py-0.5 font-mono text-[13px] text-ink"
          >
            {s.text}
          </code>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </p>
  );
}

// Eye glyph for the show/hide-command toggle. `off` draws a slash
// through it — the command is currently hidden.
function EyeGlyph({ off }: { off?: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M1 8s2.6-4.5 7-4.5S15 8 15 8s-2.6 4.5-7 4.5S1 8 1 8z" />
      <circle cx="8" cy="8" r="2" />
      {off && <line x1="2.5" y1="13.5" x2="13.5" y2="2.5" />}
    </svg>
  );
}

// Stop glyph — a rounded square, the universal stop affordance.
function StopGlyph() {
  return (
    <svg
      viewBox="0 0 12 12"
      className="h-2.5 w-2.5"
      fill="currentColor"
      aria-hidden="true"
    >
      <rect x="1.5" y="1.5" width="9" height="9" rx="1.6" />
    </svg>
  );
}
