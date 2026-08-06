// Keyboard memory for the Blocks command bar: submitted-command history
// (Up/Down) and Tab completion. Pure logic lives here so it's testable;
// BlocksView owns the DOM wiring and the directory listings.

// --- History ---------------------------------------------------------------

const HISTORY_KEY = 'verlox-command-history';
const HISTORY_MAX = 200;

export function historyLoad(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Append a submitted command (consecutive dupes collapse, list capped). */
export function historyAppend(cmd: string): void {
  const t = cmd.trim();
  if (!t) return;
  try {
    const list = historyLoad();
    if (list[list.length - 1] !== t) list.push(t);
    localStorage.setItem(
      HISTORY_KEY,
      JSON.stringify(list.slice(-HISTORY_MAX)),
    );
  } catch {
    // Private mode etc. — history just won't persist.
  }
}

// --- Token math ------------------------------------------------------------

export interface TokenSpan {
  start: number;
  end: number;
  text: string;
}

/**
 * The token the caret is inside (start..caret). Space splits tokens except
 * inside double quotes, so `copy "my file` is one token.
 */
export function currentToken(input: string, caret: number): TokenSpan {
  let start = 0;
  let inQuotes = false;
  for (let i = 0; i < caret; i++) {
    const ch = input[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ' ' && !inQuotes) start = i + 1;
  }
  return { start, end: caret, text: input.slice(start, caret) };
}

export interface CompletionPlan {
  kind: 'command' | 'path';
  // For paths: the directory part of the token ("src\", "C:\Users\"), kept
  // verbatim for reassembly. '' means the token is a bare name.
  dirPart: string;
  // What candidates are matched against (quote stripped, lowercased by the
  // matcher, not here).
  prefix: string;
}

/** Decide what the token wants: a command name or a filesystem path. */
export function planCompletion(token: string, isFirstToken: boolean): CompletionPlan {
  const bare = token.startsWith('"') ? token.slice(1) : token;
  const sep = Math.max(bare.lastIndexOf('\\'), bare.lastIndexOf('/'));
  if (sep !== -1) {
    return { kind: 'path', dirPart: bare.slice(0, sep + 1), prefix: bare.slice(sep + 1) };
  }
  if (bare.startsWith('~') || bare.startsWith('.') || bare.includes(':')) {
    return { kind: 'path', dirPart: '', prefix: bare };
  }
  return isFirstToken
    ? { kind: 'command', dirPart: '', prefix: bare }
    : { kind: 'path', dirPart: '', prefix: bare };
}

// Commands worth offering before the user has any history. Windows-first,
// matching the shell Verlox ships.
const COMMON_COMMANDS = [
  'cd',
  'dir',
  'ls',
  'git',
  'npm',
  'npx',
  'node',
  'python',
  'pip',
  'echo',
  'mkdir',
  'del',
  'copy',
  'move',
  'type',
  'cls',
  'code',
  'vim',
];

/** First-token candidates: recent history commands first, then built-ins. */
export function commandCandidates(prefix: string, history: string[]): string[] {
  const p = prefix.toLowerCase();
  const out: string[] = [];
  const add = (v: string) => {
    if (!v || !v.toLowerCase().startsWith(p)) return;
    if (!out.some((o) => o.toLowerCase() === v.toLowerCase())) out.push(v);
  };
  // Full history lines whose first word matches, most recent first — so
  // `git ` completes to whole recent commands, not just the word "git".
  for (let i = history.length - 1; i >= 0; i--) {
    const line = history[i].trim();
    if (p.length > 0 && line.toLowerCase().startsWith(p)) add(line);
  }
  for (const c of COMMON_COMMANDS) add(c);
  return out.slice(0, 24);
}

/** Path candidates from a directory listing; folders keep a trailing \. */
export function pathCandidates(
  prefix: string,
  entries: { name: string; isDirectory: boolean }[],
  dirsOnly = false,
): string[] {
  const p = prefix.toLowerCase();
  return entries
    .filter((e) => (!dirsOnly || e.isDirectory) && e.name.toLowerCase().startsWith(p))
    .map((e) => (e.isDirectory ? `${e.name}\\` : e.name))
    .slice(0, 24);
}

/**
 * Ctrl+R: history filtered by substring (not prefix — "vite" should find
 * "npm create vite@latest"), most recent first, deduped.
 */
export function historySearch(query: string, history: string[]): string[] {
  const q = query.trim().toLowerCase();
  const out: string[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const line = history[i].trim();
    if (!line || (q && !line.toLowerCase().includes(q))) continue;
    if (!out.includes(line)) out.push(line);
  }
  return out.slice(0, 24);
}

/**
 * Replace the token with a chosen candidate. PATH tokens containing spaces
 * come back double-quoted (closing quote left off for folders so Tab can
 * keep drilling); command-line candidates from history are whole commands
 * and must never be quoted.
 */
export function applyCandidate(
  input: string,
  span: TokenSpan,
  dirPart: string,
  candidate: string,
  quoteSpaces = true,
): { next: string; caret: number } {
  let token = dirPart + candidate;
  if (quoteSpaces && /\s/.test(token)) {
    token = token.endsWith('\\') ? `"${token}` : `"${token}"`;
  }
  const next = input.slice(0, span.start) + token + input.slice(span.end);
  return { next, caret: span.start + token.length };
}
