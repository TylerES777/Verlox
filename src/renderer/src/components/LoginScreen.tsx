import { useState, type FormEvent } from 'react';
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

  return (
    <div className="flex h-full w-full items-center justify-center bg-off-white">
      <div className="flex w-full max-w-sm flex-col items-stretch px-6">
        <h1
          className="mb-12 self-center font-soft text-gray-400"
          style={{ fontSize: '32px', fontWeight: 200, letterSpacing: '0.15em' }}
        >
          Vorlox
        </h1>

        {showSessionExpiredBanner && (
          <p className="mb-4 text-[13px] leading-relaxed text-gray-500">
            Your session expired. Please sign in again.
          </p>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <input
            type="email"
            value={email}
            onChange={(e) => {
              dismissBanner();
              setEmail(e.target.value);
            }}
            placeholder="Email"
            disabled={pending}
            autoComplete="email"
            autoFocus
            className="rounded-lg border border-transparent bg-[#F5F5F2] px-4 py-3 text-[14px] leading-6 text-gray-700 placeholder:text-gray-400 focus:border-gray-300 focus:outline-none disabled:opacity-60"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => {
              dismissBanner();
              setPassword(e.target.value);
            }}
            placeholder="Password"
            disabled={pending}
            autoComplete={isSignUp ? 'new-password' : 'current-password'}
            className="rounded-lg border border-transparent bg-[#F5F5F2] px-4 py-3 text-[14px] leading-6 text-gray-700 placeholder:text-gray-400 focus:border-gray-300 focus:outline-none disabled:opacity-60"
          />
          {isSignUp && (
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => {
              dismissBanner();
              setConfirmPassword(e.target.value);
            }}
              placeholder="Confirm password"
              disabled={pending}
              autoComplete="new-password"
              className="rounded-lg border border-transparent bg-[#F5F5F2] px-4 py-3 text-[14px] leading-6 text-gray-700 placeholder:text-gray-400 focus:border-gray-300 focus:outline-none disabled:opacity-60"
            />
          )}

          {error && (
            <div className="text-[13px] leading-5 text-gray-500">{error}</div>
          )}

          <button
            type="submit"
            disabled={pending}
            className="mt-2 rounded-lg bg-gray-700 px-4 py-3 text-[14px] font-medium text-off-white transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {submitLabel}
          </button>
        </form>

        <button
          type="button"
          onClick={toggleMode}
          disabled={pending}
          className="mt-6 self-center text-[13px] text-gray-400 hover:text-gray-600 focus:outline-none disabled:opacity-60"
        >
          {isSignUp ? 'Already have an account? Sign in' : 'New here? Create an account'}
        </button>
      </div>
    </div>
  );
}
