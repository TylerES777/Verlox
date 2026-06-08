// Detect a local Ollama runtime and list the models the user has pulled.
// Ollama runs a local HTTP server on port 11434 (default, no auth) and
// exposes both its native /api/tags endpoint (for listing) and an
// OpenAI-compatible /v1/chat/completions endpoint (which we reuse via the
// existing agent-openai.ts path — no new wire code).
//
// 127.0.0.1 (NOT 'localhost'): on Windows, 'localhost' can resolve to ::1
// first and then time out for ~2 seconds before falling back to IPv4 if
// Ollama bound IPv4-only. Pinning to 127.0.0.1 makes detection instant.

const OLLAMA_HOST = 'http://127.0.0.1:11434';
// OpenAI-compatible base used by the agent dispatcher when an Ollama model
// is picked (the OpenAI adapter appends "/chat/completions" to this).
export const OLLAMA_OPENAI_BASE_URL = `${OLLAMA_HOST}/v1`;

export interface OllamaModelInfo {
  // Full tag the API accepts (e.g. "llama3.3:70b", "qwen2.5:32b-instruct").
  name: string;
  // Approx download size in bytes, for the UI to show "70B · 40GB".
  sizeBytes: number;
  // Parameter-size hint when Ollama reports it (e.g. "70B"), else null.
  paramSize: string | null;
}

export interface OllamaProbe {
  // True iff the Ollama HTTP server is reachable AND returned a model list.
  available: boolean;
  models: OllamaModelInfo[];
}

// Two-second budget total: a 1.5s connect/read timeout via AbortController
// keeps the renderer responsive on machines where Ollama isn't installed
// (default: connection refused returns immediately anyway).
const PROBE_TIMEOUT_MS = 1500;

interface RawTagsResponse {
  models?: Array<{
    name?: unknown;
    size?: unknown;
    details?: { parameter_size?: unknown };
  }>;
}

/**
 * Probe the local Ollama instance and return the list of pulled models.
 * Never throws — a missing/dead Ollama just yields { available: false }.
 */
export async function probeOllama(): Promise<OllamaProbe> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: ac.signal });
    if (!res.ok) return { available: false, models: [] };
    const body = (await res.json()) as RawTagsResponse;
    const list = Array.isArray(body.models) ? body.models : [];
    const models: OllamaModelInfo[] = list
      .map((m) => {
        const name = typeof m.name === 'string' ? m.name : '';
        if (!name) return null;
        const sizeBytes = typeof m.size === 'number' ? m.size : 0;
        const paramSize =
          typeof m.details?.parameter_size === 'string' ? m.details.parameter_size : null;
        return { name, sizeBytes, paramSize };
      })
      .filter((m): m is OllamaModelInfo => m !== null)
      // Stable alphabetical order so the picker doesn't shuffle between probes.
      .sort((a, b) => a.name.localeCompare(b.name));
    return { available: true, models };
  } catch {
    // Connection refused / aborted / DNS — Ollama isn't running. Quiet by
    // design; the picker shows the install prompt instead.
    return { available: false, models: [] };
  } finally {
    clearTimeout(timer);
  }
}
