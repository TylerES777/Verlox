// Vorlox's own prompt history. Every user prompt across every
// conversation is appended to a single rolling log persisted to
// localStorage, so the "show me my history" built-in can list what
// the user has asked across sessions — not their shell history,
// which is essentially useless from Vorlox's process model.

export interface PromptHistoryEntry {
  text: string;
  // Epoch milliseconds when the prompt was submitted.
  timestamp: number;
}

const STORAGE_KEY = 'vorlox.promptHistory';
// Cap so the log can't grow unbounded. Old entries fall off the end.
// 500 covers months of normal use without bloating localStorage.
const MAX_ENTRIES = 500;

// Append a prompt to the history. Newest entries land at index 0.
// Consecutive identical prompts collapse into one entry whose
// timestamp updates — re-pressing Enter on the same prompt shouldn't
// flood the log with duplicates.
export function appendPrompt(text: string): void {
  const trimmed = text.trim();
  if (trimmed.length === 0) return;
  try {
    const existing = readPromptHistory();
    if (existing.length > 0 && existing[0].text === trimmed) {
      existing[0].timestamp = Date.now();
    } else {
      existing.unshift({ text: trimmed, timestamp: Date.now() });
    }
    const capped = existing.slice(0, MAX_ENTRIES);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(capped));
  } catch {
    // localStorage unavailable (sandboxed, quota) — silently drop.
    // The in-memory conversation still shows the prompt anyway.
  }
}

// Read the persisted log. Returns newest-first. Defensive against
// corrupted data (missing keys, wrong types) — anything that doesn't
// look like a real entry is filtered out.
export function readPromptHistory(): PromptHistoryEntry[] {
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
