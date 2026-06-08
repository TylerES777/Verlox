import { app } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, stat, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createUnzip } from 'node:zlib';

// Bundled-in-app local model. Owns three things end to end:
//   1. The llama.cpp server BINARY (downloaded once, ~30 MB).
//   2. The model WEIGHTS (downloaded once, ~2 GB).
//   3. The running SERVER process (spawned on first use; killed on app quit).
//
// The server exposes an OpenAI-compatible /v1/chat/completions endpoint, so
// the existing agent-openai.ts adapter does the actual planning work — we
// just point it at http://127.0.0.1:<port>/v1 with any non-empty key.
//
// On first use, the renderer subscribes to onProgress; main streams
// download + boot status events; once status === 'ready' the renderer can
// route turns through engine:'local'.

// ----- Configuration --------------------------------------------------------
// Pinned versions so reproducible builds across users. Bump these two
// constants together when refreshing. Env overrides (LOCAL_MODEL_*_URL)
// let us patch a bad URL without a code release.
const LLAMA_RELEASE_TAG = 'b6024';
const BINARY_URL =
  process.env.LOCAL_MODEL_BINARY_URL ??
  `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_RELEASE_TAG}/llama-${LLAMA_RELEASE_TAG}-bin-win-cpu-x64.zip`;
const WEIGHTS_URL =
  process.env.LOCAL_MODEL_WEIGHTS_URL ??
  'https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf';
const WEIGHTS_FILENAME = 'llama-3.2-3b-instruct-q4.gguf';
const BINARY_NAME = 'llama-server.exe';
// Sanity floor for the weights file. A real Q4_K_M Llama 3.2 3B is ~2.0 GB;
// anything under this is a truncated download from a previous run and must
// be re-fetched rather than handed to llama-server (which would just crash
// with the cryptic "failed to load model" we saw before this check existed).
const WEIGHTS_MIN_BYTES = 1_500_000_000;

// ----- Public types --------------------------------------------------------
export type LocalModelState =
  | { kind: 'idle' } // never used this session; nothing running, files may or may not exist
  | { kind: 'checking' } // probing the filesystem
  | { kind: 'downloading'; what: 'binary' | 'weights'; bytes: number; total: number }
  | { kind: 'unpacking' }
  | { kind: 'starting' } // spawning the server, waiting for it to listen
  | { kind: 'ready'; port: number }
  | { kind: 'error'; message: string };

export interface LocalModelStatus {
  state: LocalModelState;
  // Set once both files exist on disk — drives the picker label between
  // "Download to use" and just the model name.
  installed: boolean;
}

// ----- Module state --------------------------------------------------------
let currentState: LocalModelState = { kind: 'idle' };
let installed = false;
let listeners = new Set<(s: LocalModelStatus) => void>();
let server: ChildProcess | null = null;
let serverPort: number | null = null;
// A single "ensure ready" promise so concurrent renderer calls don't kick off
// two parallel downloads / server boots. They all await the same job.
let readyJob: Promise<number> | null = null;
// Live download controller (one in flight at a time). cancel() aborts the
// fetch + stream, the downloader catches the AbortError, deletes the partial
// file, and the ensureReady job rejects with CANCELLED so callers know to
// stay quiet instead of surfacing an error.
let downloadController: AbortController | null = null;
let cancelled = false;
// Sentinel — thrown when the user cancels. Recognized in ensureReady so the
// failure becomes a clean `state: 'idle'` instead of `state: 'error'`.
const CANCELLED = new Error('cancelled');

function modelDir(): string {
  return join(app.getPath('userData'), 'local-models');
}
function binaryPath(): string {
  return join(modelDir(), BINARY_NAME);
}
function weightsPath(): string {
  return join(modelDir(), WEIGHTS_FILENAME);
}

