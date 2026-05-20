import {
  readProcess,
  registerProcess,
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
  // Used by the "ask Vorlox why" button on a failed process so the
  // AI gets context about what crashed without the user having to
  // retype it.
  onAskWhy: (conversationId: string, prompt: string) => void;
}

// Live processes board — the second pane below the Timeline. Lists
// every long-lived shell process Vorlox has running (dev servers,
// watchers, infinite pings) plus recently-exited ones (kept around
// briefly so the user can hit Restart on a crash without it
// vanishing). For each process: stop, open detected URL, restart,
// ask Vorlox what went wrong.
export function RunningProcesses({
  tabs,
  onJump,
  onAskWhy,
}: RunningProcessesProps) {
  const processes = useRunningProcesses();

  const tabsById = new Map<string, ConversationTab>();
  for (const tab of tabs) tabsById.set(tab.id, tab);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between pb-4 pl-10 pr-5 pt-5">
        <h2 className="text-[15px] font-semibold text-ink">Running</h2>
        {processes.length > 0 && (
          <span className="text-[11px] text-ink-micro">
            {processes.length} {processes.length === 1 ? 'process' : 'processes'}
          </span>
        )}
      </div>

      {processes.length === 0 ? (
        <p className="px-5 text-[12.5px] leading-relaxed text-ink-label">
          Nothing running. Long-lived commands (dev servers, watchers) appear
          here as you start them.
        </p>
      ) : (
        <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto pb-8 pl-5 pr-5">
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
      )}
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

  return (
    <li className="rounded-xl border border-subtle-border bg-card p-3">
      <div className="flex items-start gap-2">
        <StatusDot status={process.status} />
        <button
          type="button"
          onClick={() => onJump(process.conversationId)}
          className="min-w-0 flex-1 text-left focus:outline-none"
          title={`Jump to ${tabTitle}`}
        >
          <div className="truncate font-mono text-[12px] font-medium text-ink">
            {firstWordOf(process.command)}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-ink-label">
            {tabTitle}
          </div>
        </button>
      </div>

      {/* Action row — Open URL (if detected), Stop / Restart, Ask Why. */}
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {process.detectedUrl && isRunning && (
          <ActionButton
            label="Open"
            title={`Open ${process.detectedUrl}`}
            onClick={() => window.api.openExternal(process.detectedUrl!)}
          />
        )}
        {isRunning ? (
          <ActionButton
            label="Stop"
            title="Stop this process"
            onClick={() => window.api.stopCommand(process.stepId)}
            tone="danger"
          />
        ) : (
          <ActionButton
            label="Restart"
            title="Run the same command again"
            onClick={() => restartProcess(process.stepId)}
          />
        )}
        {isFailed && process.tailOutput.length > 0 && (
          <ActionButton
            label="Ask Vorlox why"
            title="Pre-fill an input asking the AI to diagnose"
            onClick={() => {
              onJump(process.conversationId);
              onAskWhy(
                process.conversationId,
                buildAskWhyPrompt(process),
              );
            }}
          />
        )}
      </div>
    </li>
  );
}

function ActionButton({
  label,
  title,
  onClick,
  tone = 'default',
}: {
  label: string;
  title: string;
  onClick: () => void;
  tone?: 'default' | 'danger';
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
      className={`rounded-md border border-subtle-border bg-card px-2 py-1 text-[11px] transition-colors focus:outline-none ${toneClass}`}
    >
      {label}
    </button>
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

// First whitespace-delimited token of the command, for the row label.
// "powershell -NoProfile -Command Get-Process | ..." → "powershell".
// Long pipelines and one-liners stay readable this way.
function firstWordOf(command: string): string {
  const trimmed = command.trim();
  const idx = trimmed.search(/\s/);
  return idx === -1 ? trimmed : trimmed.slice(0, idx);
}

// Pre-fill text for the "Ask Vorlox why" button. Includes the
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
