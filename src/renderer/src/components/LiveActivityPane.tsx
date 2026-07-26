import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { RiskLevel } from '@shared/risk';
import {
  getLiveRun,
  liveRunDismiss,
  liveRunRecord,
  subscribeLiveRun,
  type LiveRunState,
  type TouchedFile,
} from '../lib/liveRun';

// The AI Terminal's live activity pane. Two layers over one run record:
//   running → quiet real-time narration (status, progress, the AI's own
//             per-step reasons, files as they're touched, next step's risk)
//   done    → a receipt: local one-line summary, files touched, and an
//             on-demand "Explain what happened" written by the model.
// It does not exist at rest — ConversationView mounts it only while the
// store has an active or just-finished run.

const RISK_TEXT: Record<RiskLevel, string> = {
  low: 'text-[#3E7A53]',
  medium: 'text-[#9A7D2E]',
  high: 'text-[#B4322B]',
};

function readBrain(): { label: string; engine: string; model: string; providerId: string } {
  try {
    return {
      label: localStorage.getItem('verlox-brain-label') || 'AI',
      engine: localStorage.getItem('verlox-brain-engine') || 'verlox',
      model: localStorage.getItem('verlox-brain-model') || 'sonnet',
      providerId: localStorage.getItem('verlox-brain-provider-id') || '',
    };
  } catch {
    return { label: 'AI', engine: 'verlox', model: 'sonnet', providerId: '' };
  }
}

function localSummary(run: LiveRunState): string {
  const done = run.steps.filter((s) => s.status === 'done').length;
  const failed = run.steps.filter((s) => s.status === 'failed').length;
  const cancelled = run.steps.some((s) => s.status === 'cancelled');
  const deleted = run.files.filter((f) => f.outcome === 'deleted').length;
  const parts: string[] = [];
  parts.push(`${done} of ${run.steps.length} steps completed`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (cancelled) parts.push('stopped early');
  if (deleted > 0) parts.push(`${deleted} item${deleted === 1 ? '' : 's'} deleted (recoverable)`);
  return parts.join(', ') + '.';
}

function fileName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

function FileChip({ file }: { file: TouchedFile }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 truncate rounded-md border border-black/[0.08] bg-white/80 px-1.5 py-0.5 font-mono text-[10.5px] text-ink-label">
      {fileName(file.path)}
    </span>
  );
}