function setState(s: LocalModelState): void {
  currentState = s;
  for (const l of listeners) l({ state: s, installed });
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// True when the weights file on disk is present AND looks complete. A file
// that exists but is short is a previously-truncated download — we treat
// it as missing so the next ensureReady() re-fetches it instead of handing
// llama-server a half-GGUF and getting a cryptic load failure.
async function weightsComplete(): Promise<boolean> {
  try {
    const s = await stat(weightsPath());
    if (s.size < WEIGHTS_MIN_BYTES) {
      // Drop the truncated file so the download phase doesn't see a
      // ghost-exists check and skip the re-fetch.
      await rm(weightsPath(), { force: true }).catch(() => {});
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// Refresh `installed` from disk. Cheap (two stat calls), called before
// status reads so the picker reflects reality. The weights check uses
// the size sanity floor so a truncated file (from a past cancelled or
// flaky download) doesn't masquerade as "installed".
async function refreshInstalled(): Promise<void> {
  installed = (await exists(binaryPath())) && (await weightsComplete());
}

// ----- Public API ----------------------------------------------------------

export async function getStatus(): Promise<LocalModelStatus> {
  await refreshInstalled();
  return { state: currentState, installed };
}

export function subscribe(fn: (s: LocalModelStatus) => void): () => void {
  listeners.add(fn);
  // Fire current state once so the renderer reflects reality immediately.
  void getStatus().then(fn);
  return () => listeners.delete(fn);
}

/**
 * Ensure the binary + weights are downloaded and the server is listening.
 * Returns the local port. Idempotent — repeated calls during a single boot
 * share the same promise so concurrent requests don't trigger duplicate work.
 */
export function ensureReady(): Promise<number> {
  if (server && serverPort !== null && currentState.kind === 'ready') {
    return Promise.resolve(serverPort);
  }
  if (readyJob) return readyJob;
  cancelled = false;
  readyJob = (async () => {
    try {
      await mkdir(modelDir(), { recursive: true });
      await refreshInstalled();

      if (!(await exists(binaryPath()))) {
        await downloadBinary();
      }
      // weightsComplete() also auto-deletes a too-small truncated file so the
      // re-download starts clean instead of resuming garbage.
      if (!(await weightsComplete())) {
        await downloadWeights();
      }
      installed = true;
      return await startServer();
    } catch (e) {
      // User-initiated cancel: clean idle state, swallow the error so the
      // renderer doesn't surface a scary message for an action it just took.
      if (e === CANCELLED || (e instanceof Error && e.name === 'AbortError')) {
        setState({ kind: 'idle' });
        readyJob = null;
        throw CANCELLED;
      }
      const message = e instanceof Error ? e.message : String(e);
      setState({ kind: 'error', message });
      readyJob = null;
      throw e;
    }
  })();
  return readyJob;
}

/**
 * Cancel an in-progress install OR dismiss a stale error. Aborts the active
 * download (drops the partial file), and resets state to idle so the user
 * can pick a different model or retry cleanly. Safe to call at any state.
 * When called while in 'error' or any non-download state, this is purely a
 * "dismiss" — the same call drives both the modal's Cancel button during a
 * download and the Use-a-hosted-model / Try-again buttons after a failure.
 */
export function cancel(): void {
  cancelled = true;
  if (downloadController) {
    try { downloadController.abort(); } catch { /* ignore */ }
  }
  // If nothing was actively downloading (e.g. user is clicking "dismiss"
  // on a failed boot), still flip the state so the modal closes. We don't
  // touch 'ready' (that's a working server, not a failure to dismiss).
  if (currentState.kind !== 'ready' && currentState.kind !== 'idle') {
    setState({ kind: 'idle' });
    readyJob = null;
  }
}

/**
 * Base URL the agent should call. Only valid once status.state.kind === 'ready'.
 * Returns the trailing /v1 the OpenAI adapter expects.
 */
export function localBaseUrl(): string | null {
  if (currentState.kind !== 'ready') return null;
  return `http://127.0.0.1:${currentState.port}/v1`;
}

/** Stop the server (called on app quit). Idempotent. */
export function shutdown(): void {
  if (server && !server.killed) {
    try {
      server.kill();
    } catch {
      /* ignore */
    }
  }
  server = null;
  serverPort = null;
}

// ----- Downloads -----------------------------------------------------------

async function downloadBinary(): Promise<void> {
  setState({ kind: 'downloading', what: 'binary', bytes: 0, total: 0 });
  const zipPath = join(modelDir(), 'llama-binary.zip');
  try {
    await downloadTo(BINARY_URL, zipPath, (bytes, total) =>
      setState({ kind: 'downloading', what: 'binary', bytes, total }),
    );
  } catch (e) {
    // Partial zip on cancel/failure is useless — remove it so the next attempt
    // starts clean. AbortError + our CANCELLED sentinel both land here.
    await rm(zipPath, { force: true }).catch(() => {});
    throw e;
  }
  if (cancelled) throw CANCELLED;
  setState({ kind: 'unpacking' });
  await unzipLlamaServer(zipPath, modelDir());
  await rm(zipPath, { force: true });
  if (!(await exists(binaryPath()))) {
    throw new Error(
      `Downloaded llama.cpp release does not contain ${BINARY_NAME}. Check LOCAL_MODEL_BINARY_URL.`,
    );
  }
}

async function downloadWeights(): Promise<void> {
  setState({ kind: 'downloading', what: 'weights', bytes: 0, total: 0 });
  try {
    await downloadTo(WEIGHTS_URL, weightsPath(), (bytes, total) =>
      setState({ kind: 'downloading', what: 'weights', bytes, total }),
    );
  } catch (e) {
    // Partial weights file is useless — Llama needs the whole GGUF. Drop it.
    await rm(weightsPath(), { force: true }).catch(() => {});
    throw e;
  }
}

// Stream a URL to disk with progress callbacks. Handles HF/GitHub redirects
// (3xx) by re-fetching the Location target. The shared AbortController in
// `downloadController` lets cancel() kill both the fetch and the stream.
async function downloadTo(
  url: string,
  dest: string,
  onProgress: (bytes: number, total: number) => void,
): Promise<void> {
  downloadController = new AbortController();
  const signal = downloadController.signal;
  try {
    // Follow up to 5 redirects (HF redirects to a signed CDN URL).
    let current = url;
    let res: Response | null = null;
    for (let i = 0; i < 5; i++) {
      res = await fetch(current, { redirect: 'manual', signal });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        current = new URL(res.headers.get('location')!, current).toString();
        continue;
      }
      break;
    }
    if (!res || !res.ok || !res.body) {
      throw new Error(`Download failed: HTTP ${res?.status ?? '???'} for ${url}`);
    }
    const total = Number(res.headers.get('content-length') ?? 0);
    let bytes = 0;
    let lastNotify = 0;
    // Web ReadableStream → Node Readable so we can pipeline() to a file.
    const node = (await import('node:stream')).Readable.fromWeb(
      res.body as unknown as import('node:stream/web').ReadableStream,
    );
    const sink = createWriteStream(dest);
    node.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      // Throttle progress events to ~10/sec — the renderer doesn't need every byte.
      const now = Date.now();
      if (now - lastNotify > 100) {
        lastNotify = now;
        onProgress(bytes, total);
      }
    });
    // Pass the signal to pipeline too so an in-flight abort tears down the
    // write side (otherwise the sink stays open until the source errors).
    await pipeline(node as Readable, sink, { signal });
    // Verify the full payload arrived. fetch + pipeline both resolve when
    // the upstream simply ends — without this check, a TCP reset midway
    // through a 2 GB download leaves a truncated file that passes
    // exists() and then crashes llama-server on load. We compare against
    // the server's Content-Length when present, since that's the most
    // reliable signal a CDN can give us.
    if (total > 0 && bytes < total) {
      throw new Error(
        `Download truncated: got ${bytes} of ${total} bytes (${Math.round((bytes / total) * 100)}%). Check your connection and try again.`,
      );
    }
    onProgress(bytes, total);
  } finally {
    downloadController = null;
  }
}

// Extract llama-server.exe (and any DLLs it depends on) from the zip into
// modelDir. The official llama.cpp Windows zip contains a flat set of files;
// we want llama-server.exe + every .dll alongside it.
async function unzipLlamaServer(zip: string, destDir: string): Promise<void> {
  // adm-zip / yauzl would be cleaner; using built-in zlib + manual zip parse
  // is risky for arbitrary archives. Shell out to PowerShell's
  // Expand-Archive, which ships on every Win10+ machine.
  const { spawnSync } = await import('node:child_process');
  // -Force overwrites if a stale partial extraction exists.
  const res = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-Command', `Expand-Archive -Force -Path '${zip}' -DestinationPath '${destDir}'`],
    { stdio: 'pipe' },
  );
  if (res.status !== 0) {
    throw new Error(`Failed to unzip llama.cpp binary: ${res.stderr?.toString() ?? 'unknown'}`);
  }
  // Some llama.cpp releases nest files in a subfolder. Flatten by moving
  // any llama-server.exe found below the dest up one level.
  const found = await findFile(destDir, BINARY_NAME);
  if (found && found !== binaryPath()) {
    const { rename } = await import('node:fs/promises');
    // Move the binary + everything in its folder (DLLs) to modelDir.
    const { dirname } = await import('node:path');
    const srcDir = dirname(found);
    for (const entry of await readdir(srcDir)) {
      await rename(join(srcDir, entry), join(destDir, entry)).catch(() => {});
    }
  }
  // createUnzip is referenced only to keep zlib bundled if we swap to a
  // streaming unzip later; unused otherwise.
  void createUnzip;
}

