import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import type { UsageInfo } from '@shared/types';
import { CREDIT_COSTS, formatResets } from '../lib/credits';
import { useTier } from './TierContext';
import { useUpgrade } from './UpgradeContext';

// The usage dashboard. A calm panel (modal) that shows the signed-in
// user's credit balance, when it refills, their free-tier feature caps,
// a reference cost table, and recent credit activity from the ledger.
// Opened from the account menu's "Usage" entry. Lives in a context so the
// menu can open it without prop-drilling; the panel renders once at root.

interface UsageContextValue {
  openUsage: () => void;
  // Latest usage snapshot, refreshed on mount and after each turn settles.
  // Drives proactive UI like disabling the image-attach button once the
  // free daily image cap is spent. Null until the first fetch resolves.
  usage: UsageInfo | null;
  // True when the free-tier daily image cap is fully spent (limit set and
  // reached). False for Pro (limit null = unlimited) and while unknown.
  imagesExhausted: boolean;
  // Re-fetch the usage snapshot. Called after a turn finishes so caps and
  // the credit balance reflect what the turn just consumed.
  refresh: () => void;
}

const UsageContext = createContext<UsageContextValue>({
  openUsage: () => {},
  usage: null,
  imagesExhausted: false,
  refresh: () => {},
});

export function UsageProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const openUsage = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);

  const refresh = useCallback(() => {
    window.api
      .getUsage()
      .then((u) => setUsage(u))
      .catch(() => {
        // Leave the last good snapshot in place on a transient failure —
        // the server still enforces caps, so a stale client read is safe.
      });
  }, []);

  // Prime the snapshot once the provider mounts (post-auth).
  useEffect(() => {
    refresh();
  }, [refresh]);

  const images = usage?.caps?.images;
  const imagesExhausted =
    !!images && images.limit !== null && images.used >= images.limit;

  return (
    <UsageContext.Provider value={{ openUsage, usage, imagesExhausted, refresh }}>
      {children}
      {open && <UsagePanel onClose={close} />}
    </UsageContext.Provider>
  );
}

export function useUsage(): UsageContextValue {
  return useContext(UsageContext);
}

// ── helpers ────────────────────────────────────────────────────────────────

// Friendly model name from a raw Anthropic model id (claude-sonnet-4-6 →
// "Sonnet"). Falls back to the raw id for anything unrecognised.
function modelLabel(model: string): string {
  const m = model.toLowerCase();
  if (m.includes('opus')) return 'Opus';
  if (m.includes('sonnet')) return 'Sonnet';
  if (m.includes('haiku')) return 'Haiku';
  return model;
}

