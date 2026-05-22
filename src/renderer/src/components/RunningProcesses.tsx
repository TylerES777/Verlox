import { useEffect, useState } from 'react';
import {
  readProcess,
  registerProcess,
  removeProcess,
  useRunningProcesses,
  type ProcessStatus,
  type RunningProcess,
} from '../hooks/useRunningProcesses';
import type { ConversationTab } from './TabBar';

interface RunningProcessesProps {
  tabs: ConversationTab[];
  // Activate a conversation tab — used when the user clicks a
  // process row's source-conversation label.
  onJump: (conversationId: string) => void;
  // Paste a pre-filled prompt into the active conversation's input.
  // Used by the "ask Verlox why" button on a failed process so the
  // AI gets context about what crashed without the user having to
  // retype it.
  onAskWhy: (conversationId: string, prompt: string) => void;
}

// Matches the pane-out keyframe duration in tailwind.config.js. Keep
// in sync — when the list empties, we keep the component mounted for
// this long so the fade-out can play before we unmount. A 20ms guard
// past the keyframe duration ensures the final frame paints before
// React tears the DOM down (otherwise the last 1-2 frames clip and
// the pane reads as popping out rather than dissolving).
const EXIT_ANIMATION_MS = 440;

// Live processes pane — the surface below the Timeline. Lists every
// long-lived shell process Verlox has running (dev servers, watchers,
// infinite pings) plus recently-exited ones (kept around briefly so
// the user can hit Restart on a crash without it vanishing). Hidden
// entirely when nothing is running; fades in on first registration and
// fades out + collapses when the registry empties.
export function RunningProcesses({
  tabs,
  onJump,
  onAskWhy,
}: RunningProcessesProps) {
  const processes = useRunningProcesses();
  const hasProcesses = processes.length > 0;

  // Two-phase visibility so the unmount can play its fade. mounted is
  // the "is the component in the DOM" gate; visible is "should it be
  // shown right now" — drives the in/out animation classes. When the
  // last process exits, visible flips to false (fade-out plays), then
  // a timer drops mounted and the pane is truly gone.
  const [mounted, setMounted] = useState(hasProcesses);
  const [visible, setVisible] = useState(hasProcesses);

  useEffect(() => {
    if (hasProcesses) {
      setMounted(true);
      // Defer the visible flip by one frame so the from-state of the
      // pane-in keyframe applies before the to-state — otherwise the
      // browser collapses the transition and the pane just pops in.
      const raf = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(raf);
    }
    setVisible(false);
    const timer = window.setTimeout(() => setMounted(false), EXIT_ANIMATION_MS);
    return () => window.clearTimeout(timer);
  }, [hasProcesses]);

  if (!mounted) return null;

  const tabsById = new Map<string, ConversationTab>();
  for (const tab of tabs) tabsById.set(tab.id, tab);

  // Outer board — the "frame" that holds the header strip. Tinted
  // muted grey so the inner white content area can sit ON TOP of it
  // and read as a distinct, brighter surface (the "KEY METRICS"
  // mockup pattern: tinted top strip, white inset content card).
  const boardStyle: React.CSSProperties = {
    background:
      'linear-gradient(180deg, rgba(244,245,248,0.95) 0%, rgba(240,242,246,0.95) 100%)',
    backdropFilter: 'blur(12px) saturate(140%)',
    WebkitBackdropFilter: 'blur(12px) saturate(140%)',
  };

  // Inner content surface — bright white card inset within the board,
  // sitting BELOW the header strip. The inset top shadow gives it
  // that "lifted out of the frame" feel from the mock without needing
  // a hard divider line.
  const contentStyle: React.CSSProperties = {
    background:
      'linear-gradient(180deg, #FFFFFF 0%, #FDFEFE 100%)',
    boxShadow:
      '0 1px 0 rgba(255,255,255,0.9) inset, 0 1px 2px rgba(16,24,40,0.04)',
  };

  return (
    <div
      className={`flex h-full flex-col p-5 ${
        visible ? 'animate-pane-in' : 'animate-pane-out'
      }`}
    >
      {/* Outer board — rounded, tinted "frame" that holds the header
          strip at top and the white content card below. The breathing
          shadow lives on the frame so the whole pane reads as one
          ambient surface. */}
      <div
        className="group relative flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-subtle-border animate-pane-breath"
        style={boardStyle}
      >
        {/* Top-edge highlight — 1px white sheen along the inside of
            the frame's top edge. Sells the lifted look. */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/85 to-transparent"
          aria-hidden="true"
        />

        {/* Header strip — sits directly on the tinted frame, no
            divider. The uppercase tracked label + tint contrast
            against the bright inner card below is the separation. */}
        <div className="relative flex shrink-0 items-center justify-between px-5 pt-3 pb-2.5">
          <div className="flex items-center gap-2">
            <span
              className="h-1.5 w-1.5 rounded-full animate-flicker"
              style={{
                background: 'linear-gradient(135deg, #56C988 0%, #1E8048 100%)',
                boxShadow:
                  'inset 0 0.5px 0 rgba(255,255,255,0.45), 0 0 6px rgba(40,160,90,0.55)',
              }}
              aria-hidden="true"
            />
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-label">
              Running
            </h2>
          </div>
          <span className="text-[10.5px] tabular-nums text-ink-micro">
            {processes.length}{' '}
            {processes.length === 1 ? 'process' : 'processes'}
          </span>
        </div>

        {/* Inner content card — bright white, inset below the header
            strip. Holds the scrollable process list. The brighter
            surface against the tinted frame above creates the band /
            content contrast from the mock. */}
        <div
          className="relative mx-2 mb-2 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-subtle-border/70"
          style={contentStyle}
        >
          <ul
            className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2.5
                       [&::-webkit-scrollbar]:w-1.5
                       [&::-webkit-scrollbar-track]:bg-transparent
                       [&::-webkit-scrollbar-thumb]:rounded-full
                       [&::-webkit-scrollbar-thumb]:bg-transparent
                       [&::-webkit-scrollbar-thumb]:transition-colors
                       group-hover:[&::-webkit-scrollbar-thumb]:bg-black/15
                       hover:[&::-webkit-scrollbar-thumb]:bg-black/25"
          >
            {processes.map((p) => (
              <ProcessRow
                key={p.stepId}
                process={p}
                tabTitle={tabsById.get(p.conversationId)?.title ?? 'Conversation'}
                onJump={onJump}
                onAskWhy={onAskWhy}
              />
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function ProcessRow({
  process,
  tabTitle,
  onJump,
  onAskWhy,
}: {
  process: RunningProcess;
  tabTitle: string;
  onJump: (conversationId: string) => void;
  onAskWhy: (conversationId: string, prompt: string) => void;
}) {
  const isRunning = process.status === 'running';
  const isFailed = process.status === 'failed';

  // Row styling — faint warm tint so each row reads as a distinct
  // chip on the bright white inner card. Subtle shadow lifts it just
  // enough to register without competing with the parent card. The
  // 1px inset highlight on top matches the outer frame's treatment.
  const rowStyle: React.CSSProperties = {
    background:
      'linear-gradient(180deg, #FAFBFC 0%, #F6F7F9 100%)',
    boxShadow:
      '0 1px 0 rgba(255,255,255,0.9) inset, 0 1px 2px rgba(16,24,40,0.03)',
  };
  return (
    <li
      className="rounded-xl border border-subtle-border/80 p-3 animate-row-in"
      style={rowStyle}
    >
      <div className="flex items-start gap-2">
        <StatusDot status={process.status} />
        <button
          type="button"
          onClick={() => onJump(process.conversationId)}
          className="min-w-0 flex-1 text-left focus:outline-none"
          title={`Jump to ${tabTitle}`}
        >
          <div className="truncate font-mono text-[12px] font-medium text-ink">
            {processLabel(process)}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-ink-label">
            {tabTitle}
          </div>
        </button>
      </div>

      {/* Action row — all icon buttons, tooltip on hover. Open
          (URL), Stop/Restart, Ask Verlox why (on failure), Remove. */}
      <div className="mt-2.5 flex items-center gap-1">
        {process.detectedUrl && isRunning && (
          <IconButton
            title={`Open ${process.detectedUrl}`}
            onClick={() => window.api.openExternal(process.detectedUrl!)}
          >
            <LinkGlyph />
          </IconButton>
        )}
        {isRunning ? (
          <IconButton
            title="Stop this process"
            tone="danger"
            onClick={() => window.api.stopCommand(process.stepId)}
          >
            <StopGlyph />
          </IconButton>
        ) : (
          <IconButton
            title="Restart"
            onClick={() => restartProcess(process.stepId)}
          >
            <RestartGlyph />
          </IconButton>
        )}
        {isFailed && process.tailOutput.length > 0 && (
          <IconButton
            title="Ask Verlox what went wrong"
            onClick={() => {
              onJump(process.conversationId);
              onAskWhy(process.conversationId, buildAskWhyPrompt(process));
            }}
          >
            <HelpGlyph />
          </IconButton>
        )}
        {!isRunning && (
          <IconButton
            title="Remove from the list"
            onClick={() => removeProcess(process.stepId)}
          >
            <RemoveGlyph />
          </IconButton>
        )}
      </div>
    </li>
  );
}

function IconButton({
  title,
  onClick,
  tone = 'default',
  children,
}: {
  title: string;
  onClick: () => void;
  tone?: 'default' | 'danger';
  children: React.ReactNode;
}) {
  const toneClass =
    tone === 'danger'
      ? 'text-step-failed hover:bg-step-failed-tint'
      : 'text-ink-label hover:bg-surface-subtle hover:text-ink';
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={`flex h-6 w-6 items-center justify-center rounded-md transition-colors focus:outline-none ${toneClass}`}
    >
      {children}
    </button>
  );
}

function LinkGlyph() {
  // Globe — meridian + two latitude arcs. Reads as "open in browser"
  // for a running localhost server better than an external-link arrow.
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
      <circle cx="8" cy="8" r="6" />
      <ellipse cx="8" cy="8" rx="2.6" ry="6" />
      <path d="M2.4 6.2h11.2" />
      <path d="M2.4 9.8h11.2" />
    </svg>
  );
}

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

function RestartGlyph() {
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
      <path d="M3 8a5 5 0 1 0 1.6-3.7" />
      <polyline points="3,2 3,5 6,5" />
    </svg>
  );
}

function HelpGlyph() {
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
      <circle cx="8" cy="8" r="6" />
      <path d="M6 6.5a2 2 0 1 1 2.5 1.9V9" />
      <line x1="8" y1="11" x2="8" y2="11.5" />
    </svg>
  );
}

function RemoveGlyph() {
  return (
    <svg
      viewBox="0 0 12 12"
      className="h-2.5 w-2.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <line x1="2" y1="2" x2="10" y2="10" />
      <line x1="10" y1="2" x2="2" y2="10" />
    </svg>
  );
}

function StatusDot({ status }: { status: ProcessStatus }) {
  const style =
    status === 'running'
      ? {
          background: 'linear-gradient(135deg, #56C988 0%, #1E8048 100%)',
          boxShadow:
            'inset 0 1px 0 rgba(255,255,255,0.4), 0 0 0 0.5px rgba(40,140,80,0.4), 0 0 8px rgba(40,160,90,0.5)',
        }
      : status === 'failed'
        ? {
            background: 'linear-gradient(135deg, #F47B7D 0%, #C84147 100%)',
            boxShadow:
              'inset 0 1px 0 rgba(255,255,255,0.35), 0 0 0 0.5px rgba(200,90,90,0.4), 0 0 8px rgba(220,90,90,0.5)',
          }
        : {
            background: 'linear-gradient(135deg, #C2C6CC 0%, #7E828A 100%)',
            boxShadow:
              'inset 0 1px 0 rgba(255,255,255,0.35), 0 0 0 0.5px rgba(120,120,130,0.3), 0 0 6px rgba(140,140,150,0.3)',
          };
  return (
    <span
      className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
        status === 'running' ? 'animate-flicker' : ''
      }`}
      style={style}
      aria-label={status}
    />
  );
}

// Label for the row's bold title. Prefers a host:port form when the
// process has advertised a localhost URL — for dev servers and
// watchers, "localhost:8000" is what the user actually cares about,
// not the binary name ("python", "node", "ruby") which tells them
// almost nothing about which server this is. Falls back to the first
// whitespace-delimited token of the command when no URL was detected:
//   "powershell -NoProfile -Command Get-Process | ..." → "powershell"
// Long pipelines and one-liners stay readable this way.
function processLabel(process: RunningProcess): string {
  if (process.detectedUrl) {
    const hostPort = extractHostPort(process.detectedUrl);
    if (hostPort) return hostPort;
  }
  return firstWordOf(process.command);
}

// Pull just the "host:port" out of a full URL ("http://localhost:8000/foo"
// → "localhost:8000"). Tolerates missing port and missing scheme. Returns
// null if nothing useful can be extracted.
function extractHostPort(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname) return null;
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  } catch {
    return null;
  }
}

function firstWordOf(command: string): string {
  const trimmed = command.trim();
  const idx = trimmed.search(/\s/);
  return idx === -1 ? trimmed : trimmed.slice(0, idx);
}

// Pre-fill text for the "Ask Verlox why" button. Includes the
// command and the tail of its output so the AI has enough context
// to diagnose.
function buildAskWhyPrompt(process: RunningProcess): string {
  const tail = process.tailOutput.trim();
  const tailSection = tail.length > 0 ? `\n\nLast output:\n${tail}` : '';
  return `The command \`${process.command}\` exited with code ${process.exitCode ?? '?'}. What likely went wrong and how do I fix it?${tailSection}`;
}

// Restart action — re-spawn the same command using the original
// step's captured metadata. Generates a new step id so the original
// crashed row stays in the registry until its TTL expires.
function restartProcess(originalStepId: string): void {
  const original = readProcess(originalStepId);
  if (!original) return;
  const newStepId = `${original.conversationId}::restart::${crypto.randomUUID()}`;
  // Register the new entry BEFORE spawning so its first output chunk
  // has somewhere to land.
  registerProcess({
    stepId: newStepId,
    conversationId: original.conversationId,
    command: original.command,
    cwd: original.cwd,
    shell: original.shell,
  });
  window.api.startCommand({
    id: newStepId,
    command: original.command,
    cwd: original.cwd,
    shell: original.shell,
  });
}
