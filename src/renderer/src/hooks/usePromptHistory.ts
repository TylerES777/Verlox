import { useEffect, useReducer } from 'react';

// Verlox's own prompt history. Every user prompt across every
// conversation is appended to a single rolling log so the "show me
// my history" built-in and the Timeline sidebar can list what the
// user has asked this session — not their shell history, which is
// essentially useless from Verlox's process model.
//
// SESSION-ONLY: the log lives entirely in memory. When the app
// quits or the renderer reloads, the cache is gone and the timeline
// starts fresh. This is deliberate — the user reported that an
// always-persistent timeline of past prompts dominated the sidebar
// on startup and drowned the rest of the UI's signal. A clean slate
// each launch keeps Timeline as ambient context for THIS session.
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

const MAX_ENTRIES = 500;
const COMMAND_MAX_LEN = 80;
const COMMAND_MAX_COUNT = 5;
const OUTCOME_MAX_LEN = 200;

// Module-scope mirror of the log. In-memory only — no persistence.
// Lives for the lifetime of the renderer process; cleared on quit /
// reload / clearPromptHistory().
let cache: PromptHistoryEntry[] = [];
const listeners = new Set<() => void>();

function notifyListeners(): void {
  listeners.forEach((listener) => listener());
}

// One-time cleanup of the legacy localStorage key that previous
// versions used to persist prompt history. Runs on module load so the
// user's data folder is tidied as soon as they launch a build with
// the in-memory implementation. Safe to call repeatedly — removeItem
// is a no-op once the key is gone.
try {
  window.localStorage.removeItem('vorlox.promptHistory');
} catch {
  // localStorage unavailable / sandboxed — nothing to clean up.
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
  const id = crypto.randomUUID();
  let next: PromptHistoryEntry[];
  if (cache.length > 0 && cache[0].text === trimmed) {
    next = [
      {
        id,
        text: trimmed,
        timestamp: Date.now(),
        commands: [],
        outcome: null,
        status: 'pending',
      },
      ...cache.slice(1),
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
      ...cache,
    ];
  }
  cache = next.slice(0, MAX_ENTRIES);
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
  const idx = cache.findIndex((e) => e.id === id);
  if (idx === -1) return;
  const next = cache.slice();
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
  notifyListeners();
}

// Wipes the entire log. The Timeline empties immediately (subscribers
// re-render via notifyListeners). Used by the Timeline header's Clear
// button so the user can prune the sidebar without quitting.
export function clearPromptHistory(): void {
  if (cache.length === 0) return;
  cache = [];
  notifyListeners();
}

// Synchronous read for the orchestrator's HISTORY_SHOWN dispatch.
// Returns a snapshot — callers should not mutate.
export function readPromptHistory(): PromptHistoryEntry[] {
  return cache.slice();
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
  return cache;
}
