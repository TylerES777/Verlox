import { useEffect, useRef } from 'react';

interface TranslationCardProps {
  explanation: string;
  command: string;
  showStopButton: boolean;
  onStop: () => void;
  showButtons: boolean;        // awaiting-confirmation
  onConfirm: () => void;
  onCancel: () => void;
  showCancelledLabel: boolean; // cancelled
}

/**
 * The explanation paragraph + command box + state-specific tail
 * (confirmation buttons, cancelled label, or stop link).
 *
 * Used for: awaiting-confirmation | cancelled | running | exited | killed.
 * Pre-translation states (translating, errors, cd-success, cd-error) render
 * directly in Message.tsx without this component.
 */
export function TranslationCard({
  explanation,
  command,
  showStopButton,
  onStop,
  showButtons,
  onConfirm,
  onCancel,
  showCancelledLabel,
}: TranslationCardProps) {
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (showButtons) {
      cancelButtonRef.current?.focus();
    }
  }, [showButtons]);

  return (
    <>
      {explanation && (
        <p className="mb-3 text-[14px] leading-relaxed text-gray-700">{explanation}</p>
      )}

      <div className="flex items-start gap-3">
        <pre className="m-0 flex-1 whitespace-pre-wrap break-words rounded-lg bg-[#F5F5F2] px-3 py-2 font-mono text-[14px] text-gray-700">
          {command}
        </pre>
        {showStopButton && (
          <button
            type="button"
            onClick={onStop}
            className="mt-2 shrink-0 text-[12px] text-gray-400 hover:text-gray-600 focus:outline-none"
          >
            stop
          </button>
        )}
      </div>

      {showButtons && (
        <div className="mt-3 flex flex-col items-stretch gap-2">
          <p className="text-[14px] text-gray-700">Run this command?</p>
          <div className="flex gap-2">
            <button
              ref={cancelButtonRef}
              type="button"
              onClick={onCancel}
              className="rounded-md bg-gray-200 px-3 py-1.5 text-[14px] text-gray-700 hover:bg-gray-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className="rounded-md bg-gray-700 px-3 py-1.5 text-[14px] text-off-white hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
            >
              Run
            </button>
          </div>
        </div>
      )}

      {showCancelledLabel && (
        <div className="mt-3 text-[12px] text-gray-400">cancelled</div>
      )}
    </>
  );
}
