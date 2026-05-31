import { useState, type FormEvent, type ReactNode } from 'react';
import type { AuthErrorCode } from '@shared/types';
import { useAuth } from '../contexts/AuthContext';

type Mode = 'sign-in' | 'sign-up';

const MIN_PASSWORD_LENGTH = 8;

function errorMessage(code: AuthErrorCode, mode: Mode): string {
  switch (code) {
    case 'invalid_credentials':
      return "Couldn't sign you in. Check your email and password.";
    case 'email_exists':
      return 'An account with that email already exists.';
    case 'invalid_input':
      return mode === 'sign-up'
        ? 'Please check your email and password and try again.'
        : "Couldn't sign you in. Check your email and password.";
    case 'rate_limit':
      return 'Too many attempts. Please wait a moment and try again.';
    case 'network':
      return "Couldn't reach the service. Check your connection.";
    case 'server':
      return 'Something went wrong. Please try again.';
  }
}

// Brand-glass styles, mirrored from UpgradeModal so the auth screen reads
// like part of the same product, not a starter-template form.
const pageBgStyle: React.CSSProperties = {
  background:
    'radial-gradient(900px 500px at 50% -10%, rgba(86,201,136,0.07), transparent 60%), #ffffff',
};
const frameStyle: React.CSSProperties = {
  background:
    'linear-gradient(180deg, rgba(244,245,248,0.97) 0%, rgba(240,242,246,0.97) 100%)',
  backdropFilter: 'blur(14px) saturate(140%)',
  WebkitBackdropFilter: 'blur(14px) saturate(140%)',
  boxShadow:
    '0 1px 0 rgba(255,255,255,0.7) inset, 0 0 0 0.5px rgba(0,0,0,0.05), 0 24px 60px -20px rgba(20,30,60,0.30)',
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
// 40px-tall draggable strip at the top, matching the titleBarOverlay height
// (main process sets titleBarStyle: 'hidden' with a 40px overlay). Without
// this, the frameless window can't be dragged from the auth screen.
const dragStyle: React.CSSProperties = {
  // @ts-expect-error — Electron-specific CSS property
  WebkitAppRegion: 'drag',
};

// ── Icons ────────────────────────────────────────────────────────────────
// Inline SVGs at currentColor so they pick up text-ink-micro / text-ink-label
// and match the rest of the app without an external icon dep.

function IconMail(props: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={props.className}
    >
      <rect x="2" y="3.5" width="12" height="9" rx="1.5" />
      <path d="M2.5 4.5 L8 9 L13.5 4.5" />
    </svg>
  );
}

function IconLock(props: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={props.className}
    >
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7 V5 a2.5 2.5 0 0 1 5 0 V7" />
    </svg>
  );
}

function IconEye(props: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={props.className}
    >
      <path d="M1.5 8 C 3.5 4, 5.8 3, 8 3 s 4.5 1, 6.5 5 C 12.5 12, 10.2 13, 8 13 s -4.5 -1 -6.5 -5 z" />
      <circle cx="8" cy="8" r="2" />
    </svg>
  );
}

function IconEyeOff(props: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={props.className}
    >
      <path d="M2.5 5.5 C 4 7, 6 11, 8 11 s 4 -4 5.5 -5.5" opacity="0.5" />
      <path d="M1.5 8 C 3.5 4, 5.8 3, 8 3 s 4.5 1, 6.5 5 C 12.5 12, 10.2 13, 8 13 s -4.5 -1 -6.5 -5 z" />
      <line x1="2.5" y1="2.5" x2="13.5" y2="13.5" />
    </svg>
  );
}

// ── Field wrapper ───────────────────────────────────────────────────────
// One row: a leading icon, the input, and an optional trailing slot (e.g.,
// the password show/hide toggle). Labels stay in the DOM for screen readers
// but aren't visible — the icon + placeholder carry the meaning.

function IconField({
  label,
  icon,
  right,
  hint,
  children,
}: {
  label: string;
  icon: ReactNode;
  right?: ReactNode;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="block">
      <label className="sr-only">{label}</label>
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-label">
          {icon}
        </span>
        {children}
        {right && (
          <span className="absolute right-2 top-1/2 -translate-y-1/2">
            {right}
          </span>
        )}
      </div>
      {hint && <p className="mt-1.5 pl-1 text-[11.5px] text-ink-micro">{hint}</p>}
    </div>
  );
}

const inputClass =
  'w-full rounded-xl border-[0.5px] border-subtle-border bg-[#FAFBFC] py-3 pl-9 pr-3 text-[14px] text-ink placeholder-ink-micro shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] transition-colors focus:border-ink focus:bg-white focus:outline-none disabled:opacity-60';