async function findFile(dir: string, name: string): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return p;
    if (e.isDirectory()) {
      const sub = await findFile(p, name);
      if (sub) return sub;
    }
  }
  return null;
}

// ----- Server lifecycle ----------------------------------------------------

// Ask the OS for a free port instead of guessing — avoids fighting users
// who have something on 8080 / 11434 / etc.
function pickPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (typeof addr === 'object' && addr) {
        const p = addr.port;
        srv.close(() => resolve(p));
      } else {
        srv.close();
        reject(new Error('Could not allocate a local port for the model server.'));
      }
    });
    srv.on('error', reject);
  });
}

async function startServer(): Promise<number> {
  setState({ kind: 'starting' });
  const port = await pickPort();
  // llama-server flags:
  //   -m         the model file
  //   --port     listen on the free port we just picked
  //   --host     loopback only — never accept external connections
  //   -c 8192    8K context (3B model handles this fine; bigger = more RAM)
  //   --jinja    enable jinja chat templates so the model honors the
  //              system + user roles the OpenAI API sends
  const args = [
    '-m', weightsPath(),
    '--port', String(port),
    '--host', '127.0.0.1',
    '-c', '8192',
    '--jinja',
  ];
  // Pipe stdio so we can persist server output to a log file. Without this
  // a crash on boot is invisible — we'd see "didn't become ready" with no
  // hint why. The log file lives next to the binary and is overwritten on
  // each boot; renderer-facing error message references it.
  const { createWriteStream: createLog } = await import('node:fs');
  const logPath = join(modelDir(), 'llama-server.log');
  const logStream = createLog(logPath, { flags: 'w' });
  const child = spawn(binaryPath(), args, {
    cwd: modelDir(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout?.pipe(logStream);
  child.stderr?.pipe(logStream);
  // Capture the tail of stderr in memory so we can surface a useful snippet
  // when boot fails (without forcing the user to open a log file).
  let stderrTail = '';
  child.stderr?.on('data', (b: Buffer) => {
    stderrTail = (stderrTail + b.toString('utf8')).slice(-1200);
  });

  // If the server dies during boot, exitedDuringBoot flips so the poller
  // can fail fast with a real reason (exit code + log file pointer) instead
  // of waiting out the full timeout.
  let exitedDuringBoot: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  child.on('exit', (code, signal) => {
    if (currentState.kind === 'starting') {
      exitedDuringBoot = { code, signal };
    } else if (currentState.kind === 'ready') {
      setState({ kind: 'error', message: `Local model server exited (code ${code ?? 'null'}).` });
    }
    server = null;
    serverPort = null;
    readyJob = null;
  });
  server = child;

  // Poll /health (and /v1/models as a fallback for older llama-server
  // builds) for up to 60s. First-time loads on a slow disk can take ~30s
  // for a 2GB Q4 GGUF, so the timeout has real headroom now.
  const healthUrl = `http://127.0.0.1:${port}/health`;
  const modelsUrl = `http://127.0.0.1:${port}/v1/models`;
  const start = Date.now();
  while (Date.now() - start < 60_000) {
    // Fast-fail: if the child already exited, no point polling.
    if (exitedDuringBoot) {
      const { code, signal } = exitedDuringBoot;
      const why = signal ? `signal ${signal}` : `code ${code ?? 'null'}`;
      const tail = stderrTail.trim().split('\n').slice(-3).join(' · ');
      throw new Error(
        `Local model server exited during boot (${why}). ${tail || `See ${logPath}`}`,
      );
    }
    try {
      const r = await fetch(healthUrl);
      if (r.ok) {
        serverPort = port;
        setState({ kind: 'ready', port });
        return port;
      }
    } catch {
      /* not listening yet */
    }
    try {
      const r = await fetch(modelsUrl);
      if (r.ok) {
        serverPort = port;
        setState({ kind: 'ready', port });
        return port;
      }
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error(
    `Local model server did not become ready within 60 seconds. Check ${logPath} for details.`,
  );
}
