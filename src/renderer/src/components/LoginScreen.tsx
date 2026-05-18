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

// Inline field wrapper. Label sits above the input; the input is a boxed
// 0.5px hairline-bordered control that darkens to ink on focus (no glow,
// no ring per the brief).
function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] text-ink-label">{label}</span>
      {children}
      {hint && <p className="mt-1.5 text-[11px] text-ink-micro">{hint}</p>}
    </label>
  );
}

const inputClass =
  'w-full rounded-lg border-[0.5px] border-input-border px-3 py-2.5 text-[14px] text-ink focus:border-ink focus:outline-none disabled:opacity-60';

export function LoginScreen() {
  const { signIn, signUp, lastSignOutReason } = useAuth();
  const [mode, setMode] = useState<Mode>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
  }

  const submitLabel = pending
    ? isSignUp
      ? 'Creating account…'
      : 'Signing in…'
    : isSignUp
      ? 'Create account'
      : 'Sign in';

  // Auth screens are full-bleed white. No card-in-window wrapper:
  // the only content is a 360px form, and any card around it either
  // reads as hollow (when wide) or as a mobile-strip silhouette (when
  // narrow). Card-in-window resumes for the conversation screen.
  return (
    <div className="flex h-full w-full flex-col bg-card">
      {/* Wordmark header */}
      <div className="flex justify-center pb-2 pt-8">
        <span className="font-mono text-[14px] font-medium tracking-tight text-ink">
          <span className="text-amber">›</span>vorlox
        </span>
      </div>

      {/* Centered welcome + form */}
      <div className="flex flex-1 flex-col items-center justify-center px-8">
        <div className="w-full max-w-auth-form">
          {showSessionExpiredBanner && (
            <div className="mb-6 flex items-center gap-2.5 rounded-lg border-[0.5px] border-subtle-border bg-surface-subtle px-3.5 py-2.5">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber" />
              <span className="text-[13px] text-ink-body">
                Your session expired. Please sign in again.
              </span>
            </div>
          )}

          <h1
            className="text-[25px] font-semibold text-ink"
            style={{ letterSpacing: '-0.02em' }}
          >
            {isSignUp ? 'Create your account.' : 'Welcome back.'}
          </h1>
          <p className="mb-8 mt-2 text-[14px] text-ink-label">
            {isSignUp ? 'Set up your account in a moment.' : 'Sign in to continue.'}
          </p>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <Field label="Email">
              <input
                type="email"
                value={email}
                onChange={(e) => {
                  dismissBanner();
                  setEmail(e.target.value);
                }}
                disabled={pending}
                autoComplete="email"
                autoFocus
                className={inputClass}
              />
            </Field>

            <Field
              label="Password"
              hint={isSignUp ? 'At least 8 characters.' : undefined}
            >
              <input
                type="password"
                value={password}
                onChange={(e) => {
                  dismissBanner();
                  setPassword(e.target.value);
                }}
                disabled={pending}
                autoComplete={isSignUp ? 'new-password' : 'current-password'}
                className={inputClass}
              />
            </Field>

            {isSignUp && (
              <Field label="Confirm password">
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => {
                    dismissBanner();
                    setConfirmPassword(e.target.value);
                  }}
                  disabled={pending}
                  autoComplete="new-password"
                  className={inputClass}
                />
              </Field>
            )}

            {error && (
              <p className="text-[13px] leading-relaxed text-ink-body">{error}</p>
            )}

            <button
              type="submit"
              disabled={pending}
              className="w-full rounded-lg bg-ink px-4 py-[11px] text-[14px] font-medium text-white hover:opacity-90 focus:outline-none disabled:opacity-60"
            >
              {submitLabel}
            </button>
          </form>

          <div className="mt-6 flex justify-center">
            <button
              type="button"
              onClick={toggleMode}
              disabled={pending}
              className="text-[13px] focus:outline-none disabled:opacity-60"
            >
              <span className="text-ink-label">
                {isSignUp ? 'Already have an account? ' : 'New to Vorlox? '}
              </span>
              <span className="text-ink underline decoration-[0.5px] underline-offset-2">
                {isSignUp ? 'Sign in' : 'Create an account'}
              </span>
            </button>
          </div>
        </div>
      </div>

      {/* Footer microcopy */}
      <div className="flex justify-center pb-8">
        <span className="text-[11px] text-ink-micro">A calm, conversational terminal.</span>
      </div>
    </div>
  );
}
