import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TimelineEvent } from '@shared/types';
import type { RiskLevel } from '@shared/risk';
import { useTier } from '../contexts/TierContext';
import { useUpgrade } from '../contexts/UpgradeContext';

// Timeline replay — a chronological feed of every action the agent actually
// ran (newest first, grouped by day). Reads the persistent log via IPC and
// refreshes on the 'verlox:timeline-changed' event the agent fires after each
// executed step.

const DOT: Record<RiskLevel, string> = {
  low: 'bg-[#3E7A53]',
  medium: 'bg-[#B07A1E]',
  high: 'bg-[#B4322B]',
};

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
function fmtDay(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

export function TimelineView({ onClose }: { onClose: () => void }) {
  const { isPro } = useTier();
  const { openUpgrade } = useUpgrade();
  const [events, setEvents] = useState<TimelineEvent[]>([]);

  const refresh = useCallback(async () => {
    try {
      setEvents(await window.api.timelineList());
    } catch {
      // keep last
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onChange = () => void refresh();
    window.addEventListener('verlox:timeline-changed', onChange);
    return () => window.removeEventListener('verlox:timeline-changed', onChange);
  }, [refresh]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const clear = useCallback(async () => {
    await window.api.timelineClear();
    setEvents([]);
  }, []);

  // Free sees only the last 24h; Pro sees the full history.
  const visible = useMemo(
    () => (isPro ? events : events.filter((e) => e.ts >= Date.now() - 24 * 60 * 60 * 1000)),
    [events, isPro],
  );
  const hiddenCount = events.length - visible.length;

  // Group newest-first events under day headers (preserving order).
  const groups = useMemo(() => {
    const out: { day: string; items: TimelineEvent[] }[] = [];
    for (const e of visible) {
      const day = fmtDay(e.ts);
      const last = out[out.length - 1];
      if (last && last.day === day) last.items.push(e);
      else out.push({ day, items: [e] });
    }
    return out;
  }, [visible]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/20 p-6 pt-16"
      onMouseDown={onClose}
    >
      <div
        className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-hairline bg-card shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-hairline px-4 py-3">
          <div className="flex items-center gap-2">
            <ClockGlyph />
            <span className="text-sm font-semibold text-ink">Timeline</span>
            <span className="text-[11px] text-ink-hint">
              {events.length} action{events.length === 1 ? '' : 's'}
            </span>
          </div>
          <div className="flex items-center gap-1">
            {events.length > 0 && (
              <button
                onClick={clear}
                className="rounded-md px-2 py-0.5 text-[11px] text-ink-hint hover:bg-black/5 hover:text-ink"
              >
                Clear
              </button>
            )}
            <button
              onClick={onClose}
              className="rounded-md px-2 py-0.5 text-sm text-ink-hint hover:bg-black/5 hover:text-ink"
              aria-label="Close timeline"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Feed */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {visible.length === 0 ? (
            <div className="py-10 text-center text-sm leading-relaxed text-ink-hint">
              {events.length === 0
                ? 'Nothing yet. Every action Verlox runs will show up here, in order.'
                : 'No actions in the last 24 hours.'}
            </div>
          ) : (
            groups.map((g) => (
              <div key={g.day} className="mb-3">
                <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-ink-micro">
                  {g.day}
                </div>
                <ul className="relative space-y-2 border-l border-hairline pl-4">
                  {g.items.map((e) => (
                    <li key={e.id} className="relative">
                      {/* timeline dot on the rail */}
                      <span
                        className={`absolute -left-[1.30rem] top-1 h-2 w-2 rounded-full ${DOT[e.level]}`}
                      />
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-xs font-medium text-ink">{e.label}</span>
                        <span className="shrink-0 font-mono text-[10.5px] text-ink-micro">
                          {fmtTime(e.ts)}
                        </span>
                      </div>
                      <code className="mt-0.5 block break-all rounded bg-black/[0.04] px-1.5 py-0.5 font-mono text-[10.5px] text-[#3A3A3A]">
                        {e.command}
                      </code>
                      <div className="mt-0.5 flex items-center gap-2 text-[10px] text-ink-hint">
                        <span
                          className={
                            e.exitCode === 0 || e.exitCode === null
                              ? 'text-[#3E7A53]'
                              : 'text-[#B4632F]'
                          }
                        >
                          {e.exitCode === 0 || e.exitCode === null
                            ? 'ok'
                            : `exit ${e.exitCode}`}
                        </span>
                        {e.files.length > 0 && (
                          <span className="truncate" title={e.files.join(', ')}>
                            · {e.files.join(', ')}
                          </span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
          {!isPro && (
            <button
              type="button"
              onClick={() => openUpgrade({ feature: 'Full Timeline replay' })}
              className="mt-1 w-full rounded-lg border border-hairline bg-surface-faint px-3 py-2 text-center text-[11px] text-ink-hint hover:text-ink"
            >
              Showing the last 24 hours
              {hiddenCount > 0 ? ` · ${hiddenCount} older hidden` : ''} — Pro keeps your
              full history
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function ClockGlyph({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M12 7.5V12l3 2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
