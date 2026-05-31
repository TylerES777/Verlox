import { useEffect, useRef, useState } from 'react';
import type { BillingStatus, UsageInfo } from '@shared/types';
import { useAuth } from '../contexts/AuthContext';
import { useTier } from '../contexts/TierContext';
import { useUpgrade } from '../contexts/UpgradeContext';
import { useUsage } from '../contexts/UsageContext';
import { useUpdateStatus } from '../hooks/useUpdateStatus';
import { formatResets } from '../lib/credits';

// "Jun 25, 2026" from a unix-seconds timestamp.
function formatPlanDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function HeaderMenu() {
  const { user, signOut } = useAuth();
  const { isPro } = useTier();
  const { openUpgrade } = useUpgrade();
  const { openUsage } = useUsage();
  const update = useUpdateStatus();
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Fetch the running app version once, for the menu footer. Doubles as
  // the visible confirmation that an auto-update actually swapped builds.
  useEffect(() => {
    let cancelled = false;
    window.api.getAppVersion().then((v) => {
      if (!cancelled) setVersion(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Refresh usage + subscription status each time the menu opens, so the
  // count and the plan/renewal line reflect the latest state.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    window.api.getUsage().then((u) => {
      if (!cancelled) setUsage(u);
    });
    window.api.getBillingStatus().then((b) => {
      if (!cancelled) setBilling(b);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  if (!user) return null;

  const initial = (user.email[0] ?? '?').toUpperCase();

  async function handleSignOut() {
    setOpen(false);
    await signOut();
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Account menu"
        aria-expanded={open}
        className="flex h-7 w-7 items-center justify-center rounded-full bg-[#F4F4F5] text-[12px] font-medium text-ink-label hover:bg-subtle-border focus:outline-none"
      >
        {initial}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-10 mt-2 w-[240px] overflow-hidden rounded-xl border-[0.5px] border-[rgba(0,0,0,0.08)] bg-card shadow-popover">
          <div className="break-all px-3 pb-2 pt-3 text-[13px] text-ink-label">
            {user.email}
          </div>
          <div className="border-t-[0.5px] border-hairline" />
          {/* Credit balance — credits left this period against the grant,
              with a thin progress bar and a refill line. The whole block is
              a button into the full usage dashboard. Refreshed each time the
              menu opens. */}
          {usage && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                openUsage();
              }}
              className="block w-full px-3 py-2.5 text-left hover:bg-surface-subtle focus:outline-none"
            >
              <div className="flex items-baseline justify-between text-[12px]">
                <span className="text-ink-label">
                  Credits
                  <span className="ml-1.5 rounded bg-surface-subtle px-1.5 py-0.5 text-[10px] uppercase tracking-[0.06em] text-ink-micro">
                    {usage.tier === 'pro' ? 'Pro' : 'Free'}
                  </span>
                </span>
                <span className="tabular-nums text-ink">
                  {Math.max(0, usage.limit - usage.used)} / {usage.limit} left
                </span>
              </div>
              <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-surface-subtle">
                <div
                  className={`h-full rounded-full ${
                    usage.remaining <= 0 ? 'bg-step-failed' : 'bg-ink/70'
                  }`}
                  style={{
                    width: `${Math.min(100, Math.round((usage.used / Math.max(1, usage.limit)) * 100))}%`,
                  }}
                />
              </div>
              <div
                className={`mt-1.5 text-[11px] ${
                  usage.remaining <= 0 ? 'text-step-failed' : 'text-ink-micro'
                }`}
              >
                {usage.remaining <= 0
                  ? `Out of credits — refills ${formatResets(usage.resetsAt)}.`
                  : `Refills ${formatResets(usage.resetsAt)} · view usage`}
              </div>
            </button>
          )}
          {/* Subscription status — which plan you're on and when it renews
              or ends. Shown for Pro with a known period end; Free needs no
              date (the badge above already says Free). */}
          {billing && billing.tier === 'pro' && billing.currentPeriodEnd && (
            <div className="px-3 pb-2.5 -mt-0.5 text-[11px]">
              {billing.cancelAtPeriodEnd ? (
                <span className="text-step-failed">
                  Cancels {formatPlanDate(billing.currentPeriodEnd)} — switches
                  to Free
                </span>
              ) : (
                <span className="text-ink-micro">
                  Renews {formatPlanDate(billing.currentPeriodEnd)}
                </span>
              )}
            </div>
          )}
          <div className="border-t-[0.5px] border-hairline" />
          {/* Plan / subscription. Always available so users can switch
              plans whenever they want — not only when they hit the cap.
              Opens the plan-page modal (UpgradeContext). Free users see a
              gold "Upgrade to Pro"; Pro users see "Manage plan". */}
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              openUpgrade();
            }}
            className="flex w-full items-center justify-between px-3 py-2 text-left text-[14px] font-medium text-ink hover:bg-surface-subtle focus:outline-none"
          >
            <span className="flex items-center gap-2">
              {!isPro && (
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{
                    background:
                      'linear-gradient(135deg, #E8C36B 0%, #B88A2E 100%)',
                    boxShadow:
                      'inset 0 0.5px 0 rgba(255,255,255,0.45), 0 0 6px rgba(200,160,70,0.5)',
                  }}
                  aria-hidden="true"
                />
              )}
              {isPro ? 'Manage plan' : 'Upgrade to Pro'}
            </span>
            {!isPro && (
              <span className="text-[12px] font-normal text-ink-micro">
                $15/mo
              </span>
            )}
          </button>
          <div className="border-t-[0.5px] border-hairline" />
          {/* Update affordance lives here in the account menu (not the
              header). Only the 'downloaded' state is actionable — it
              installs the newer version; 'downloading' shows progress;
              anything else stays hidden. */}
          {update.state === 'downloaded' && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                window.api.installUpdate();
              }}
              className="block w-full px-3 py-2 text-left text-[14px] font-medium text-emerald-700 hover:bg-emerald-50 focus:outline-none"
            >
              Update to the newest version
              {update.version ? (
                <span className="ml-1 font-normal text-emerald-600/70">
                  v{update.version}
                </span>
              ) : null}
            </button>
          )}
          {update.state === 'downloading' && (
            <div className="px-3 py-2 text-[13px] text-ink-micro">
              Downloading update
              {update.percent !== null ? ` … ${update.percent}%` : '…'}
            </div>
          )}
          <button
            type="button"
            onClick={handleSignOut}
            className="block w-full px-3 py-2 text-left text-[14px] text-ink hover:bg-surface-subtle focus:outline-none"
          >
            Sign out
          </button>
          <div className="border-t-[0.5px] border-hairline" />
          <div className="px-3 py-2 font-mono text-[11px] text-ink-micro">
            Verlox {version ? `v${version}` : ''}
          </div>
        </div>
      )}
    </div>
  );
}
