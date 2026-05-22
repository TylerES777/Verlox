import { useEffect, useReducer } from 'react';
import type { Shell } from '@shared/types';

// Live processes board data layer.
//
// useCommands writes to this registry on STEP_START / STEP_OUTPUT /
// STEP_DONE so the registry always reflects the live state of every
// long-lived shell process the user has running. Components read via
// useRunningProcesses() (subscribed) or readRunningProcesses() (sync).
//
// Recently-exited entries linger for a short window so the user can
// click Restart on a process that just crashed without it vanishing
// from the list mid-click. After the window, they're dropped.

export type ProcessStatus =
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface RunningProcess {
  // The step id used by window.api.stopCommand. Globally unique.
  stepId: string;
  // The conversation the user originally triggered this from. Used to
  // jump back when the user clicks a row, and to pre-fill the input
  // there for the "ask Verlox why" button.
  conversationId: string;
  // Shell + cwd + command — enough to re-spawn on Restart.
  command: string;
  cwd: string;
  shell: Shell;
  status: ProcessStatus;
  // Set when the process exits.
  exitCode: number | null;
  // Epoch ms.
  startedAt: number;
  endedAt: number | null;
  // First localhost URL detected in stdout, if any. Surfaces an
  // "Open" button on the row.
  detectedUrl: string | null;
  // Last N lines of output, capped, for the "ask Verlox why" prompt
  // pre-fill on failure.
  tailOutput: string;
}

// How long to keep an exited process visible so the user can still
// see it / click restart. 60 seconds is a reasonable default.
const EXITED_TTL_MS = 60_000;
// Cap on the tail output we keep around — last ~4 KB is plenty for
// an "ask Verlox why" pre-fill, and bounds the registry's memory.
const TAIL_OUTPUT_MAX = 4_000;

// Match the first http(s)://<localhost-ish host> URL in the output,
// optionally with port and path. Powers the "Open" button on dev-server
// rows. Hosts covered:
//   localhost, 127.0.0.1, 0.0.0.0       — common bind addresses
//   [::], [::1], [0:0:0:0:0:0:0:0]      — IPv6 bind forms (Python's
//                                          http.server prints `http://[::]:8000/`
//                                          on Windows by default)
const LOCALHOST_URL_RE =
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[(?:::|::1|0:0:0:0:0:0:0:0|0:0:0:0:0:0:0:1)\])(?::\d+)?(?:\/[^\s)]*)?/;

// Python's stdlib http.server prints a banner like:
//   Serving HTTP on :: port 8000 (http://[::]:8000/) ...
// When the URL it offers is an unreachable bind host (`[::]`, `0.0.0.0`),
// rewrite it to `localhost` for the Open button — the browser can't open
// `http://[::]:8000` directly on Windows, but `http://localhost:8000` works.
function normalizeServerUrl(raw: string): string {
  return raw
    .replace(/\/\/\[(?:::|::1|0:0:0:0:0:0:0:0|0:0:0:0:0:0:0:1)\]/, '//localhost')
    .replace(/\/\/0\.0\.0\.0/, '//localhost');
}

const registry = new Map<string, RunningProcess>();
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((listener) => listener());
}

function snapshot(): RunningProcess[] {
  // Newest first so the most recently-started process sits at the
  // top of the board.
  return Array.from(registry.values()).sort(
    (a, b) => b.startedAt - a.startedAt,
  );
}

// Called by useCommands when a step starts. Registers the new
// process in 'running' state.
export function registerProcess(input: {
  stepId: string;
  conversationId: string;
  command: string;
  cwd: string;
  shell: Shell;
}): void {
  registry.set(input.stepId, {
    stepId: input.stepId,
    conversationId: input.conversationId,
    command: input.command,
    cwd: input.cwd,
    shell: input.shell,
    status: 'running',
    exitCode: null,
    startedAt: Date.now(),
    endedAt: null,
    detectedUrl: null,
    tailOutput: '',
  });
  notify();
}

// Called by useCommands on every stdout/stderr chunk. Appends to the
// tail buffer (capped) and detects a localhost URL on first sighting.
export function appendProcessOutput(stepId: string, chunk: string): void {
  const entry = registry.get(stepId);
  if (!entry) return;
  const combined = entry.tailOutput + chunk;
  const tail =
    combined.length > TAIL_OUTPUT_MAX
      ? combined.slice(combined.length - TAIL_OUTPUT_MAX)
      : combined;
  let detectedUrl = entry.detectedUrl;
  if (detectedUrl === null) {
    const match = LOCALHOST_URL_RE.exec(combined);
    if (match) detectedUrl = normalizeServerUrl(match[0]);
  }
  // Only notify if something actually changed beyond the tail buffer
  // (URL detection or status). Per-chunk re-renders of the board
  // would be expensive for a chatty process.
  const urlChanged = detectedUrl !== entry.detectedUrl;
  registry.set(stepId, { ...entry, tailOutput: tail, detectedUrl });
  if (urlChanged) notify();
}

// Called by useCommands on step exit. Flips status and schedules
// removal after the TTL window so the row stays visible long enough
// for the user to act on it.
export function finalizeProcess(
  stepId: string,
  result: { exitCode: number | null; signal: string | null },
): void {
  const entry = registry.get(stepId);
  if (!entry) return;
  // Map exit info into the same status categories the StepStatus uses.
  const status: ProcessStatus =
    result.signal != null
      ? 'cancelled'
      : result.exitCode === 0
        ? 'done'
        : 'failed';
  registry.set(stepId, {
    ...entry,
    status,
    exitCode: result.exitCode,
    endedAt: Date.now(),
  });
  notify();
  // Schedule cleanup. If the user restarts before the TTL, the new
  // process gets a different step id; this old entry will still be
  // dropped on its own timer.
  setTimeout(() => {
    registry.delete(stepId);
    notify();
  }, EXITED_TTL_MS);
}

// Used by the Restart action to capture the original command +
// metadata for re-spawning.
export function readProcess(stepId: string): RunningProcess | null {
  return registry.get(stepId) ?? null;
}

// Manual remove — drops the entry from the board immediately.
// Used by the Remove (X) button on each row so the user can clear
// stopped / failed / completed processes without waiting for the
// auto-TTL. Refuses to remove a still-running entry — they should
// stop it first.
export function removeProcess(stepId: string): void {
  const entry = registry.get(stepId);
  if (!entry) return;
  if (entry.status === 'running') return;
  registry.delete(stepId);
  notify();
}

export function readRunningProcesses(): RunningProcess[] {
  return snapshot();
}

// Reactive read for the board UI. Re-renders whenever the registry
// changes meaningfully (registration / status transition / URL
// detection). Per-chunk output append doesn't fire a re-render — see
// appendProcessOutput.
export function useRunningProcesses(): RunningProcess[] {
  const [, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    listeners.add(bump);
    return () => {
      listeners.delete(bump);
    };
  }, []);
  return snapshot();
}

// Singleton IPC listener installer. Subscribes ONCE per app lifetime
// to window.api.onCommandOutput / onCommandExit and routes events to
// the registry. Necessary because Restart-spawned commands don't go
// through useCommands' per-step listeners — without this they'd run
// but never update the board.
//
// Safe to call multiple times; only the first call installs.
let listenersInstalled = false;
export function installProcessListeners(): void {
  if (listenersInstalled) return;
  listenersInstalled = true;
  window.api.onCommandOutput(({ id, data }) => {
    appendProcessOutput(id, data);
  });
  window.api.onCommandExit(({ id, code, signal }) => {
    finalizeProcess(id, { exitCode: code, signal });
  });
}
