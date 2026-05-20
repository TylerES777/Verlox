import { useEffect, useReducer } from 'react';

// Vorlox's own prompt history. Every user prompt across every
// conversation is appended to a single rolling log persisted to
// localStorage, so the "show me my history" built-in and the
// Timeline sidebar can list what the user has asked across sessions
// — not their shell history, which is essentially useless from
// Vorlox's process model.

export interface PromptHistoryEntry {
  text: string;
  // Epoch milliseconds when the prompt was submitted.
  timestamp: number;
}

const STORAGE_KEY = 'vorlox.promptHistory';
// Cap so the log can't grow unbounded. Old entries fall off the end.
// 500 covers months of normal use without bloating localStorage.
const MAX_ENTRIES = 500;

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
    return parsed.filter(
      (e): e is PromptHistoryEntry =>
        e != null &&
        typeof e === 'object' &&
        typeof e.text === 'string' &&
        typeof e.timestamp === 'number',
    );
  } catch {
    return [];
  }
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
  // Notify in a single tick so multiple appends in the same frame
  // don't trigger N renders per listener.
  listeners.forEach((listener) => listener());
}

// Append a prompt to the history. Newest entries land at index 0.
// Consecutive identical prompts collapse into one entry whose
// timestamp updates — re-pressing Enter on the same prompt shouldn't
// flood the log with duplicates.
export function appendPrompt(text: string): void {
  const trimmed = text.trim();
  if (trimmed.length === 0) return;
  const current = ensureCache();
  let next: PromptHistoryEntry[];
  if (current.length > 0 && current[0].text === trimmed) {
    next = [{ text: trimmed, timestamp: Date.now() }, ...current.slice(1)];
  } else {
    next = [{ text: trimmed, timestamp: Date.now() }, ...current];
  }
  cache = next.slice(0, MAX_ENTRIES);
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
