import type { CommandMessage } from '../hooks/useCommands';
import { TranslationCard } from './TranslationCard';

interface MessageProps {
  message: CommandMessage;
  onStop: (id: string) => void;
  onConfirm: (id: string) => void;
  onCancel: (id: string) => void;
}

function UserInputEcho({ text }: { text: string }) {
  return <p className="mb-2 text-[13px] leading-relaxed text-gray-500">{text}</p>;
}

function OutputBlock({ output }: { output: string }) {
  if (output.length === 0) return null;
  return (
    <pre className="m-0 mt-3 whitespace-pre-wrap break-words font-mono text-[13px] leading-[1.6] text-gray-600">
      {output}
    </pre>
  );
}

export function Message({ message, onStop, onConfirm, onCancel }: MessageProps) {
  // ── Pre-translation states render directly (no command, no output) ────────

  if (message.status === 'translating') {
    return (
      <div className="mb-6">
        <UserInputEcho text={message.userInput} />
        <div className="text-[13px] text-gray-400">…</div>
      </div>
    );
  }

  if (message.status === 'translation-error') {
    return (
      <div className="mb-6">
        <UserInputEcho text={message.userInput} />
        <p className="text-[14px] leading-relaxed text-gray-500">
          {message.errorMessage ?? 'Something went wrong. Please try again.'}
        </p>
      </div>
    );
  }

  // The model declined to translate (gibberish / harmful / too ambiguous).
  // The model's calm refusal text lives in `explanation`. No command box,
  // no buttons — there's nothing to run.
  if (message.status === 'refused') {
    return (
      <div className="mb-6">
        <UserInputEcho text={message.userInput} />
        <p className="text-[14px] leading-relaxed text-gray-700">
          {message.explanation}
        </p>
      </div>
    );
  }

  if (message.status === 'cd-success') {
    return (
      <div className="mb-6">
        <UserInputEcho text={message.userInput} />
        <p className="text-[14px] leading-relaxed text-gray-700">
          Switched to {message.cdResolvedDisplay ?? message.cdTarget ?? '…'}.
        </p>
      </div>
    );
  }

  if (message.status === 'cd-error') {
    return (
      <div className="mb-6">
        <UserInputEcho text={message.userInput} />
        <p className="text-[14px] leading-relaxed text-gray-500">
          {message.errorMessage ?? "Couldn't find that folder. Could you double-check the path?"}
        </p>
      </div>
    );
  }

  // ── awaiting-confirmation | cancelled | running | exited | killed ─────────

  const commandText = message.command.length > 0 ? message.command : message.proposedCommand;
  const showOutput =
    message.status === 'running' ||
    message.status === 'exited' ||
    message.status === 'killed';

  return (
    <div className="mb-6">
      <UserInputEcho text={message.userInput} />

      <TranslationCard
        explanation={message.explanation}
        command={commandText}
        showStopButton={message.status === 'running'}
        onStop={() => onStop(message.id)}
        showButtons={message.status === 'awaiting-confirmation'}
        onConfirm={() => onConfirm(message.id)}
        onCancel={() => onCancel(message.id)}
        showCancelledLabel={message.status === 'cancelled'}
      />

      {showOutput && <OutputBlock output={message.output} />}

      {message.status === 'killed' && (
        <div className="mt-3 text-[12px] text-gray-400">stopped</div>
      )}

      {message.status === 'exited' && message.finalExplanation.length > 0 && (
        <p className="mt-3 whitespace-pre-wrap text-[14px] leading-relaxed text-gray-500">
          {message.finalExplanation}
        </p>
      )}

      {/* Fallback signal: only shown if /api/explain itself failed.
          Without an explanation, the user would otherwise see no signal that
          the command finished — this is the quiet floor. */}
      {message.status === 'exited' && message.explanationStatus === 'error' && (
        <div className="mt-3 text-[12px] text-gray-400">
          exited with code {message.exitCode ?? 0}
        </div>
      )}
    </div>
  );
}
