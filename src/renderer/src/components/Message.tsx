import type { ReactNode } from 'react';
import type { CommandMessage, MessageStep, StepStatus } from '../hooks/useCommands';
import { StatusIndicator } from './StatusIndicator';
import { DetailsPanel } from './DetailsPanel';
import { PlanCard } from './PlanCard';
import { CopyButton } from './CopyButton';

interface MessageProps {
  message: CommandMessage;
  onStop: (id: string) => void;
  // Plan Card actions (Chunk 4). Called when the user clicks Run or
  // Cancel on a paused turn. Resolve the orchestrator's awaited promise
  // inside useCommands.
  onConfirmPlan: (id: string) => void;
  onCancelPlan: (id: string) => void;
}

// One conversation turn.
//
// Outcome text — run summaries, cd results, errors — is wrapped in a
// notification board: it's a status report, not conversation, and reads
// as such. Genuine AI replies (advice, clarifying questions) stay as
// plain conversational prose.
//
// The actual backend process — each raw command and its live output —
// lives behind the eye toggle, which always starts closed. The
// conversation surface stays calm; the detail is one click away.
//
// Visual order per turn:
//   [intent — tight semibold sans]   ← user's natural-language input
//   [status indicator]               ← examining / running / reviewing
//   [reply prose OR outcome board]   ← conversation vs. notification
//   [verbatim output blocks]         ← only when displayMode='verbatim'
//   [Stop button]                    ← only while executing
//   [eye panel: live backend blocks] ← collapsed by default
export function Message({
  message,
  onStop,
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
    plan,
  } = message;

  // Steps that have actually run (or are running) — queued and skipped
  // steps have no command output worth showing as a block.
  const ranSteps = steps.filter(
    (s) => s.status !== 'queued' && s.status !== 'skipped',
  );

  // The eye panel — the live backend view — is offered for summary
  // turns: their prose hides what ran, so the panel is the way in. It's
  // never offered for verbatim turns (their output blocks already show
  // everything) or for turns that never reached execution.
  const showEyePanel =
    displayMode === 'summary' &&
    steps.length > 0 &&
    status !== 'awaiting-confirmation' &&
    status !== 'cancelled-before-run';

  // Verbatim turns render their output blocks inline — the user asked to
  // SEE the raw output, so it isn't tucked behind the eye.
  const showVerbatim =
    displayMode === 'verbatim' &&
    (status === 'executing' || status === 'done' || status === 'killed');

  // A reply turn is conversation — advice, a clarifying question, a
  // decline. Its prose renders bare. Every other finalResponse (a run
  // summary, or the partial summary salvaged on a synthesize error) is a
  // status report and goes in a notification board.
  const responseIsConversation = status === 'replied';

  return (
    <article className="mb-8 border-t border-hairline pt-8 first:border-t-0 first:pt-0">
      {/* Intent — the user's request, in tight semibold sans. */}
      <h2
        className="text-[16px] font-semibold text-ink leading-snug"
        style={{ letterSpacing: '-0.01em' }}
      >
        {message.userInput}
      </h2>

      {/* Status indicator — examining / running / reviewing. Hidden once
          a terminal status is reached. */}
      {statusIndicator !== null && (
        <div className="mt-3">
          <StatusIndicator phase={statusIndicator} />
        </div>
      )}

      {/* Plan Card — only while the orchestrator is paused awaiting
          confirmation. The card itself is the UI surface. */}
      {status === 'awaiting-confirmation' && plan && (
        <div className="mt-3">
          <PlanCard
            plan={plan}
            steps={steps}
            onConfirm={() => onConfirmPlan(message.id)}
            onCancel={() => onCancelPlan(message.id)}
          />
        </div>
      )}

      {/* Cancelled-before-run — the user cancelled the Plan Card. */}
      {status === 'cancelled-before-run' && (
        <NotificationBoard className="mt-3">
          <BoardText>Plan discarded.</BoardText>
        </NotificationBoard>
      )}

      {/* AI response. A reply (advice / question / decline) is
          conversation — bare prose. A run summary is a notification —
          boxed. */}
      {finalResponse.length > 0 &&
        (responseIsConversation ? (
          <div className="mt-3">
            <ProseResponse text={finalResponse} />
          </div>
        ) : (
          <NotificationBoard className="mt-3">
            <ProseResponse text={finalResponse} />
          </NotificationBoard>
        ))}

      {/* Verbatim raw-output blocks — one per step that ran. */}
      {showVerbatim && ranSteps.length > 0 && (
        <div className="mt-3 space-y-3">
          {ranSteps.map((s) => (
            <OutputBlock key={s.index} step={s} />
          ))}
        </div>
      )}

      {/* cd-success — a notification. */}
      {status === 'cd-success' && message.cdResolvedDisplay && (
        <NotificationBoard className="mt-3">
          <BoardText>Switched to {message.cdResolvedDisplay}.</BoardText>
        </NotificationBoard>
      )}

      {/* cd-error / planning-error — a notification, error tone. */}
      {(status === 'cd-error' || status === 'planning-error') && errorMessage && (
        <NotificationBoard variant="error" className="mt-3">
          <BoardText>{errorMessage}</BoardText>
        </NotificationBoard>
      )}

      {/* synthesize-error — the partial summary stays boxed above; the
          error itself follows in its own error-tone board. */}
      {status === 'synthesize-error' && errorMessage && (
        <NotificationBoard variant="error" className="mt-3">
          <BoardText>{errorMessage}</BoardText>
        </NotificationBoard>
      )}

      {/* Killed — a plain status line, deliberately not boxed. */}
      {status === 'killed' && (
        <p className="mt-3 text-[12px] text-ink-micro">Stopped.</p>
      )}

      {/* Silent-command backstop — a calm notice while a running command
          has gone quiet. Plain text, not a board: it's transient. */}
      {status === 'executing' && message.stalled && (
        <p className="mt-3 text-[12px] leading-relaxed text-ink-label">
          This has been quiet for a while. If it&rsquo;s waiting for input,
          Vorlox can&rsquo;t answer it — you may want to stop it.
        </p>
      )}

      {/* Stop affordance during execution — a stop icon, quiet until
          hovered. */}
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

      {/* Eye panel — the live backend view. Always starts closed. Each
          block is a raw command + its real output, accented green when
          the step finished and red when it failed. */}
      {showEyePanel && (
        <DetailsPanel>
          {ranSteps.length > 0 ? (
            <div className="space-y-3">
              {ranSteps.map((s) => (
                <OutputBlock key={s.index} step={s} />
              ))}
            </div>
          ) : (
            <p className="text-[12px] text-ink-micro">Nothing has run yet.</p>
          )}
        </DetailsPanel>
      )}
    </article>
  );
}

