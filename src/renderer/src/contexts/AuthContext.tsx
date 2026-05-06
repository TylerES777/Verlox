import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { AuthErrorCode, AuthResult, AuthUser } from '@shared/types';

export type AuthStatus = 'hydrating' | 'authenticated' | 'unauthenticated';

// Why the user is on the login screen. Drives whether LoginScreen shows
// the "Your session expired" banner. Resets to null on successful auth.
export type SignOutReason = 'user' | 'session-expired';

export interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  lastSignOutReason: SignOutReason | null;
  signIn: (email: string, password: string) => Promise<AuthErrorCode | null>;
  signUp: (email: string, password: string) => Promise<AuthErrorCode | null>;
  signOut: () => Promise<void>;
  // Bounce to login state without an explicit sign-out — used when a
  // protected request returns 401 (token expired mid-use).
  forceSignOut: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('hydrating');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [lastSignOutReason, setLastSignOutReason] = useState<SignOutReason | null>(null);

  // Hydrate on mount: if a token exists in main, validate it via /me.
  useEffect(() => {
    let cancelled = false;
    window.api
      .getCurrentUser()
      .then((u) => {
        if (cancelled) return;
        if (u) {
          setUser(u);
          setStatus('authenticated');
        } else {
          setUser(null);
          setStatus('unauthenticated');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setUser(null);
          setStatus('unauthenticated');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleResult = useCallback((result: AuthResult): AuthErrorCode | null => {
    if (result.ok) {
      setUser(result.user);
      setStatus('authenticated');
      // Clear any prior reason — successful auth means the session-expired
      // banner shouldn't reappear if the user signs out again later.
      setLastSignOutReason(null);
      return null;
    }
    return result.code;
  }, []);

  const signIn = useCallback(
    async (email: string, password: string): Promise<AuthErrorCode | null> => {
      const result = await window.api.signIn({ email, password });
      return handleResult(result);
    },
    [handleResult],
  );

  const signUp = useCallback(
    async (email: string, password: string): Promise<AuthErrorCode | null> => {
      const result = await window.api.signUp({ email, password });
      return handleResult(result);
    },
    [handleResult],
  );

  const signOut = useCallback(async (): Promise<void> => {
    await window.api.signOut();
    setLastSignOutReason('user');
    setUser(null);
    setStatus('unauthenticated');
  }, []);

  const forceSignOut = useCallback((): void => {
    setLastSignOutReason('session-expired');
    setUser(null);
    setStatus('unauthenticated');
    // Fire-and-forget the remote sign-out; we don't await because the token
    // may already be invalid and we don't want to block the UI.
    void window.api.signOut();
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, lastSignOutReason, signIn, signUp, signOut, forceSignOut }),
    [status, user, lastSignOutReason, signIn, signUp, signOut, forceSignOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