export function LiveActivityPane({ conversationId }: { conversationId: string }) {
  const run = useSyncExternalStore(subscribeLiveRun, getLiveRun);
  const [explain, setExplain] = useState<{
    state: 'loading' | 'done' | 'error';
    text: string;
    brainLabel: string;
  } | null>(null);
  // Slide animation: mounts at width 0, opens to 280, and closing animates
  // back to 0 before the store actually clears (which unmounts).
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const visible = run.phase !== 'idle' && run.conversationId === conversationId;
  useEffect(() => {
    if (visible) {
      setClosing(false);
      const raf = requestAnimationFrame(() => setOpen(true));
      return () => cancelAnimationFrame(raf);
    }
    setOpen(false);
    return undefined;
  }, [visible]);
  const smoothClose = () => {
    if (closing) return;
    setClosing(true);
    setOpen(false);
    window.setTimeout(() => liveRunDismiss(), 320);
  };
  // Reset the explanation when a new run starts.
  const runKeyRef = useRef(0);
  useEffect(() => {
    if (run.phase === 'running') {
      runKeyRef.current = run.startedAt;
      setExplain(null);
    }
  }, [run.phase, run.startedAt]);

  // Only the conversation that owns the run shows the pane.
  if (!visible) return null;

  const total = run.steps.length;
  const finished = run.steps.filter(
    (s) => s.status === 'done' || s.status === 'failed' || s.status === 'cancelled',
  ).length;
  const pct = total === 0 ? 0 : Math.round((finished / total) * 100);
  const current = run.currentIndex >= 0 ? run.steps[run.currentIndex] : null;
  const next = run.steps.find((s) => s.status === 'queued');
  const doneSteps = run.steps.filter((s) => s.status !== 'queued' && s.status !== 'running');
  const durationS = Math.max(1, Math.round(((run.endedAt ?? Date.now()) - run.startedAt) / 1000));

  const runExplain = async () => {
    if (explain?.state === 'loading') return;
    const brain = readBrain();
    setExplain({ state: 'loading', text: '', brainLabel: brain.label });
    try {
      const env = await window.api.getEnvironment();
      const res = await window.api.agentPlanStep({
        goal:
          `Write a detailed plain English debrief of this completed AI terminal run for the user who approved it. ` +
          `Structure: what was asked, then each step (what it did, why, and its result), then a "what changed on your machine" recap with exact counts and paths, then how to reverse anything that changed. ` +
          `No headings syntax, just short labeled paragraphs. Do not propose or run any commands.\n\n${liveRunRecord()}`,
        priorSteps: [],
        cwd: env.homeDir,
        platform: env.platform,
        shell: env.shell,
        engine: brain.engine as never,
        model: brain.model,
        providerId: brain.providerId || undefined,
      });
      if (res.ok) {
        setExplain({
          state: 'done',
          text: res.step.message || 'No explanation came back. Try again.',
          brainLabel: brain.label,
        });
      } else {
        setExplain({ state: 'error', text: res.error, brainLabel: brain.label });
      }
    } catch {
      setExplain({ state: 'error', text: 'The explanation could not be generated. Try again.', brainLabel: readBrain().label });
    }
  };

  return (
    <aside
      className="h-full shrink-0 overflow-hidden border-l border-black/[0.06] bg-[#FAFAFC] transition-[width,opacity] duration-300 ease-out"
      style={{ width: open ? 280 : 0, opacity: open ? 1 : 0 }}
    >
    <div className="flex h-full w-[280px] flex-col overflow-hidden">
      {/* Status row */}
      <div className="flex shrink-0 items-center gap-2 px-4 pb-2 pt-4">
        {run.phase === 'running' ? (
          <span className="h-2 w-2 animate-flicker rounded-full bg-[#3E7A53]" aria-hidden="true" />
        ) : (
          <span className={`text-[13px] ${run.clean ? 'text-[#3E7A53]' : 'text-[#B4322B]'}`} aria-hidden="true">
            {run.clean ? '✓' : '✕'}
          </span>
        )}
        <span className="text-[13px] font-semibold text-ink">
          {run.phase === 'running' ? 'Working' : run.clean ? 'Done' : 'Finished with problems'}
        </span>
        <span className="ml-auto text-[11px] text-ink-hint">
          {run.phase === 'running' ? `step ${Math.min(finished + 1, total)} of ${total}` : `${total} steps · ${durationS}s`}
        </span>
        {run.phase === 'done' && (
          <button
            type="button"
            onClick={smoothClose}
            aria-label="Close activity pane"
            title="Close — the run stays in the Timeline"
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-ink-micro transition-colors hover:bg-black/[0.05] hover:text-ink"
          >
            ✕
          </button>
        )}
      </div>
      <div className="mx-4 h-1 shrink-0 overflow-hidden rounded-full bg-black/[0.06]">
        <div
          className="h-full rounded-full bg-[#3E7A53] transition-[width] duration-500 ease-out"
          style={{ width: `${run.phase === 'done' ? 100 : pct}%` }}
        />
      </div>

      {run.phase === 'running' ? (
        /* ── Live narration ─────────────────────────────────────────── */
        <div className="flex min-h-0 flex-1 flex-col px-4 pt-3">
          <div className="flex min-h-0 flex-1 flex-col justify-end gap-2 overflow-hidden">
            {/* Older narration compresses: last few finished steps, faded. */}
            {doneSteps.slice(-3).map((s, i) => (
              <p key={`${s.command}-${i}`} className="truncate text-[11.5px] leading-snug text-ink-micro">
                {s.status === 'done' ? s.title : `${s.title} (${s.status})`}
              </p>
            ))}
            {/* Current step — the AI's own reason, loudest thing here. */}
            {current && (
              <div className="rounded-xl border border-black/[0.08] bg-white p-3 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
                <p className="text-[12.5px] leading-relaxed text-ink">{current.reason || current.title}</p>
                <p className="mt-1.5 truncate font-mono text-[10.5px] text-ink-hint">{current.command}</p>
                <div className="mt-1.5 flex items-center gap-2">
                  <span className={`text-[10px] font-medium ${RISK_TEXT[current.risk]}`}>{current.risk} risk</span>
                  {run.files.filter((f) => f.stepIndex === run.currentIndex).slice(0, 2).map((f) => (
                    <FileChip key={f.path} file={f} />
                  ))}
                </div>
              </div>
            )}
            {/* Next step + its risk, visible before it runs. */}
            {next && next !== current && (
              <p className="truncate text-[11.5px] text-ink-hint">
                Next: {next.title} <span className={RISK_TEXT[next.risk]}>· {next.risk}</span>
              </p>
            )}
          </div>
          <p className="shrink-0 py-3 text-center text-[10.5px] text-ink-micro">
            Stop any time from the plan card in the chat.
          </p>
        </div>
      ) : (
        /* ── Summary ────────────────────────────────────────────────── */
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-4 pt-3">
          <p className="text-[12.5px] leading-relaxed text-ink">{localSummary(run)}</p>

          {!explain && (
            <button
              type="button"
              onClick={() => void runExplain()}
              className="mt-3 w-full rounded-lg border border-black/[0.12] bg-white px-3 py-1.5 text-[12px] font-medium text-ink shadow-[0_1px_2px_rgba(16,24,40,0.04)] transition-colors hover:bg-surface-subtle"
            >
              Explain what happened
            </button>
          )}
          {explain && (
            <div className="mt-3 rounded-xl border border-black/[0.08] bg-white p-3">
              {explain.state === 'loading' ? (
                <p className="text-[11.5px] text-ink-hint">Reading the run.</p>
              ) : (
                <>
                  <p
                    className={`whitespace-pre-wrap text-[12px] leading-relaxed ${
                      explain.state === 'error' ? 'text-[#B4322B]' : 'text-ink-body'
                    }`}
                  >
                    {explain.text}
                  </p>
                  {explain.state === 'done' && (
                    <p className="mt-2 text-[10px] text-ink-micro">Explained by {explain.brainLabel}</p>
                  )}
                </>
              )}
            </div>
          )}

          {run.files.length > 0 && (
            <div className="mt-4 border-t border-black/[0.06] pt-3">
              <p className="mb-1.5 text-[10.5px] font-medium uppercase tracking-wide text-ink-micro">
                Files touched · {run.files.length}
              </p>
              <div className="space-y-1">
                {run.files.slice(0, 8).map((f) => (
                  <div key={f.path} className="flex items-center gap-2" title={f.path}>
                    <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-label">
                      {fileName(f.path)}
                    </span>
                    <span
                      className={`shrink-0 text-[10px] ${
                        f.outcome === 'deleted' ? 'text-[#B4322B]' : f.outcome === 'read' ? 'text-ink-micro' : 'text-[#3E7A53]'
                      }`}
                    >
                      {f.outcome}
                    </span>
                  </div>
                ))}
                {run.files.length > 8 && (
                  <p className="text-[10.5px] text-ink-micro">{run.files.length - 8} more…</p>
                )}
              </div>
            </div>
          )}

          {run.files.some((f) => f.outcome === 'deleted') && (
            <button
              type="button"
              onClick={() => window.dispatchEvent(new Event('verlox:open-vault'))}
              className="mt-3 flex w-full items-center justify-between rounded-lg border border-black/[0.08] bg-white px-3 py-2 text-left text-[11.5px] text-ink-label transition-colors hover:text-ink"
            >
              Deleted items are in the Recovery Vault
              <span className="text-[11px] font-medium text-ink">Restore</span>
            </button>
          )}

          <button
            type="button"
            onClick={smoothClose}
            className="mt-4 shrink-0 self-center text-[11px] text-ink-micro transition-colors hover:text-ink"
          >
            Dismiss · saved to Timeline
          </button>
        </div>
      )}
    </div>
    </aside>
  );
}
