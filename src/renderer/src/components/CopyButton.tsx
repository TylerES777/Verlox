import { useState } from 'react';

interface CopyButtonProps {
  // The text written to the clipboard on click.
  text: string;
}

// Small icon-only "copy" affordance for command output. Shows a brief
// checkmark on success, then reverts to the copy glyph. Clipboard
// failures (no permission, etc.) are swallowed — copy is a convenience,
// never load-bearing.
export function CopyButton({ text }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable — no-op.
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? 'Copied' : 'Copy output'}
      title={copied ? 'Copied' : 'Copy output'}
      className={`shrink-0 transition-colors focus:outline-none ${
        copied ? 'text-step-done' : 'text-ink-micro hover:text-ink'
      }`}
    >
      {copied ? <CheckGlyph /> : <CopyGlyph />}
    </button>
  );
}

function CopyGlyph() {
  return (
    <svg
      viewBox="0 0 14 14"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* Front sheet */}
      <rect x="4.5" y="4.5" width="7" height="7" rx="1.4" />
      {/* Back sheet peeking out */}
      <path d="M2.5 9.5V3.9A1.4 1.4 0 0 1 3.9 2.5H9.5" />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg
      viewBox="0 0 14 14"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="2.6,7.6 5.7,10.6 11.4,3.6" />
    </svg>
  );
}
