// Block segmentation for the terminal's Blocks view. Tails the same raw
// PTY byte stream xterm renders and slices it into Warp-style blocks: one
// command plus its output per block. Boundaries come from the PowerShell
// prompt, the same heuristic the Running section already relies on
// (TerminalView's /^PS .*>$/): a completed line that reads
// "PS <path>> <command>" starts a block, and a bare "PS <path>> " prompt
// (line or pending tail) means the previous command finished.
//
// Pure string-machine, no DOM and no IPC, so it stays unit-testable.

// ANSI stripping. The WinPTY stream is full of CSI cursor ops, OSC title
// sequences, and PSReadLine color churn; none of it matters for block text.
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;
const CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ESC2_RE = /\x1b[@-Z\\-_]/g;

export function stripAnsi(s: string): string {
  return s.replace(OSC_RE, '').replace(CSI_RE, '').replace(ESC2_RE, '');
}

// Collapse a single visual line: a carriage return restarts the line (how
// spinners and progress bars redraw), and backspaces erase. The result is
// roughly what the terminal would show for that row.
export function reduceLine(s: string): string {
  const seg = s.replace(/\r+$/, '').split('\r').pop() ?? '';
  let out = '';
  for (const ch of seg) {
    if (ch === '\b') out = out.slice(0, -1);
    else out += ch;
  }
  return out;
}

// "PS C:\path> npm install" → command line; "PS C:\path> " → idle prompt.
const PROMPT_RE = /^PS (.+?)>\s?(.*)$/;

export type BlockEvent =
  | { type: 'start'; command: string }
  | { type: 'output'; text: string }
  | { type: 'end' };

export class BlockStreamParser {
  private buf = '';
  private open = false;
  // Live last line of the running command (no newline yet) — lets the UI
  // show progress-bar style output that only ever redraws via \r.
  pending = '';

  feed(data: string): BlockEvent[] {
    const events: BlockEvent[] = [];
    this.buf += data;

    let nl: number;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const raw = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      const line = reduceLine(stripAnsi(raw)).trimEnd();
      const m = line.match(PROMPT_RE);
      if (m) {
        // Any prompt line means the previous command is done.
        if (this.open) {
          events.push({ type: 'end' });
          this.open = false;
        }
        const command = m[2].trim();
        if (command) {
          events.push({ type: 'start', command });
          this.open = true;
        }
      } else if (this.open) {
        events.push({ type: 'output', text: line });
      }
      // Lines outside any block (shell banner, etc.) are dropped — the Raw
      // view still has them; Blocks is for command/output pairs.
    }

    // Don't let an endless no-newline stream grow the buffer unboundedly.
    if (this.buf.length > 8192) this.buf = this.buf.slice(-4096);

    // The pending tail: either the live last output line of a running
    // command, or the idle prompt re-appearing (which closes the block
    // even though the prompt has no trailing newline).
    const tail = reduceLine(stripAnsi(this.buf));
    if (this.open && PROMPT_RE.test(tail.trimEnd()) && !(PROMPT_RE.exec(tail.trimEnd())?.[2] ?? '').trim()) {
      events.push({ type: 'end' });
      this.open = false;
    }
    this.pending = this.open ? tail : '';

    return events;
  }
}

// One rendered block. Output is line-capped so a `find /` style firehose
// can't grow the React tree without bound; we keep the tail since the end
// of output is what users look at.
export interface TerminalBlockData {
  id: string;
  command: string;
  lines: string[];
  startedAt: number;
  endedAt: number | null;
  truncated: boolean;
}

export const MAX_BLOCKS = 80;
export const MAX_LINES_PER_BLOCK = 400;

/** Apply parser events to an immutable block list (newest last). */
export function applyBlockEvents(
  prev: TerminalBlockData[],
  events: BlockEvent[],
  now: number,
): TerminalBlockData[] {
  if (events.length === 0) return prev;
  let blocks = prev.slice();
  for (const ev of events) {
    if (ev.type === 'start') {
      blocks.push({
        id: `${now}-${blocks.length}-${Math.floor(Math.random() * 1e6)}`,
        command: ev.command,
        lines: [],
        startedAt: now,
        endedAt: null,
        truncated: false,
      });
      if (blocks.length > MAX_BLOCKS) blocks = blocks.slice(-MAX_BLOCKS);
    } else if (ev.type === 'output') {
      const last = blocks[blocks.length - 1];
      if (!last || last.endedAt !== null) continue;
      const lines = last.lines.concat(ev.text);
      const truncated = last.truncated || lines.length > MAX_LINES_PER_BLOCK;
      blocks[blocks.length - 1] = {
        ...last,
        lines: truncated ? lines.slice(-MAX_LINES_PER_BLOCK) : lines,
        truncated,
      };
    } else {
      const last = blocks[blocks.length - 1];
      if (!last || last.endedAt !== null) continue;
      blocks[blocks.length - 1] = { ...last, endedAt: now };
    }
  }
  return blocks;
}
