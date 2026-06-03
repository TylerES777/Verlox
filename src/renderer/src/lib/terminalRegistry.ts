import type { Terminal } from '@xterm/xterm';

// A tiny shared registry so the Verlox agent panel can always see what is on
// the terminal screen(s) — including other open terminal tabs, not just its
// own. Each TerminalView registers a reader for its xterm buffer on mount and
// removes it on unmount. The panel snapshots all readers when it plans a step.

interface TerminalReader {
  // The live terminal instance to read the visible buffer from.
  term: Terminal;
}

const readers = new Map<string, TerminalReader>();

export function registerTerminal(id: string, term: Terminal): void {
  readers.set(id, { term });
}

export function unregisterTerminal(id: string): void {
  readers.delete(id);
}

// Serialize the last `maxLines` lines of a terminal's scrollback to plain
// text, trimming trailing whitespace per line and collapsing big blank runs.
function readBuffer(term: Terminal, maxLines: number): string {
  const buf = term.buffer.active;
  const total = buf.length;
  const start = Math.max(0, total - maxLines);
  const lines: string[] = [];
  for (let i = start; i < total; i += 1) {
    const line = buf.getLine(i);
    lines.push(line ? line.translateToString(true) : '');
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export interface TerminalSnapshot {
  id: string;
  current: boolean;
  text: string;
}

// Snapshot every registered terminal. The one whose id matches `currentId`
// is flagged as the active tab so the agent knows which screen is in front.
export function snapshotTerminals(
  currentId: string,
  maxLinesEach = 150,
): TerminalSnapshot[] {
  const out: TerminalSnapshot[] = [];
  for (const [id, r] of readers.entries()) {
    out.push({ id, current: id === currentId, text: readBuffer(r.term, maxLinesEach) });
  }
  // Active terminal first, so if we truncate later it survives.
  out.sort((a, b) => Number(b.current) - Number(a.current));
  return out;
}
