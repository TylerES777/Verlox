import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import type { BillingErrorCode, UsageInfo } from '@shared/types';
import { CREDIT_COSTS, formatResets } from '../lib/credits';
import { useTier } from './TierContext';

// The upgrade / plan flow. A locked Pro feature calls openUpgrade(name)
// to surface a premium plan page (a modal) that explains the gate and
// offers Pro. Lives in a context so any component (the Plan Mode pill,
// the diagram button, a future Settings entry) can open it without
// prop-drilling. The modal renders once at the app root.
//
// Pricing note: PRO_PRICE is the displayed monthly price. The plan is
// credit-based — every AI request spends weighted credits; Pro gets a
// far larger grant and unlimited Plan Mode / diagrams.

const PRO_PRICE = '$15';

// Calm, plain-English copy for a failed billing action.
function billingErrorMessage(code: BillingErrorCode): string {
  switch (code) {
    case 'network':
      return "Couldn't reach the server. Check your connection and try again.";
    case 'unauthorized':
      return 'Your session expired — sign out and back in, then try again.';
    case 'not_configured':
      return "Billing isn't available just yet. Please try again later.";
    case 'no_account':
      return 'No billing account yet. Start a checkout first.';
    case 'server':
    default:
      return 'Something went wrong. Please try again.';
  }
}

interface OpenUpgradeOpts {
  // Human label of the feature the user tried to use (e.g. "Plan Mode")
  // for the context line. Omitted for a generic open.
  feature?: string;
  // True when opened because the user ran out of credits (or hit a
  // free-tier feature cap) — the modal frames it as "you're out / capped"
  // rather than a plain feature gate.
  limitReached?: boolean;
}

interface UpgradeContextValue {
  openUpgrade: (opts?: OpenUpgradeOpts) => void;
}

const UpgradeContext = createContext<UpgradeContextValue>({
  openUpgrade: () => {},
});

