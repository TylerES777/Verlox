import { useEffect, useReducer } from 'react';

// Vorlox's own prompt history. Every user prompt across every
// conversation is appended to a single rolling log persisted to
// localStorage, so the "show me my history" built-in and the
// Timeline sidebar can list what the user has asked across sessions
// — not their shell history, which is essentially useless from
// Vorlox's process model.
//
// Each entry pairs the prompt with the eventual outcome — what
// commands ran, the short conclusion, and the turn's terminal
// status. The Timeline hover card uses this to surface context
// (intent + result) without forcing the user to re-open the turn.

export type PromptHistoryStatus =
  | 'pending'
  | 'done'
  | 'replied'
  | 'cd'
  | 'list'
  | 'history'
  | 'cancelled'
  | 'error';

export interface PromptHistoryEntry {
  // Stable id minted at append time so post-hoc updates can find the
  // entry even after additional prompts have pushed it down the list.
  id: string;
  text: string;
  // Epoch milliseconds when the prompt was submitted.
  timestamp: number;
  // Commands that ran during this turn (may be empty for cd / list /
  // history / replied turns). Each capped to ~80 chars; list capped
  // to 5 entries to keep localStorage usage bounded.
  commands: string[];
  // Short conclusion shown in the hover card. The AI's reply text,
  // a system note ("Switched to /foo"), or an error message —
  // truncated. null while the turn is still in flight.
  outcome: string | null;
  // Terminal status when the turn settled. 'pending' until it does.
  status: PromptHistoryStatus;
}

const STORAGE_KEY = 'vorlox.promptHistory';
const MAX_ENTRIES = 500;
const COMMAND_MAX_LEN = 80;
const COMMAND_MAX_COUNT = 5;
const OUTCOME_MAX_LEN = 200;

// Module-scope mirror of the log so the Timeline sidebar can subscribe
// to updates without re-reading localStorage on every render. Seeded
// once on first read from disk.
let cache: PromptHistoryEntry[] | null = null;
const listeners = new Set<() => void>();

function ensureCache(): PromptHistoryEntry[] {
  if (cache !== null) return cache;
  cache = readFromStorage();
  return cache;
}

function readFromStorage(): PromptHistoryEntry[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (e): e is { text: unknown; timestamp: unknown } & Record<string, unknown> =>
          e != null &&
          typeof e === 'object' &&
          typeof (e as { text?: unknown }).text === 'string' &&
          typeof (e as { timestamp?: unknown }).timestamp === 'number',
      )
      .map((e): PromptHistoryEntry => ({
        id: typeof e.id === 'string' ? e.id : crypto.randomUUID(),
        text: e.text as string,
        timestamp: e.timestamp as number,
        commands: Array.isArray(e.commands)
          ? (e.commands as unknown[]).filter(
              (c): c is string => typeof c === 'string',
            )
          : [],
        outcome: typeof e.outcome === 'string' ? e.outcome : null,
        status: isStatus(e.status) ? e.status : 'pending',
      }));
  } catch {
    return [];
  }
}

function isStatus(value: unknown): value is PromptHistoryStatus {
  return (
    value === 'pending' ||
    value === 'done' ||
    value === 'replied' ||
    value === 'cd' ||
    value === 'list' ||
    value === 'history' ||
    value === 'cancelled' ||
    value === 'error'
  );
}

function saveToStorage(entries: PromptHistoryEntry[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // localStorage unavailable (sandboxed, quota) — silently drop.
    // The in-memory cache still keeps the data for this session.
  }
}

function notifyListeners(): void {
  listeners.forEach((listener) => listener());
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

// Append a prompt to the history. Returns the new entry's id so the
// caller can update it post-hoc once the turn settles.
//
// Consecutive identical prompts collapse into one entry whose
// timestamp updates — re-pressing Enter on the same prompt shouldn't
// flood the log with duplicates. In that case we reset commands /
// outcome / status so the entry reflects the fresh attempt.
export function appendPrompt(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '';
  const current = ensureCache();
  const id = crypto.randomUUID();
  let next: PromptHistoryEntry[];
  if (current.length > 0 && current[0].text === trimmed) {
    next = [
      {
        id,
        text: trimmed,
        timestamp: Date.now(),
        commands: [],
        outcome: null,
        status: 'pending',
      },
      ...current.slice(1),
    ];
  } else {
    next = [
      {
        id,
        text: trimmed,
        timestamp: Date.now(),
        commands: [],
        outcome: null,
        status: 'pending',
      },
      ...current,
    ];
  }
  cache = next.slice(0, MAX_ENTRIES);
  saveToStorage(cache);
  notifyListeners();
  return id;
}

// Update an entry's outcome once the turn settles. No-op if the id
// isn't found (the entry may have been pushed off the end by the cap).
export function updatePromptOutcome(
  id: string,
  update: { commands: string[]; outcome: string | null; status: PromptHistoryStatus },
): void {
  if (id.length === 0) return;
  const current = ensureCache();
  const idx = current.findIndex((e) => e.id === id);
  if (idx === -1) return;
  const next = current.slice();
  const cappedCommands = update.commands
    .slice(0, COMMAND_MAX_COUNT)
    .map((c) => truncate(c, COMMAND_MAX_LEN));
  next[idx] = {
    ...next[idx],
    commands: cappedCommands,
    outcome:
      update.outcome !== null ? truncate(update.outcome, OUTCOME_MAX_LEN) : null,
    status: update.status,
  };
  cache = next;
  saveToStorage(cache);
  notifyListeners();
}

// Synchronous read for the orchestrator's HISTORY_SHOWN dispatch.
// Returns a snapshot — callers should not mutate.
export function readPromptHistory(): PromptHistoryEntry[] {
  return ensureCache().slice();
}

// Reactive read for components that should update when the log
// changes (the Timeline sidebar). useReducer + a no-op state bump
// is the cheapest way to force a re-render on listener fire.
export function usePromptHistory(): PromptHistoryEntry[] {
  const [, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    listeners.add(bump);
    return () => {
      listeners.delete(bump);
    };
  }, []);
  return ensureCache();
}
