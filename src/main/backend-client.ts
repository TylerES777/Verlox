import type {
  AuthCredentials,
  AuthErrorCode,
  AuthResult,
  AuthUser,
} from '@shared/types';
import { BACKEND_URL } from './config.js';
import { clearToken, getToken, setToken } from './auth-store.js';

interface SignInResponse {
  token: string;
  user: { id: string; email: string };
}

interface MeResponse {
  user: { id: string; email: string };
}

interface PostResult {
  status: number;
  json: unknown;
  rawText: string;
  contentType: string | null;
}

// Stable synthetic origin used by the Vorlox desktop client. better-auth's
// CSRF check on /auth/* endpoints requires Origin in TRUSTED_ORIGINS;
// Electron's renderer doesn't send a meaningful Origin, so we set our own.
// The backend's TRUSTED_ORIGINS env var must include this exact string.
// Documented as a convention in backend/README.md.
const DESKTOP_ORIGIN = 'app://vorlox';

function authError(code: AuthErrorCode, message?: string): AuthResult {
  return { ok: false, code, message };
}

function authSuccess(user: AuthUser): AuthResult {
  return { ok: true, user };
}

async function postJson(
  path: string,
  body: unknown,
  opts: { auth?: boolean } = {},
): Promise<PostResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Origin: DESKTOP_ORIGIN,
  };
  if (opts.auth) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${BACKEND_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  // Read body as text first; only attempt JSON.parse when content-type
  // says it's JSON. Prevents an unhandled SyntaxError when an upstream
  // proxy returns plain text or an HTML error page.
  const rawText = await response.text();
  const contentType = response.headers.get('content-type');

  let json: unknown = null;
  if (rawText.length > 0 && contentType?.toLowerCase().includes('application/json')) {
    try {
      json = JSON.parse(rawText);
    } catch {
      // body claimed to be JSON but failed to parse — surface via status
    }
  }

  return { status: response.status, json, rawText, contentType };
}

// --- Auth ------------------------------------------------------------------

export async function signUp(credentials: AuthCredentials): Promise<AuthResult> {
  let result: PostResult;
  try {
    result = await postJson('/auth/sign-up/email', credentials);
  } catch {
    return authError('network');
  }
  if (result.status === 200) {
    const data = result.json as SignInResponse | null;
    if (!data?.token || !data.user?.id) return authError('server');
    setToken(data.token);
    return authSuccess({ id: data.user.id, email: data.user.email });
  }
  if (result.status === 409) return authError('email_exists');
  if (result.status === 400)
    return authError('invalid_input', extractMessage(result.json));
  if (result.status === 429) return authError('rate_limit');
  return authError('server');
}

export async function signIn(credentials: AuthCredentials): Promise<AuthResult> {
  let result: PostResult;
  try {
    result = await postJson('/auth/sign-in/email', credentials);
  } catch {
    return authError('network');
  }
  if (result.status === 200) {
    const data = result.json as SignInResponse | null;
    if (!data?.token || !data.user?.id) return authError('server');
    setToken(data.token);
    return authSuccess({ id: data.user.id, email: data.user.email });
  }
  if (result.status === 401) return authError('invalid_credentials');
  if (result.status === 400)
    return authError('invalid_input', extractMessage(result.json));
  if (result.status === 429) return authError('rate_limit');
  return authError('server');
}

export async function signOut(): Promise<void> {
  // Best-effort — clear the local token even if the remote call fails.
  // The backend session row will eventually expire on its own.
  try {
    await postJson('/auth/sign-out', {}, { auth: true });
  } catch {
    // network error during sign-out — local clear still proceeds
  }
  clearToken();
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  const token = getToken();
  if (!token) return null;

  let response: Response;
  try {
    response = await fetch(`${BACKEND_URL}/me`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: DESKTOP_ORIGIN,
      },
    });
  } catch {
    return null;
  }

  if (response.status === 200) {
    try {
      const data = (await response.json()) as MeResponse | null;
      if (data?.user) return { id: data.user.id, email: data.user.email };
    } catch {
      // 200 but body not JSON — treat as not authenticated
    }
    return null;
  }
  if (response.status === 401) {
    clearToken();
    return null;
  }
  return null;
}

function extractMessage(json: unknown): string | undefined {
  if (json && typeof json === 'object' && 'message' in json) {
    const m = (json as { message: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return undefined;
}