// Notification board — the contained surface for a status report (run
// summary, cd result, error). A box, not conversation: it reads as a
// notification at a glance. The error variant gets a soft red wash.
function NotificationBoard({
  variant = 'neutral',
  className = '',
  children,
}: {
  variant?: 'neutral' | 'error';
  className?: string;
  children: ReactNode;
}) {
  const tone =
    variant === 'error'
      ? 'border-step-failed/30 bg-step-failed-tint'
      : 'border-subtle-border bg-surface-subtle';
  return (
    <div className={`rounded-xl border px-3.5 py-2.5 ${tone} ${className}`}>
      {children}
    </div>
  );
}

// Plain board text — for the short single-line notifications.
function BoardText({ children }: { children: ReactNode }) {
  return (
    <p className="text-[14px] leading-relaxed text-ink-body">{children}</p>
  );
}

// One step of the backend process — the raw command and its real output.
// A discrete block; the left edge is accented by status (green when the
// step finished, red when it failed, amber while running) so a glance
// reads the outcome without any "Done" label.
function OutputBlock({ step }: { step: MessageStep }) {
  const hasOutput = step.output.length > 0;
  const accent =
    step.status === 'done'
      ? 'border-l-step-done bg-step-done-tint'
      : step.status === 'failed'
        ? 'border-l-step-failed bg-step-failed-tint'
        : step.status === 'running'
          ? 'border-l-amber bg-surface-subtle'
          : 'border-l-subtle-border bg-surface-subtle';
  return (
    <div
      className={`overflow-hidden rounded-xl border border-subtle-border border-l-[3px] ${accent}`}
    >
      {/* Command header — a status dot, the raw command, a copy
          affordance for the output. */}
      <div className="flex items-start gap-2 px-3 py-2 font-mono text-[12.5px] font-medium text-ink">
        <StepDot status={step.status} />
        <span className="min-w-0 flex-1 break-all">{step.command}</span>
        {hasOutput && <CopyButton text={step.output} />}
      </div>
      {/* Output — capped height so a huge dump becomes a scroll box
          rather than burying the rest of the turn. */}
      {hasOutput && (
        <pre className="max-h-[360px] overflow-y-auto whitespace-pre-wrap border-t border-subtle-border bg-card/60 px-3 py-2 font-mono text-[12.5px] font-normal leading-relaxed text-ink-body">
          {step.output}
        </pre>
      )}
    </div>
  );
}

// Small status dot for an OutputBlock header. Color carries the state;
// the running dot flickers. No glyph — the block's green/red accent and
// the dot together are enough.
function StepDot({ status }: { status: StepStatus }) {
  const base = 'mt-1 h-2 w-2 shrink-0 rounded-full';
  if (status === 'running') return <span className={`${base} bg-amber animate-flicker`} />;
  if (status === 'done') return <span className={`${base} bg-step-done`} />;
  if (status === 'failed') return <span className={`${base} bg-step-failed`} />;
  // cancelled / skipped / queued — a demoted outlined ring.
  return <span className={`${base} border border-ink-hint opacity-60`} />;
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
