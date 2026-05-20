import type { ReactNode } from 'react';
import type { DirListing } from '@shared/types';
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
    listing,
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

      {/* Verbatim raw-output blocks — one per step that ran. When the
          planner asked for a dedicated UI (outputUi), swap the generic
          block for the structured panel instead. */}
      {showVerbatim && ranSteps.length > 0 && (
        <div className="mt-3 space-y-3">
          {plan?.outputUi === 'ping' ? (
            <PingBoard step={ranSteps[0]} />
          ) : plan?.outputUi === 'git-status' ? (
            <GitStatusBoard step={ranSteps[0]} />
          ) : (
            ranSteps.map((s) => <OutputBlock key={s.index} step={s} />)
          )}
        </div>
      )}

      {/* cd-success — a notification. */}
      {status === 'cd-success' && message.cdResolvedDisplay && (
        <NotificationBoard className="mt-3">
          <BoardText>Switched to {message.cdResolvedDisplay}.</BoardText>
        </NotificationBoard>
      )}

      {/* list-success — Vorlox's built-in folder browser. No shell ran;
          the contents come from the directory API directly. */}
      {status === 'list-success' && listing && (
        <div className="mt-3">
          <FileListingBoard listing={listing} />
        </div>
      )}

      {/* cd-error / list-error / planning-error — a notification, error tone. */}
      {(status === 'cd-error' ||
        status === 'list-error' ||
        status === 'planning-error') &&
        errorMessage && (
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

// Built-in folder browser — what the user sees when they ask "list the
// files." No shell command ran; this is Vorlox's own directory view.
// Folder header → resolved path + count. Rows → icon + name, folders
// first. A huge folder caps at max-height and becomes a scroll box.
function FileListingBoard({ listing }: { listing: DirListing }) {
  const total = listing.entries.length;
  const folderCount = listing.entries.filter((e) => e.isDirectory).length;
  const fileCount = total - folderCount;

  return (
    <div className="overflow-hidden rounded-xl border border-subtle-border bg-surface-subtle">
      <div className="flex items-center gap-2 border-b border-subtle-border px-3.5 py-2 font-mono text-[12.5px] text-ink">
        <FolderGlyph open />
        <span className="min-w-0 flex-1 truncate">{listing.path}</span>
        <span className="shrink-0 text-[11px] text-ink-micro">
          {total === 0
            ? 'empty'
            : `${folderCount} folder${folderCount === 1 ? '' : 's'}, ${fileCount} file${fileCount === 1 ? '' : 's'}`}
        </span>
      </div>
      {total === 0 ? (
        <p className="px-3.5 py-3 text-[13px] text-ink-label">Empty folder.</p>
      ) : (
        <ul className="max-h-[360px] overflow-y-auto divide-y divide-hairline">
          {listing.entries.map((e) => (
            <li
              key={e.path}
              className="flex items-center gap-2 px-3.5 py-1.5 text-[13.5px] text-ink-body"
            >
              {e.isDirectory ? (
                <FolderGlyph className="text-ink-label" />
              ) : (
                <FileGlyph className="text-ink-hint" />
              )}
              <span className="min-w-0 flex-1 truncate">{e.name}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FolderGlyph({ className = '', open = false }: { className?: string; open?: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`h-3.5 w-3.5 shrink-0 ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {open ? (
        <path d="M2 5.5V4a1 1 0 0 1 1-1h3.4l1.5 1.5H13a1 1 0 0 1 1 1V6H3l-1 6.5A.5.5 0 0 0 2.5 13h10.4a1 1 0 0 0 1-.85L14.7 7H4.1a1 1 0 0 0-1 .85L2 13.5" />
      ) : (
        <path d="M2 4.5A1 1 0 0 1 3 3.5h3.4l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.5z" />
      )}
    </svg>
  );
}

// Live ping panel — replaces the raw monospace block when the planner
// sets outputUi="ping". Same visual language as the folder listing
// board: subtle bordered card, mono header with target + meta count on
// the right, calm rows with secondary info trailing. The parser handles
// both Windows ("Reply from X: bytes=32 time<1ms TTL=128") and POSIX
// ("64 bytes from X: icmp_seq=1 ttl=64 time=0.045 ms") output; anything
// else (name lookup errors, unreachable) falls back to a raw block.
function PingBoard({ step }: { step: MessageStep }) {
  const { target, events, summary } = parsePingOutput(step.output);
  const running = step.status === 'running';
  const replyCount = events.filter((e) => e.kind === 'reply').length;
  const timeoutCount = events.filter((e) => e.kind === 'timeout').length;

  // Target label: prefer what the ping output announced; fall back to
  // pulling the last bare token of the command line ("ping -n 4 X" → "X").
  const headerTarget = target ?? extractPingTarget(step.command) ?? '(unknown)';

  // Right-aligned meta in the header. Live state shows "listening…";
  // a settled summary shows the loss-aware tally; otherwise a running
  // tally of what's accumulated so far.
  let headerMeta: string;
  if (running) {
    headerMeta = 'listening…';
  } else if (summary) {
    headerMeta = `${summary.received}/${summary.sent} received · ${summary.lossPct ?? 0}% loss`;
  } else if (replyCount + timeoutCount > 0) {
    headerMeta = `${replyCount} received · ${timeoutCount} timed out`;
  } else {
    headerMeta = '';
  }

  return (
    <div className="overflow-hidden rounded-xl border border-subtle-border bg-surface-subtle">
      <div className="flex items-center gap-2 border-b border-subtle-border px-3.5 py-2 font-mono text-[12.5px] text-ink">
        <PingGlyph className="text-ink-label" />
        <span className="min-w-0 flex-1 truncate">ping {headerTarget}</span>
        {headerMeta && (
          <span className="shrink-0 text-[11px] text-ink-micro">{headerMeta}</span>
        )}
      </div>

      {events.length === 0 ? (
        running ? (
          <p className="px-3.5 py-3 text-[13px] text-ink-label">
            Waiting for replies…
          </p>
        ) : null
      ) : (
        <ul className="max-h-[360px] overflow-y-auto divide-y divide-hairline">
          {events.map((e, i) => (
            <PingRow key={i} event={e} />
          ))}
        </ul>
      )}

      {/* Fallback: the run produced no parseable reply lines but did
          finish (or fail). Show the raw output so the user still sees
          why — name-lookup errors, target-unreachable, etc. */}
      {!running && events.length === 0 && step.output.length > 0 && (
        <pre className="max-h-[200px] overflow-y-auto whitespace-pre-wrap border-t border-subtle-border bg-card px-3 py-2 font-mono text-[12.5px] leading-relaxed text-ink-body">
          {step.output}
        </pre>
      )}
    </div>
  );
}

function PingRow({ event }: { event: PingEvent }) {
  if (event.kind === 'timeout') {
    return (
      <li className="flex items-center gap-2 px-3.5 py-1.5 text-[13.5px] text-ink-body">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-step-failed" />
        <span className="min-w-0 flex-1 truncate">Request timed out</span>
        {event.seq != null && (
          <span className="shrink-0 text-[11px] text-ink-micro">#{event.seq}</span>
        )}
      </li>
    );
  }
  return (
    <li className="flex items-center gap-2 px-3.5 py-1.5 text-[13.5px] text-ink-body">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-step-done" />
      <span className="min-w-0 flex-1 truncate">
        Reply{event.seq != null ? ` #${event.seq}` : ''}
      </span>
      {event.time != null && (
        <span className="shrink-0 text-[12px] text-ink-label">
          {event.time} ms
        </span>
      )}
      {event.ttl != null && (
        <span className="shrink-0 text-[11px] text-ink-micro">
          TTL {event.ttl}
        </span>
      )}
    </li>
  );
}

// Live git-status panel — replaces the raw monospace block when the
// planner sets outputUi="git-status". Parses the stable porcelain v1
// format (`git status --porcelain=v1 --branch`) and groups entries
// into Staged, Modified, Untracked, and Conflict sections. Same
// surface as the folder-listing and ping boards. If parsing fails or
// the step exits non-zero (e.g. not a git repo) the raw output falls
// through as a trailing block.
function GitStatusBoard({ step }: { step: MessageStep }) {
  const parsed = parseGitStatus(step.output);
  const running = step.status === 'running';
  const failed = step.status === 'failed';

  // Group entries into the four visible sections. A file with index
  // changes (X) goes to Staged even if it ALSO has worktree changes —
  // the 2-char code on the row tells the full story.
  const sections: { label: string; entries: GitStatusEntry[] }[] = [
    { label: 'Staged', entries: [] },
    { label: 'Modified', entries: [] },
    { label: 'Untracked', entries: [] },
    { label: 'Conflicts', entries: [] },
  ];
  for (const e of parsed.entries) {
    const cat = categorizeGitEntry(e);
    const idx = cat === 'staged' ? 0 : cat === 'modified' ? 1 : cat === 'untracked' ? 2 : 3;
    sections[idx].entries.push(e);
  }

  const totalEntries = parsed.entries.length;
  const isClean = !failed && totalEntries === 0 && !running;

  // Header right slot — branch + ahead/behind, or running/failed cues.
  const headerMeta = buildGitStatusMeta(parsed, running, failed);

  return (
    <div className="overflow-hidden rounded-xl border border-subtle-border bg-surface-subtle">
      <div className="flex items-center gap-2 border-b border-subtle-border px-3.5 py-2 font-mono text-[12.5px] text-ink">
        <GitGlyph className="text-ink-label" />
        <span className="min-w-0 flex-1 truncate">git status</span>
        {headerMeta && (
          <span className="shrink-0 text-[11px] text-ink-micro">{headerMeta}</span>
        )}
      </div>

      {isClean ? (
        <p className="px-3.5 py-3 text-[13px] text-ink-label">
          Working tree clean.
        </p>
      ) : totalEntries > 0 ? (
        <div className="max-h-[440px] overflow-y-auto">
          {sections.map((section) =>
            section.entries.length === 0 ? null : (
              <section key={section.label}>
                <div className="px-3.5 pt-2.5 pb-1 text-[11px] uppercase tracking-[0.06em] text-ink-micro">
                  {section.label}{' '}
                  <span className="text-ink-hint">({section.entries.length})</span>
                </div>
                <ul className="divide-y divide-hairline">
                  {section.entries.map((e, i) => (
                    <GitStatusRow key={`${e.path}::${i}`} entry={e} />
                  ))}
                </ul>
              </section>
            ),
          )}
        </div>
      ) : running ? (
        <p className="px-3.5 py-3 text-[13px] text-ink-label">Reading repo…</p>
      ) : null}

      {/* Fallback: command failed or produced unparseable output (e.g.
          "fatal: not a git repository"). Show the raw text so the user
          knows what happened. */}
      {!running && totalEntries === 0 && !isClean && step.output.length > 0 && (
        <pre className="max-h-[200px] overflow-y-auto whitespace-pre-wrap border-t border-subtle-border bg-card px-3 py-2 font-mono text-[12.5px] leading-relaxed text-ink-body">
          {step.output}
        </pre>
      )}
    </div>
  );
}

function GitStatusRow({ entry }: { entry: GitStatusEntry }) {
  return (
    <li className="flex items-center gap-2 px-3.5 py-1.5 text-[13.5px] text-ink-body">
      <span className="shrink-0 w-7 font-mono text-[12px] text-ink-label">
        {gitCodeLabel(entry.code)}
      </span>
      <span className="min-w-0 flex-1 truncate">
        {entry.oldPath ? (
          <>
            <span className="text-ink-label">{entry.oldPath}</span>
            <span className="px-1 text-ink-micro">→</span>
            <span>{entry.path}</span>
          </>
        ) : (
          entry.path
        )}
      </span>
    </li>
  );
}

// Pretty 2-char code: render an unmodified slot as "·" so the badge
// reads cleanly (" M" → "·M", "M " → "M·"). "??" → "?" (a single char
// for untracked — the section label already says "Untracked").
function gitCodeLabel(code: string): string {
  if (code === '??') return '?';
  const a = code[0] === ' ' ? '·' : code[0];
  const b = code[1] === ' ' ? '·' : code[1];
  return `${a}${b}`;
}

function categorizeGitEntry(
  e: GitStatusEntry,
): 'staged' | 'modified' | 'untracked' | 'conflict' {
  if (e.code === '??') return 'untracked';
  // Any U in either slot, or symmetrical AA / DD, is a merge conflict.
  if (
    e.indexStatus === 'U' ||
    e.worktreeStatus === 'U' ||
    e.code === 'AA' ||
    e.code === 'DD'
  ) {
    return 'conflict';
  }
  // Index has a non-space, non-? char → staged (even if worktree also
  // dirty; the row's code shows both letters).
  if (e.indexStatus !== ' ' && e.indexStatus !== '?') return 'staged';
  return 'modified';
}

interface GitStatusEntry {
  // Raw 2-char porcelain code (e.g. " M", "MM", "??", "R ").
  code: string;
  // First char of the code — the index status.
  indexStatus: string;
  // Second char of the code — the worktree status.
  worktreeStatus: string;
  // The (new) path for this entry. Renames/copies put the old name in
  // `oldPath` and the new name here.
  path: string;
  oldPath: string | null;
}

interface GitStatusParseResult {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  detached: boolean;
  entries: GitStatusEntry[];
}

function parseGitStatus(text: string): GitStatusParseResult {
  const result: GitStatusParseResult = {
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    detached: false,
    entries: [],
  };
  if (text.length === 0) return result;

  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.length === 0) continue;

    // Branch line: "## main...origin/main [ahead 1, behind 2]" or
    // "## main" or "## HEAD (no branch)".
    if (rawLine.startsWith('## ')) {
      const body = rawLine.slice(3);
      if (body.startsWith('HEAD (no branch)')) {
        result.detached = true;
        continue;
      }
      const bracketIdx = body.indexOf(' [');
      const branchPart =
        bracketIdx >= 0 ? body.slice(0, bracketIdx) : body.trimEnd();
      const bracketPart =
        bracketIdx >= 0
          ? body.slice(bracketIdx + 2, body.lastIndexOf(']'))
          : '';

      const dotsIdx = branchPart.indexOf('...');
      if (dotsIdx >= 0) {
        result.branch = branchPart.slice(0, dotsIdx);
        result.upstream = branchPart.slice(dotsIdx + 3);
      } else {
        result.branch = branchPart;
      }

      if (bracketPart) {
        const aheadMatch = /ahead (\d+)/.exec(bracketPart);
        const behindMatch = /behind (\d+)/.exec(bracketPart);
        if (aheadMatch) result.ahead = parseInt(aheadMatch[1], 10);
        if (behindMatch) result.behind = parseInt(behindMatch[1], 10);
      }
      continue;
    }

    // Entry: "XY path" — exactly 2 status chars, a space, then the path.
    if (rawLine.length < 4) continue;
    const code = rawLine.slice(0, 2);
    let path = rawLine.slice(3);
    let oldPath: string | null = null;
    // Renames / copies show "old -> new" in the path field.
    if (code[0] === 'R' || code[0] === 'C') {
      const arrowIdx = path.indexOf(' -> ');
      if (arrowIdx >= 0) {
        oldPath = path.slice(0, arrowIdx);
        path = path.slice(arrowIdx + 4);
      }
    }
    result.entries.push({
      code,
      indexStatus: code[0],
      worktreeStatus: code[1],
      path,
      oldPath,
    });
  }
  return result;
}

function buildGitStatusMeta(
  parsed: GitStatusParseResult,
  running: boolean,
  failed: boolean,
): string {
  if (running) return 'reading…';
  if (failed && parsed.entries.length === 0 && !parsed.branch) return 'failed';
  if (parsed.detached) return '(detached HEAD)';
  if (!parsed.branch) return '';
  const arrows: string[] = [];
  if (parsed.ahead > 0) arrows.push(`↑${parsed.ahead}`);
  if (parsed.behind > 0) arrows.push(`↓${parsed.behind}`);
  return arrows.length > 0
    ? `${parsed.branch} · ${arrows.join(' ')}`
    : parsed.branch;
}

function GitGlyph({ className = '' }: { className?: string }) {
  // Minimal "branch" glyph — two nodes joined by a curve, calm sans
  // weight so it sits with the folder / file / ping glyphs.
  return (
    <svg
      viewBox="0 0 16 16"
      className={`h-3.5 w-3.5 shrink-0 ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="4" cy="3.5" r="1.4" />
      <circle cx="4" cy="12.5" r="1.4" />
      <circle cx="12" cy="6" r="1.4" />
      <path d="M4 5v6" />
      <path d="M4 8.5C4 7 6 6 8 6h2.6" />
    </svg>
  );
}

function PingGlyph({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`h-3.5 w-3.5 shrink-0 ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 9.5a7 7 0 0 1 11 0" />
      <path d="M5 11.5a3.5 3.5 0 0 1 6 0" />
      <circle cx="8" cy="13" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

// One event from a parsed ping output stream — a reply or a timeout,
// in the order they appeared.
type PingEvent =
  | {
      kind: 'reply';
      seq: number | null;
      time: number | null; // ms
      ttl: number | null;
    }
  | { kind: 'timeout'; seq: number | null };

interface PingParseResult {
  // Whatever the ping header announced as its target ("Pinging X…",
  // "PING X (...)"). Null until the first line streams in.
  target: string | null;
  events: PingEvent[];
  summary: {
    sent: number;
    received: number;
    lost: number;
    lossPct: number | null;
  } | null;
}

function parsePingOutput(text: string): PingParseResult {
  const result: PingParseResult = { target: null, events: [], summary: null };
  if (text.length === 0) return result;

  let replySeqCounter = 0;
  let timeoutSeqCounter = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    // Windows / POSIX header lines — extract target.
    if (result.target === null) {
      const win = /^Pinging\s+(\S+)/i.exec(line);
      if (win) {
        result.target = win[1];
        continue;
      }
      const posix = /^PING\s+(\S+)/i.exec(line);
      if (posix) {
        result.target = posix[1];
        continue;
      }
    }

    // Windows reply: "Reply from X: bytes=N time<1ms TTL=N" / "time=Nms".
    const winReply =
      /Reply from\s+\S+:\s*bytes=(\d+)\s*time[=<](\d+)ms\s*TTL=(\d+)/i.exec(line);
    if (winReply) {
      replySeqCounter += 1;
      result.events.push({
        kind: 'reply',
        seq: replySeqCounter,
        time: parseInt(winReply[2], 10),
        ttl: parseInt(winReply[3], 10),
      });
      continue;
    }

    // POSIX reply: "64 bytes from X: icmp_seq=N ttl=N time=N ms".
    const posixReply =
      /(\d+)\s+bytes from .+?icmp_seq=(\d+)\s+ttl=(\d+)\s+time=([\d.]+)\s*ms/i.exec(
        line,
      );
    if (posixReply) {
      const seq = parseInt(posixReply[2], 10);
      result.events.push({
        kind: 'reply',
        seq: Number.isFinite(seq) ? seq : ++replySeqCounter,
        time: parseFloat(posixReply[4]),
        ttl: parseInt(posixReply[3], 10),
      });
      replySeqCounter = Math.max(replySeqCounter, seq);
      continue;
    }

    // Windows timeout.
    if (/Request timed out\./i.test(line)) {
      timeoutSeqCounter += 1;
      result.events.push({ kind: 'timeout', seq: timeoutSeqCounter });
      continue;
    }

    // Windows summary: "Packets: Sent = N, Received = N, Lost = N (P% loss),"
    const winSummary =
      /Sent\s*=\s*(\d+).*?Received\s*=\s*(\d+).*?Lost\s*=\s*(\d+)\s*\((\d+)%\s*loss\)/i.exec(
        line,
      );
    if (winSummary) {
      result.summary = {
        sent: parseInt(winSummary[1], 10),
        received: parseInt(winSummary[2], 10),
        lost: parseInt(winSummary[3], 10),
        lossPct: parseInt(winSummary[4], 10),
      };
      continue;
    }

    // POSIX summary: "N packets transmitted, N received, P% packet loss, ..."
    const posixSummary =
      /(\d+)\s+packets transmitted,\s*(\d+)\s+(?:packets\s+)?received,\s*(?:\+\d+\s+errors,\s*)?(\d+)%\s+packet loss/i.exec(
        line,
      );
    if (posixSummary) {
      const sent = parseInt(posixSummary[1], 10);
      const received = parseInt(posixSummary[2], 10);
      const pct = parseInt(posixSummary[3], 10);
      result.summary = {
        sent,
        received,
        lost: sent - received,
        lossPct: pct,
      };
      continue;
    }
  }

  return result;
}

// Last whitespace-delimited token of the planned command — for "ping -n
// 4 google.com" returns "google.com". Best-effort fallback when the
// output header hasn't streamed in yet (or never does).
function extractPingTarget(command: string): string | null {
  const tokens = command.trim().split(/\s+/);
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const t = tokens[i];
    if (t.length === 0) continue;
    if (t.startsWith('-')) continue;
    return t;
  }
  return null;
}

function FileGlyph({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`h-3.5 w-3.5 shrink-0 ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 2.5h5.5L13 6v7a.5.5 0 0 1-.5.5h-8.5A.5.5 0 0 1 3.5 13V3a.5.5 0 0 1 .5-.5z" />
      <path d="M9.5 2.5V6H13" />
    </svg>
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