export function UpgradeProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [feature, setFeature] = useState<string | null>(null);
  const [limitReached, setLimitReached] = useState(false);

  const openUpgrade = useCallback((opts?: OpenUpgradeOpts) => {
    setFeature(opts?.feature ?? null);
    setLimitReached(opts?.limitReached ?? false);
    setOpen(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);

  return (
    <UpgradeContext.Provider value={{ openUpgrade }}>
      {children}
      {open && (
        <UpgradeModal
          feature={feature}
          limitReached={limitReached}
          onClose={close}
        />
      )}
    </UpgradeContext.Provider>
  );
}

export function useUpgrade(): UpgradeContextValue {
  return useContext(UpgradeContext);
}

// ── The plan page (modal) ──────────────────────────────────────────────────

function UpgradeModal({
  feature,
  limitReached,
  onClose,
}: {
  feature: string | null;
  limitReached: boolean;
  onClose: () => void;
}) {
  const { isPro, refresh } = useTier();
  // Billing action state: `busy` while we ask the backend for a URL,
  // `phase` tracks idle → opened (browser launched) → error.
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'opened' | 'error'>('idle');
  const [errorCode, setErrorCode] = useState<BillingErrorCode | null>(null);
  // True when what opened was the manage portal (Pro user, or the
  // duplicate-subscription guard sent a free-looking user there).
  const [openedPortal, setOpenedPortal] = useState(false);
  // Live balance, so a run-out open can name when credits refill.
  const [usage, setUsage] = useState<UsageInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.api
      .getUsage()
      .then((u) => {
        if (!cancelled) setUsage(u);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function startBilling(kind: 'checkout' | 'portal') {
    setBusy(true);
    setPhase('idle');
    setErrorCode(null);
    const res =
      kind === 'checkout'
        ? await window.api.startCheckout()
        : await window.api.openBillingPortal();
    setBusy(false);
    if (res.ok) {
      setOpenedPortal(kind === 'portal' || res.alreadySubscribed === true);
      setPhase('opened');
    } else {
      setErrorCode(res.error ?? 'server');
      setPhase('error');
    }
  }

  // Title + subtitle adapt to why the modal opened: a feature gate, a
  // run-out / cap, or a plain "see plans".
  const refillPhrase = usage ? formatResets(usage.resetsAt) : 'soon';
  const title = limitReached
    ? "You're out of credits"
    : feature
      ? `${feature} is a Pro feature`
      : 'Do more with Pro';
  const subtitle = limitReached
    ? `Your credits refill ${refillPhrase}. Upgrade to Pro for a much bigger weekly grant and unlimited Plan Mode.`
    : feature
      ? `Upgrade to unlock ${feature.toLowerCase()} and the rest of Pro.`
      : 'A bigger credit grant and the power features, for people who live in their terminal.';

  // Escape closes the modal.
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
  const ctaStyle: React.CSSProperties = {
    background: 'linear-gradient(180deg, #1B1B1F 0%, #0A0A0C 100%)',
    boxShadow:
      '0 1px 0 rgba(255,255,255,0.08) inset, 0 1px 2px rgba(0,0,0,0.15), 0 6px 18px -6px rgba(0,0,0,0.3)',
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-6"
      style={{ background: 'rgba(10,12,16,0.45)' }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Verlox plans"
    >
      <div
        className="animate-pane-in relative w-full max-w-[640px] overflow-hidden rounded-2xl border border-subtle-border"
        style={frameStyle}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top-edge sheen */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/85 to-transparent"
          aria-hidden="true"
        />

        {/* Header strip */}
        <div className="flex items-center justify-between px-6 pt-5 pb-3">
          <div className="flex items-center gap-2">
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{
                background: 'linear-gradient(135deg, #E8C36B 0%, #B88A2E 100%)',
                boxShadow:
                  'inset 0 0.5px 0 rgba(255,255,255,0.45), 0 0 6px rgba(200,160,70,0.5)',
              }}
              aria-hidden="true"
            />
            <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-label">
              Verlox Pro
            </span>
          </div>
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

        {/* Inner content card */}
        <div className="relative m-2 rounded-xl border border-subtle-border/70 px-6 py-6" style={innerStyle}>
          <h2 className="text-[22px] font-semibold tracking-[-0.02em] text-ink">
            {title}
          </h2>
          <p className="mt-2 text-[14px] leading-relaxed text-ink-body">
            {subtitle}
          </p>

          {/* Plan comparison */}
          <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {/* Free */}
            <div className="rounded-xl border border-subtle-border bg-surface-faint p-4">
              <div className="flex items-baseline justify-between">
                <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-label">Free</span>
                <span className="text-[18px] font-semibold text-ink">$0</span>
              </div>
              <ul className="mt-3 space-y-1.5 text-[13px] text-ink-body">
                <li>15 credits a day</li>
                <li>Fast Haiku model</li>
                <li>2 image uploads a day</li>
                <li>Plan Mode 4 times a month</li>
                <li>Timeline history</li>
                <li>The Running pane</li>
              </ul>
              {!isPro && (
                <div className="mt-3 text-[11px] uppercase tracking-[0.06em] text-ink-micro">
                  Your plan
                </div>
              )}
            </div>

            {/* Pro */}
            <div
              className="relative rounded-xl border border-ink/15 p-4"
              style={{ background: 'linear-gradient(180deg,#FFFFFF,#FAFBFD)' }}
            >
              <div className="flex items-baseline justify-between">
                <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-ink">Pro</span>
                <span className="text-[18px] font-semibold text-ink">
                  {PRO_PRICE}<span className="text-[12px] font-normal text-ink-label">/mo</span>
                </span>
              </div>
              <ul className="mt-3 space-y-1.5 text-[13px] text-ink-body">
                <li className="font-medium text-ink">500 credits a week</li>
                <li>Smarter Sonnet model, plus Opus</li>
                <li>Generous image uploads</li>
                <li>Unlimited Plan Mode</li>
                <li>Show responses as diagrams</li>
                <li>Everything in Free</li>
              </ul>
              {isPro && (
                <div className="mt-3 text-[11px] uppercase tracking-[0.06em] text-ink-micro">
                  Your plan
                </div>
              )}
            </div>
          </div>

          {/* What costs what — the credit weights, so the grant numbers
              above have a concrete meaning. */}
          <div className="mt-5 rounded-xl border border-subtle-border bg-surface-faint px-4 py-3">
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

          {/* CTA + billing state */}
          <div className="mt-6">
            {phase === 'opened' ? (
              <div className="rounded-lg border border-emerald-200/70 bg-emerald-50/60 px-4 py-3 text-center text-[13px] text-emerald-800">
                {openedPortal
                  ? 'We opened your billing portal in the browser. You already have an active plan, so manage it there.'
                  : 'Secure checkout is open in your browser. Finish there and your plan updates automatically within a few seconds.'}
                <button
                  type="button"
                  onClick={() => refresh()}
                  className="mt-2 block w-full text-[12px] font-medium text-emerald-700 underline-offset-2 hover:underline focus:outline-none"
                >
                  Refresh my plan
                </button>
              </div>
            ) : isPro ? (
              <button
                type="button"
                onClick={() => void startBilling('portal')}
                disabled={busy}
                className="block w-full rounded-xl border border-subtle-border bg-surface-faint px-5 py-3 text-[15px] font-medium text-ink transition-colors hover:bg-surface-subtle focus:outline-none disabled:opacity-60"
              >
                {busy ? 'Opening…' : 'Manage billing'}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void startBilling('checkout')}
                disabled={busy}
                className="block w-full rounded-xl px-5 py-3 text-[15px] font-medium text-white transition-transform focus:outline-none active:scale-[0.99] disabled:opacity-70"
                style={ctaStyle}
              >
                {busy ? 'Opening checkout…' : 'Upgrade to Pro'}
              </button>
            )}
            {phase === 'error' && errorCode && (
              <p className="mt-2 text-center text-[12px] text-step-failed">
                {billingErrorMessage(errorCode)}
              </p>
            )}
          </div>
          <p className="mt-3 text-center text-[11.5px] text-ink-micro">
            {isPro
              ? 'Manage or cancel your subscription any time.'
              : 'Cancel anytime. Free credits refill every day, no card needed.'}
          </p>
        </div>
      </div>
    </div>
  );
}
