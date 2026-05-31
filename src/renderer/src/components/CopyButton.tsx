import { useState } from 'react';
import { Tooltip } from './Tooltip';

interface CopyButtonProps {
  // The text written to the clipboard on click.
  text: string;
  // 'inline' (default) is a bare glyph — used for in-flow copies (e.g.
  // step output) where the button shouldn't claim layout. 'pill' matches
  // the action-row toggles (diagram, eye, pause): a circular bordered
  // chip, the same h-7 w-7 as its siblings.
  variant?: 'inline' | 'pill';
  // Override the labels — e.g. "Copy prompt" on a user prompt vs the
  // default "Copy output". Doesn't affect behaviour.
  label?: string;
}

// Small icon-only "copy" affordance. Shows a brief checkmark on success,
// then reverts to the copy glyph. Clipboard failures (no permission, etc.)
// are swallowed — copy is a convenience, never load-bearing.
export function CopyButton({ text, variant = 'inline', label }: CopyButtonProps) {
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

  const baseLabel = label ?? 'Copy output';
  const inlineClass = `shrink-0 transition-colors focus:outline-none ${
    copied ? 'text-step-done' : 'text-ink-micro hover:text-ink'
  }`;
  const pillClass = `flex h-7 w-7 items-center justify-center rounded-full border border-subtle-border bg-card transition-colors hover:border-ink-hint focus:outline-none ${
    copied ? 'text-step-done' : 'text-ink-label hover:text-ink'
  }`;

  return (
    <Tooltip label={copied ? 'Copied' : baseLabel}>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copied ? 'Copied' : baseLabel}
        className={variant === 'pill' ? pillClass : inlineClass}
      >
        {copied ? <CheckGlyph /> : <CopyGlyph />}
      </button>
    </Tooltip>
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