const inputClassWithRight = inputClass + ' pr-10';

export function LoginScreen() {
  const { signIn, signUp, lastSignOutReason } = useAuth();
  const [mode, setMode] = useState<Mode>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Sign-up only: user must agree to Terms + Privacy before submit unlocks.
  const [agreed, setAgreed] = useState(false);

  // One-shot dismissal: flips true on first user interaction (any onChange,
  // toggle click) and never flips back. Backspacing to empty does NOT bring
  // the banner back. Avoids "ghost banner" behavior.
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const dismissBanner = () => {
    if (!bannerDismissed) setBannerDismissed(true);
  };

  const isSignUp = mode === 'sign-up';
  const showSessionExpiredBanner =
    lastSignOutReason === 'session-expired' && !bannerDismissed;

  function clientValidate(): string | null {
    if (!email.includes('@')) return 'Please enter a valid email address.';
    if (password.length < MIN_PASSWORD_LENGTH) {
      return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    }
    if (isSignUp && password !== confirmPassword) {
      return "Passwords don't match.";
    }
    return null;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const clientError = clientValidate();
    if (clientError) {
      setError(clientError);
      return;
    }
    setPending(true);
    try {
      const code = isSignUp
        ? await signUp(email, password)
        : await signIn(email, password);
      if (code) setError(errorMessage(code, mode));
    } finally {
      setPending(false);
    }
  }

  function toggleMode() {
    dismissBanner();
    setMode(isSignUp ? 'sign-in' : 'sign-up');
    setError(null);
    setConfirmPassword('');
    setAgreed(false);
  }

  const submitLabel = pending
    ? isSignUp
      ? 'Creating account…'
      : 'Signing in…'
    : isSignUp
      ? 'Create account'
      : 'Sign in';

  return (
    <div
      className="flex h-full w-full flex-col font-sans text-ink"
      style={pageBgStyle}
    >
      {/* Draggable strip behind the frameless title-bar overlay (40px). */}
      <div className="h-10 w-full shrink-0" style={dragStyle} />

      {/* Centered glass card */}
      <div className="flex flex-1 items-center justify-center px-6 pb-6">
        <div
          className="relative w-full max-w-[420px] overflow-hidden rounded-2xl p-2"
          style={frameStyle}
        >
          {/* Top-edge sheen */}
          <div
            className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/85 to-transparent"
            aria-hidden="true"
          />

          <div
            className="rounded-xl border border-[rgba(0,0,0,0.06)] px-7 py-7"
            style={innerStyle}
          >
            {/* Brand mark — larger, centered, hero-style. */}
            <div className="flex justify-center">
              <svg
                width="44"
                height="44"
                viewBox="0 0 512 512"
                fill="none"
                aria-hidden="true"
              >
                <defs>
                  <linearGradient
                    id="ls-bg"
                    x1="256"
                    y1="16"
                    x2="256"
                    y2="496"
                    gradientUnits="userSpaceOnUse"
                  >
                    <stop offset="0" stopColor="#26272D" />
                    <stop offset="0.55" stopColor="#141519" />
                    <stop offset="1" stopColor="#0A0A0C" />
                  </linearGradient>
                  <linearGradient
                    id="ls-pip"
                    x1="304"
                    y1="234"
                    x2="348"
                    y2="278"
                    gradientUnits="userSpaceOnUse"
                  >
                    <stop offset="0" stopColor="#5FD08F" />
                    <stop offset="1" stopColor="#1E8048" />
                  </linearGradient>
                </defs>
                <rect
                  x="16"
                  y="16"
                  width="480"
                  height="480"
                  rx="116"
                  fill="url(#ls-bg)"
                />
                <path
                  d="M178 168 L262 256 L178 344"
                  stroke="#F5F6F8"
                  strokeWidth="36"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <circle cx="326" cy="256" r="24" fill="url(#ls-pip)" />
              </svg>
            </div>

            <h1
              className="mt-5 text-center text-[24px] font-semibold text-ink"
              style={{ letterSpacing: '-0.02em' }}
            >
              {isSignUp ? 'Create your account.' : 'Welcome back.'}
            </h1>
            {/* Subtitle carries the brand copy (what Verlox is and what it
                does), not a generic "you're on the sign-in screen" line.
                Same in both modes — the heading already tells you the action. */}
            <p className="mx-auto mt-2 max-w-[320px] text-center text-[13.5px] leading-relaxed text-ink-label">
              Verlox is a calm, conversational AI terminal. Say what you want
              and it plans the work, runs it, and tells you what happened.
            </p>

            {showSessionExpiredBanner && (
              <div className="mt-5 flex items-center gap-2.5 rounded-lg border-[0.5px] border-subtle-border bg-surface-subtle px-3.5 py-2.5">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber" />
                <span className="text-[13px] text-ink-body">
                  Your session expired. Please sign in again.
                </span>
              </div>
            )}

            <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-3">
              <IconField label="Email" icon={<IconMail />}>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => {
                    dismissBanner();
                    setEmail(e.target.value);
                  }}
                  placeholder="you@email.com"
                  disabled={pending}
                  autoComplete="email"
                  autoFocus
                  className={inputClass}
                />
              </IconField>

              <IconField
                label="Password"
                icon={<IconLock />}
                hint={isSignUp ? 'At least 8 characters.' : undefined}
                right={
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-ink-label transition-colors hover:bg-[#F4F4F5] hover:text-ink focus:outline-none"
                  >
                    {showPassword ? <IconEyeOff /> : <IconEye />}
                  </button>
                }
              >
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => {
                    dismissBanner();
                    setPassword(e.target.value);
                  }}
                  placeholder="••••••••"
                  disabled={pending}
                  autoComplete={isSignUp ? 'new-password' : 'current-password'}
                  className={inputClassWithRight}
                />
              </IconField>

              {isSignUp && (
                <IconField
                  label="Confirm password"
                  icon={<IconLock />}
                  right={
                    <button
                      type="button"
                      onClick={() => setShowConfirm((v) => !v)}
                      aria-label={
                        showConfirm ? 'Hide password' : 'Show password'
                      }
                      className="flex h-7 w-7 items-center justify-center rounded-md text-ink-label transition-colors hover:bg-[#F4F4F5] hover:text-ink focus:outline-none"
                    >
                      {showConfirm ? <IconEyeOff /> : <IconEye />}
                    </button>
                  }
                >
                  <input
                    type={showConfirm ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={(e) => {
                      dismissBanner();
                      setConfirmPassword(e.target.value);
                    }}
                    placeholder="Repeat your password"
                    disabled={pending}
                    autoComplete="new-password"
                    className={inputClassWithRight}
                  />
                </IconField>
              )}

              {isSignUp && (
                <label className="mt-1 flex cursor-pointer select-none items-start gap-2.5 text-[12.5px] leading-relaxed text-ink-label">
                  <input
                    type="checkbox"
                    checked={agreed}
                    onChange={(e) => setAgreed(e.target.checked)}
                    disabled={pending}
                    className="sr-only"
                    aria-label="I agree to the Terms and Privacy Policy"
                  />
                  <span
                    aria-hidden="true"
                    className={`mt-[1px] flex h-[15px] w-[15px] flex-none items-center justify-center rounded-[4px] border transition-colors ${
                      agreed
                        ? 'border-ink bg-ink'
                        : 'border-subtle-border bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.7)]'
                    }`}
                  >
                    {agreed && (
                      <svg
                        viewBox="0 0 12 12"
                        className="h-[9px] w-[9px] text-white"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polyline points="2.5,6.5 5,9 9.5,3.5" />
                      </svg>
                    )}
                  </span>
                  <span>
                    I agree to the{' '}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        window.api.openExternal('https://www.verlox.app/terms');
                      }}
                      className="text-ink underline decoration-[0.5px] underline-offset-2 focus:outline-none"
                    >
                      Terms
                    </button>{' '}
                    and{' '}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        window.api.openExternal('https://www.verlox.app/privacy');
                      }}
                      className="text-ink underline decoration-[0.5px] underline-offset-2 focus:outline-none"
                    >
                      Privacy Policy
                    </button>
                    .
                  </span>
                </label>
              )}

              {error && (
                <p className="text-[13px] leading-relaxed text-step-failed">
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={pending || (isSignUp && !agreed)}
                className="mt-2 w-full rounded-xl px-4 py-3 text-[14.5px] font-medium text-white transition-transform focus:outline-none active:scale-[0.99] disabled:opacity-60"
                style={ctaStyle}
              >
                {submitLabel}
              </button>
            </form>

            <div className="mt-5 border-t border-hairline pt-5">
              <button
                type="button"
                onClick={toggleMode}
                disabled={pending}
                className="block w-full text-center text-[13px] focus:outline-none disabled:opacity-60"
              >
                <span className="text-ink-label">
                  {isSignUp ? 'Already have an account? ' : 'New to Verlox? '}
                </span>
                <span className="text-ink underline decoration-[0.5px] underline-offset-2">
                  {isSignUp ? 'Sign in' : 'Create an account'}
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Footer microcopy */}
      <div className="flex justify-center pb-6">
        <span className="text-[11px] text-ink-micro">
          A calm, conversational terminal.
        </span>
      </div>
    </div>
  );
}
