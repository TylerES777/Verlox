import type {
  AuthCredentials,
  AuthErrorCode,
  AuthResult,
  AuthUser,
  BackendErrorCode,
  DiagramRequest,
  DiagramResultWire,
  DiagramSchema,
  ExecutionLogEntry,
  PlanResponse,
  TurnInput,
  TurnResultWire,
  UsageInfo,
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

// Stable synthetic origin used by the Verlox desktop client. better-auth's
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

// --- AI: /api/turn (synchronous JSON) --------------------------------------

export async function planTurn(input: TurnInput): Promise<TurnResultWire> {
  let result: PostResult;
  try {
    result = await postJson('/api/turn', input, { auth: true });
  } catch {
    return { ok: false, code: 'network' };
  }
  if (result.status === 200) {
    const data = result.json as PlanResponse | null;
    if (!data || typeof data !== 'object') return { ok: false, code: 'server' };
    return { ok: true, data };
  }
  if (result.status === 401) {
    clearToken();
    return { ok: false, code: 'unauthorized' };
  }
  // 402 Payment Required = out of credits for the current period. Distinct
  // code so the renderer shows the run-out popup, not a generic error.
  if (result.status === 402) return { ok: false, code: 'limit_reached' };
  // 403 = a free-tier feature cap (daily images or monthly Plan Mode). The
  // body carries `cap` so the UI can name the exact limit that was hit.
  if (result.status === 403) {
    const body = result.json as { cap?: unknown } | null;
    const cap =
      body?.cap === 'images' || body?.cap === 'thinkMode'
        ? body.cap
        : undefined;
    return { ok: false, code: 'feature_capped', cap };
  }
  if (result.status === 429) return { ok: false, code: 'rate_limit' };
  return { ok: false, code: 'server' };
}

// --- AI: /api/usage (free-tier consumption for the current month) ----------

export async function getUsage(): Promise<UsageInfo | null> {
  let response: Response;
  try {
    const token = getToken();
    if (!token) return null;
    response = await fetch(`${BACKEND_URL}/api/usage`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: DESKTOP_ORIGIN,
      },
    });
  } catch {
    return null;
  }
  if (response.status !== 200) {
    if (response.status === 401) clearToken();
    return null;
  }
  try {
    const data = (await response.json()) as UsageInfo | null;
    if (!data || typeof data.used !== 'number' || typeof data.limit !== 'number') {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

// --- Billing: Stripe checkout + customer portal ----------------------------

import type { BillingErrorCode, BillingStatus } from '@shared/types';

// GET /api/billing/status → current plan + renew/cancel date. Returns null
// on any failure (the menu just omits the line).
export async function getBillingStatus(): Promise<BillingStatus | null> {
  try {
    const token = getToken();
    if (!token) return null;
    const response = await fetch(`${BACKEND_URL}/api/billing/status`, {
      headers: { Authorization: `Bearer ${token}`, Origin: DESKTOP_ORIGIN },
    });
    if (response.status !== 200) {
      if (response.status === 401) clearToken();
      return null;
    }
    const data = (await response.json()) as BillingStatus | null;
    if (!data || typeof data.tier !== 'string') return null;
    return data;
  } catch {
    return null;
  }
}

interface BillingUrlResult {
  ok: boolean;
  url?: string;
  error?: BillingErrorCode;
  alreadySubscribed?: boolean;
}

// POST /api/billing/checkout → { url } (Stripe Checkout). The caller (main
// process) opens the URL in the browser. Errors are mapped to a calm code.
// If the user already has a live subscription the backend returns a portal
// URL + alreadySubscribed:true instead of a fresh checkout.
export async function createCheckoutSession(): Promise<BillingUrlResult> {
  let result: PostResult;
  try {
    result = await postJson('/api/billing/checkout', {}, { auth: true });
  } catch {
    return { ok: false, error: 'network' };
  }
  if (result.status === 200) {
    const data = result.json as
      | { url?: string; alreadySubscribed?: boolean }
      | null;
    if (data?.url)
      return {
        ok: true,
        url: data.url,
        alreadySubscribed: data.alreadySubscribed ?? false,
      };
    return { ok: false, error: 'server' };
  }
  if (result.status === 401) {
    clearToken();
    return { ok: false, error: 'unauthorized' };
  }
  if (result.status === 503) return { ok: false, error: 'not_configured' };
  return { ok: false, error: 'server' };
}

// POST /api/billing/portal → { url } (Stripe customer portal).
export async function createPortalSession(): Promise<BillingUrlResult> {
  let result: PostResult;
  try {
    result = await postJson('/api/billing/portal', {}, { auth: true });
  } catch {
    return { ok: false, error: 'network' };
  }
  if (result.status === 200) {
    const data = result.json as { url?: string } | null;
    if (data?.url) return { ok: true, url: data.url };
    return { ok: false, error: 'server' };
  }
  if (result.status === 401) {
    clearToken();
    return { ok: false, error: 'unauthorized' };
  }
  if (result.status === 400) return { ok: false, error: 'no_account' };
  if (result.status === 503) return { ok: false, error: 'not_configured' };
  return { ok: false, error: 'server' };
}

// --- AI: /api/diagram (synchronous JSON) -----------------------------------

export async function generateDiagram(
  request: DiagramRequest,
): Promise<DiagramResultWire> {
  let result: PostResult;
  try {
    result = await postJson('/api/diagram', request, { auth: true });
  } catch {
    return { ok: false, code: 'network' };
  }
  if (result.status === 200) {
    const data = result.json as DiagramSchema | null;
    if (!data || typeof data !== 'object' || !Array.isArray(data.groups)) {
      return { ok: false, code: 'server' };
    }
    return { ok: true, data };
  }
  if (result.status === 401) {
    clearToken();
    return { ok: false, code: 'unauthorized' };
  }
  if (result.status === 429) return { ok: false, code: 'rate_limit' };
  return { ok: false, code: 'server' };
}

// --- AI: /api/synthesize (SSE stream) --------------------------------------
//
// Backend's SSE protocol changed in Phase 4 Chunk 1: each `data:` line is
// now a JSON-encoded object with a `type` field (`delta`, `done`, `error`),
// instead of Phase 3.3's raw-text-with-sentinel-strings approach. This
// parser JSON.parses every data event.

export type SynthesizeStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done' }
  | { type: 'error'; code: BackendErrorCode };

interface SynthesizeRequestBody {
  planId: string;
  intent: string;
  plan: string;
  executionLog: ExecutionLogEntry[];
}

/**
 * Connects to /api/synthesize and yields events as they arrive. The
 * caller passes an AbortSignal to cancel mid-stream. The generator
 * always terminates with either a 'done' or 'error' event before
 * returning, OR returns silently on AbortSignal cancellation.
 */
export async function* synthesize(
  request: SynthesizeRequestBody,
  signal: AbortSignal,
): AsyncGenerator<SynthesizeStreamEvent, void, void> {
  const token = getToken();
  if (!token) {
    yield { type: 'error', code: 'unauthorized' };
    return;
  }

  let response: Response;
  try {
    response = await fetch(`${BACKEND_URL}/api/synthesize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${token}`,
        Origin: DESKTOP_ORIGIN,
      },
      body: JSON.stringify(request),
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
        const dataText = dataLines.join('\n');

        // Each data is a JSON-encoded event object.
        let parsed: { type?: unknown; text?: unknown; message?: unknown };
        try {
          parsed = JSON.parse(dataText);
        } catch {
          // Malformed event — skip rather than fail the whole stream.
          continue;
        }

        if (parsed.type === 'delta' && typeof parsed.text === 'string') {
          yield { type: 'delta', text: parsed.text };
        } else if (parsed.type === 'done') {
          yield { type: 'done' };
          return;
        } else if (parsed.type === 'error') {
          // Backend signaled a mid-stream error after SSE headers were sent.
          // Body's `message` is calm by construction (mapAnthropicError);
          // we just lift the type and surface the BackendErrorCode.
          yield { type: 'error', code: 'server' };
          return;
        }
      }
    }
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return;
    yield { type: 'error', code: 'network' };
    return;
  }

  // Stream ended without an explicit done event — treat as done.
  yield { type: 'done' };
}
