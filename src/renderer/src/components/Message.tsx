import type { CommandMessage } from '../hooks/useCommands';
import { StatusIndicator } from './StatusIndicator';

interface MessageProps {
  message: CommandMessage;
  onStop: (id: string) => void;
}

// Phase 4 Chunk 2a: minimal rendering only.
// Branches on status; no details panel, no StepRow, no peek toggle, no
// verbatim raw-output panel, no Plan Card. Those land in 2b / 3 / 4 / 5.
//
// Visual hierarchy per turn:
//   [intent in Source Serif 22px]      ← user's natural-language input
//   [optional status indicator]         ← italic Source Serif, gray
//   [optional response prose]           ← Inter 15px, reveal-smoothed
//   [optional error / cd / killed line] ← context-specific footers
export function Message({ message, onStop }: MessageProps) {
  const { status, statusIndicator, finalResponse, errorMessage } = message;

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
          synthesize-error states. Inter 15px, reveal-smoothed. */}
      {finalResponse.length > 0 && (
        <p className="whitespace-pre-wrap text-[15px] leading-[1.65] text-[#3A3A3A]">
          {finalResponse}
        </p>
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

      {/* Killed: footer line. (Stop button itself lives below — Chunk 2b
          attaches it to the steps panel; for now a minimal placeholder.) */}
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
    </article>
  );
}
