import type {
  AuthCredentials,
  AuthErrorCode,
  AuthResult,
  AuthUser,
  BackendErrorCode,
  ExplainRequest,
  TranslateRequest,
  TranslateResponse,
  TranslateResultWire,
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

// --- AI: /api/translate (synchronous JSON) ---------------------------------

export async function translate(request: TranslateRequest): Promise<TranslateResultWire> {
  let result: PostResult;
  try {
    result = await postJson('/api/translate', request, { auth: true });
  } catch {
    return { ok: false, code: 'network' };
  }
  if (result.status === 200) {
    const data = result.json as TranslateResponse | null;
    if (!data || typeof data !== 'object') return { ok: false, code: 'server' };
    return { ok: true, data };
  }
  if (result.status === 401) {
    clearToken();
    return { ok: false, code: 'unauthorized' };
  }
  if (result.status === 429) return { ok: false, code: 'rate_limit' };
  return { ok: false, code: 'server' };
}

// --- AI: /api/explain (SSE stream) -----------------------------------------

export type ExplainStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done' }
  | { type: 'error'; code: BackendErrorCode };

/**
 * Connects to /api/explain and yields events as they arrive. The caller
 * passes an AbortSignal to cancel mid-stream. The generator always
 * terminates with either a 'done' or 'error' event before returning, OR
 * returns silently on AbortSignal cancellation.
 */
export async function* explain(
  request: ExplainRequest,
  signal: AbortSignal,
): AsyncGenerator<ExplainStreamEvent, void, void> {
  const token = getToken();
  if (!token) {
    yield { type: 'error', code: 'unauthorized' };
    return;
  }

  const body = JSON.stringify({
    command: request.command,
    output: request.output,
    exitCode: request.exitCode,
  });

  let response: Response;
  try {
    response = await fetch(`${BACKEND_URL}/api/explain`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${token}`,
        Origin: DESKTOP_ORIGIN,
      },
      body,
      signal,
    });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return;
    yield { type: 'error', code: 'network' };
    return;
  }

  if (response.status === 401) {
    clearToken();
    yield { type: 'error', code: 'unauthorized' };
    return;
  }
  if (response.status === 429) {
    yield { type: 'error', code: 'rate_limit' };
    return;
  }
  if (response.status !== 200 || !response.body) {
    yield { type: 'error', code: 'server' };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Each SSE event is separated by `\n\n`. Process complete events.
      let frameEnd: number;
      while ((frameEnd = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, frameEnd);
        buffer = buffer.slice(frameEnd + 2);

        // SSE spec: an event can have multiple `data:` lines that are
        // joined with `\n`. Concatenate them.
        const dataLines: string[] = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('data: ')) dataLines.push(line.slice(6));
          else if (line.startsWith('data:')) dataLines.push(line.slice(5));
        }
        if (dataLines.length === 0) continue;
        const data = dataLines.join('\n');

        if (data === '[DONE]') {
          yield { type: 'done' };
          return;
        }
        if (data.startsWith('[ERROR]')) {
          // Backend signaled a mid-stream error after SSE headers were
          // already sent. Surface as a generic server error — the message
          // text is calm by construction (we wrote it) but the renderer
          // already has a calm error renderer for this code path.
          yield { type: 'error', code: 'server' };
          return;
        }
        yield { type: 'delta', text: data };
      }
    }
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return;
    yield { type: 'error', code: 'network' };
    return;
  }

  // Stream ended without an explicit [DONE] — treat as done.
  yield { type: 'done' };
}