// "3m ago" / "5h ago" / "2d ago" from an ISO timestamp; falls back to a
// short date past a week.
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  if (diff < 60000) return 'just now';
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(diff / 3600000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(diff / 86400000);
  if (days < 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

// ── the panel ────────────────────────────────────────────────────────────

function UsagePanel({ onClose }: { onClose: () => void }) {
  const { isPro } = useTier();
  const { openUpgrade } = useUpgrade();
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    window.api
      .getUsage()
      .then((u) => {
        if (!cancelled) {
          setUsage(u);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const frameStyle: React.CSSProperties = {
    background:
      'linear-gradient(180deg, rgba(244,245,248,0.97) 0%, rgba(240,242,246,0.97) 100%)',
    backdropFilter: 'blur(14px) saturate(140%)',
    WebkitBackdropFilter: 'blur(14px) saturate(140%)',
    boxShadow:
      '0 1px 0 rgba(255,255,255,0.7) inset, 0 0 0 0.5px rgba(0,0,0,0.05), 0 24px 60px -20px rgba(20,30,60,0.35)',
  };
  const innerStyle: React.CSSProperties = {
    background: 'linear-gradient(180deg, #FFFFFF 0%, #FDFEFE 100%)',
    boxShadow:
      '0 1px 0 rgba(255,255,255,0.9) inset, 0 1px 2px rgba(16,24,40,0.04)',
  };

  const remaining = usage ? Math.max(0, usage.limit - usage.used) : 0;
  const usedPct = usage
    ? Math.min(100, Math.round((usage.used / Math.max(1, usage.limit)) * 100))
    : 0;
  const out = usage ? usage.remaining <= 0 : false;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-6"
      style={{ background: 'rgba(10,12,16,0.45)' }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Your usage"
    >
      <div
        className="animate-pane-in relative flex max-h-[88vh] w-full max-w-[560px] flex-col overflow-hidden rounded-2xl border border-subtle-border"
        style={frameStyle}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/85 to-transparent"
          aria-hidden="true"
        />

        {/* Header strip */}
        <div className="flex items-center justify-between px-6 pt-5 pb-3">
          <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-label">
            Your usage
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-label transition-colors hover:bg-white/60 hover:text-ink focus:outline-none"
          >
            <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
              <line x1="2" y1="2" x2="10" y2="10" /><line x1="10" y1="2" x2="2" y2="10" />
            </svg>
          </button>
        </div>

        <div className="relative m-2 flex min-h-0 flex-1 flex-col overflow-y-auto rounded-xl border border-subtle-border/70 px-6 py-6" style={innerStyle}>
          {loading ? (
            <div className="py-10 text-center text-[13px] text-ink-micro">
              Loading your usage…
            </div>
          ) : !usage ? (
            <div className="py-10 text-center text-[13px] text-ink-micro">
              Couldn't load your usage. Check your connection and try again.
            </div>
          ) : (
            <>
              {/* Balance */}
              <div className="flex items-baseline justify-between">
                <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-label">
                  Credits left
                  <span className="ml-1.5 rounded bg-surface-subtle px-1.5 py-0.5 text-[10px] tracking-[0.06em] text-ink-micro">
                    {usage.tier === 'pro' ? 'Pro' : 'Free'}
                  </span>
                </span>
                <span className="tabular-nums text-[22px] font-semibold tracking-[-0.02em] text-ink">
                  {remaining}
                  <span className="ml-1 text-[13px] font-normal text-ink-label">
                    / {usage.limit}
                  </span>
                </span>
              </div>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-subtle">
                <div
                  className={`h-full rounded-full ${out ? 'bg-step-failed' : 'bg-ink/70'}`}
                  style={{ width: `${usedPct}%` }}
                />
              </div>
              <p className={`mt-2 text-[12px] ${out ? 'text-step-failed' : 'text-ink-micro'}`}>
                {out
                  ? `Out of credits — refills ${formatResets(usage.resetsAt)}.`
                  : `Refills ${formatResets(usage.resetsAt)}.`}
              </p>

              {/* Feature caps */}
              {usage.caps && (
                <div className="mt-5 grid grid-cols-2 gap-3">
                  <CapCard
                    label="Images today"
                    used={usage.caps.images.used}
                    limit={usage.caps.images.limit}
                  />
                  <CapCard
                    label="Plan Mode this month"
                    used={usage.caps.thinkMode.used}
                    limit={usage.caps.thinkMode.limit}
                  />
                </div>
              )}

              {/* Cost reference */}
              <div className="mt-6">
                <div className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-ink-micro">
                  What costs what
                </div>
                <ul className="mt-2 space-y-1">
                  {CREDIT_COSTS.map((row) => (
                    <li
                      key={row.label}
                      className="flex items-baseline justify-between text-[12.5px]"
                    >
                      <span className="text-ink-body">{row.label}</span>
                      <span className="tabular-nums text-ink-label">{row.cost}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Recent activity */}
              <div className="mt-6">
                <div className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-ink-micro">
                  Recent activity
                </div>
                {usage.events && usage.events.length > 0 ? (
                  <ul className="mt-2 divide-y divide-hairline">
                    {usage.events.slice(0, 12).map((ev, i) => (
                      <li
                        key={`${ev.createdAt}-${i}`}
                        className="flex items-center justify-between py-1.5 text-[12.5px]"
                      >
                        <span className="flex items-center gap-1.5 text-ink-body">
                          <span className="text-ink">
                            {ev.action === 'diagram' ? 'Diagram' : modelLabel(ev.model)}
                          </span>
                          {ev.planMode && (
                            <span className="rounded bg-surface-subtle px-1 py-0.5 text-[9.5px] uppercase tracking-[0.05em] text-ink-micro">
                              Plan
                            </span>
                          )}
                          {ev.hadImage && (
                            <span className="rounded bg-surface-subtle px-1 py-0.5 text-[9.5px] uppercase tracking-[0.05em] text-ink-micro">
                              Image
                            </span>
                          )}
                        </span>
                        <span className="flex items-baseline gap-2">
                          <span className="text-ink-micro">{relativeTime(ev.createdAt)}</span>
                          <span className="tabular-nums text-ink-label">
                            -{ev.credits}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-[12.5px] text-ink-micro">
                    Nothing yet this period.
                  </p>
                )}
              </div>

              {/* CTA */}
              <div className="mt-6">
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    openUpgrade();
                  }}
                  className="block w-full rounded-xl border border-subtle-border bg-surface-faint px-5 py-2.5 text-[14px] font-medium text-ink transition-colors hover:bg-surface-subtle focus:outline-none"
                >
                  {isPro ? 'Manage plan' : 'Get more credits with Pro'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// One free-tier feature cap card (images/day, Plan Mode/month). A null
// limit means unlimited (Pro), shown as a check rather than a count.
function CapCard({
  label,
  used,
  limit,
}: {
  label: string;
  used: number;
  limit: number | null;
}) {
  const unlimited = limit === null;
  const hit = !unlimited && used >= (limit as number);
  return (
    <div className="rounded-xl border border-subtle-border bg-surface-faint p-3">
      <div className="text-[11px] text-ink-label">{label}</div>
      <div className="mt-1 text-[15px] font-semibold tabular-nums text-ink">
        {unlimited ? (
          <span className="text-[13px] font-medium text-ink-body">Unlimited</span>
        ) : (
          <span className={hit ? 'text-step-failed' : 'text-ink'}>
            {used} <span className="text-[12px] font-normal text-ink-label">/ {limit}</span>
          </span>
        )}
      </div>
    </div>
  );
}
