import type { CommandMessage, MessageStep } from '../hooks/useCommands';
import { StatusIndicator } from './StatusIndicator';
import { StepRow } from './StepRow';
import { DetailsPanel } from './DetailsPanel';

interface MessageProps {
  message: CommandMessage;
  onStop: (id: string) => void;
}

// Phase 4 Chunk 2b: adds StepRow list (in a collapsible DetailsPanel) and
// the verbatim raw-output block. Chunk 3 adds the peek toggle and raw
// command access; Chunks 4–5 add Plan Card and footgun review.
//
// Visual hierarchy per turn:
//   [intent in Source Serif 22px]      ← user's natural-language input
//   [optional status indicator]         ← italic Source Serif, gray
//   [optional response prose]           ← Inter 15px, reveal-smoothed
//   [verbatim raw output blocks]        ← only when displayMode='verbatim'
//   [optional error / cd / killed line] ← context-specific footers
//   [Stop button]                       ← only while executing
//   [details panel: steps]              ← collapsible, default open
export function Message({ message, onStop }: MessageProps) {
  const {
    status,
    statusIndicator,
    finalResponse,
    errorMessage,
    steps,
    displayMode,
  } = message;

  // The details panel becomes visible the moment we have any steps to
  // show. Hidden for refusal / cd / planning-error turns where steps
  // never get initialized.
  const showDetails = steps.length > 0;

  // Auto-open while the turn is in motion, auto-collapse once it
  // settles. The DetailsPanel honours this UNTIL the user manually
  // toggles — after that, the user's choice wins for the rest of the
  // message's life.
  const detailsDesiredOpen =
    status === 'executing' ||
    status === 'synthesizing' ||
    status === 'streaming';

  // Verbatim raw-output blocks render only in verbatim mode after at
  // least one step has produced output. We render once the turn is
  // executing or done — during execution the blocks fill in live.
  const showVerbatim =
    displayMode === 'verbatim' &&
    (status === 'executing' || status === 'done' || status === 'killed');

  return (
    <article className="mb-12">
      <h2
        className="mb-3 font-serif text-[22px] font-normal text-ink"
        style={{ letterSpacing: '-0.005em' }}
      >
        {message.userInput}
      </h2>

      {/* Status indicator — visible during translating / executing /
          synthesizing phases. Hidden as soon as the response starts
          streaming or any terminal status is reached. */}
      {statusIndicator !== null && <StatusIndicator phase={statusIndicator} />}

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
        >
          <div className="space-y-1">
            {steps.map((s) => (
              <StepRow key={s.index} step={s} />
            ))}
          </div>
        </DetailsPanel>
      )}
    </article>
  );
}

// Per-step raw output block for verbatim mode. The left border is a
// 2px hairline that visually anchors the command-and-output pair so
// adjacent step blocks read as separate units without needing a card.
function VerbatimBlock({ step }: { step: MessageStep }) {
  return (
    <div className="border-l-2 border-hairline pl-3">
      <div className="font-mono text-[13px] font-medium text-ink leading-relaxed">
        {step.command}
      </div>
      {step.output.length > 0 && (
        <pre className="font-mono text-[13px] font-normal text-ink-body whitespace-pre-wrap leading-relaxed mt-1">
          {step.output}
        </pre>
      )}
    </div>
  );
}
