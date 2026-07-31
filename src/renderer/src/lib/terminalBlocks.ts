// Block state for the terminal's Blocks view.
//
// Blocks are driven by OSC 133 shell integration, not by scraping the prompt.
// The shell emits invisible marks around each command (see shell-safety.ts for
// the PowerShell injection and pty-manager.ts for the parser); the main process
// turns those into two events:
//
//   pty:block-start  the shell reported a submitted command  → open a card
//   pty:block        the command finished, with its REAL exit code → close it
//
// Between those, raw PTY text streams in via pty:data and is appended to the
// open block so long-running commands show progress live.
//
// Why not parse the prompt: the old approach matched /^PS (path)> (cmd)$/,
// which only works on PowerShell and can never know a command's exit code —
// success/failure had to be guessed from the output text. OSC 133 is the
// cross-shell standard (zsh, bash, fish can all emit it) and carries the exit
// code, so the same code path works on macOS and Linux unchanged.

// ANSI stripping. The PTY stream is full of CSI cursor ops, OSC title
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

/** Split raw PTY text into display lines, ANSI and control chars removed. */
export function toDisplayLines(raw: string): string[] {
  return stripAnsi(raw)
    .split('\n')
    .map((l) => reduceLine(l).trimEnd());
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
  // Real exit code from the shell (OSC 133 'D'), or null while running or if
  // the shell didn't report one. 0 = success; anything else failed.
  exitCode: number | null;
  // The trailing line that hasn't been terminated by a newline yet. Progress
  // bars and spinners redraw this same line with \r, so it's held separately
  // and replaced rather than appended — otherwise every repaint would add a
  // duplicate row. Rendered under `lines` while the block runs.
  partial: string;
}

export const MAX_BLOCKS = 80;
export const MAX_LINES_PER_BLOCK = 400;

function capLines(existing: string[], incoming: string[]): { lines: string[]; truncated: boolean } {
  const lines = existing.concat(incoming);
  const truncated = lines.length > MAX_LINES_PER_BLOCK;
  return {
    lines: truncated ? lines.slice(-MAX_LINES_PER_BLOCK) : lines,
    truncated,
  };
}

// A line that is only a spinner frame. Tools like npm animate progress by
// repainting a single glyph; once ANSI cursor moves are stripped, each frame
// would otherwise land as its own row and flood the block with `/ - \ |`.
const SPINNER_ONLY_RE = /^[\s/\\|\-_*+.oO°▀-▟⠀-⣿]{1,3}$/;

function isNoise(line: string, prev: string | undefined): boolean {
  const t = line.trim();
  if (t === '') return prev === '' || prev === undefined;
  if (SPINNER_ONLY_RE.test(t)) return true;
  // A repaint of the exact same line adds nothing.
  return t === prev?.trim();
}

/** Drop spinner frames, repeated repaints, and runs of blank lines. */
function denoise(incoming: string[], tail: string | undefined): string[] {
  const out: string[] = [];
  let prev = tail;
  for (const line of incoming) {
    if (isNoise(line, prev)) continue;
    out.push(line);
    prev = line;
  }
  return out;
}

// --- Fallback: prompt detection ------------------------------------------
// OSC 133 is the primary path and the only cross-shell one, but it depends on
// the shell integration actually loading (a locked-down profile, a missing
// PSReadLine, or a PTY backend that eats the marks all defeat it). Without a
// fallback the Blocks view degrades to showing NOTHING, which is far worse
// than degrading to "no exit codes". So when no mark has ever arrived for a
// terminal, we fall back to reading the prompt, exactly as before.
//
// This path can't know exit codes — blocks it creates carry exitCode null,
// and the UI treats null as "unknown" rather than "success".

const PROMPT_RE = /^(?:PS )?(.+?)>\s?(.*)$/;

export interface FallbackEvent {
  type: 'start' | 'output' | 'end';
  text: string;
}

/** Slice raw PTY text into block events by watching for the shell prompt. */
export class PromptFallbackParser {
  private buf = '';
  private open = false;

  feed(data: string): FallbackEvent[] {
    const events: FallbackEvent[] = [];
    this.buf += stripAnsi(data);
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = reduceLine(this.buf.slice(0, nl)).trimEnd();
      this.buf = this.buf.slice(nl + 1);
      const m = line.match(PROMPT_RE);
      if (m && /[\\/]/.test(m[1])) {
        if (this.open) {
          events.push({ type: 'end', text: '' });
          this.open = false;
        }
        const command = m[2].trim();
        if (command) {
          events.push({ type: 'start', text: command });
          this.open = true;
        }
      } else if (this.open) {
        events.push({ type: 'output', text: line });
      }
    }
    if (this.buf.length > 8192) this.buf = this.buf.slice(-4096);
    return events;
  }
}

/** Apply fallback events to the block list. */
export function applyFallbackEvents(
  prev: TerminalBlockData[],
  events: FallbackEvent[],
  now: number,
): TerminalBlockData[] {
  let blocks = prev;
  for (const ev of events) {
    if (ev.type === 'start') {
      blocks = openBlock(blocks, ev.text, now);
    } else if (ev.type === 'output') {
      blocks = appendToOpenBlock(blocks, `${ev.text}\n`);
    } else {
      const last = blocks[blocks.length - 1];
      if (last && last.endedAt === null) {
        blocks = blocks
          .slice(0, -1)
          .concat({ ...last, endedAt: now, partial: '' });
      }
    }
  }
  return blocks;
}

/**
 * A command was submitted: open a running block. Any block still marked
 * running is closed first — a new command means the previous one is over,
 * even if its 'D' mark was lost, so output can never leak into it later.
 */
export function openBlock(
  prev: TerminalBlockData[],
  command: string,
  now: number,
): TerminalBlockData[] {
  const settled = prev.map((b) =>
    b.endedAt === null ? { ...b, endedAt: now, partial: '' } : b,
  );
  const blocks = settled.concat({
    id: `${now}-${prev.length}-${Math.floor(Math.random() * 1e6)}`,
    command,
    lines: [],
    startedAt: now,
    endedAt: null,
    truncated: false,
    exitCode: null,
    partial: '',
  });
  return blocks.length > MAX_BLOCKS ? blocks.slice(-MAX_BLOCKS) : blocks;
}

/**
 * Live output for the block currently running (no-op when none is open).
 * Text is joined onto whatever partial line was left over, then split: every
 * completed line is committed, and the unterminated tail is held as `partial`
 * so a redrawing progress bar replaces itself instead of stacking up.
 */
export function appendToOpenBlock(
  prev: TerminalBlockData[],
  raw: string,
): TerminalBlockData[] {
  const last = prev[prev.length - 1];
  if (!last || last.endedAt !== null) return prev;
  const clean = stripAnsi(raw);
  if (!clean) return prev;

  const segments = (last.partial + clean).split('\n');
  const partial = reduceLine(segments.pop() ?? '');
  const completed = denoise(
    segments.map((l) => reduceLine(l).trimEnd()),
    last.lines[last.lines.length - 1],
  );

  if (completed.length === 0 && partial === last.partial) return prev;

  const { lines, truncated } = capLines(last.lines, completed);
  const blocks = prev.slice();
  blocks[blocks.length - 1] = {
    ...last,
    lines,
    partial,
    truncated: last.truncated || truncated,
  };
  return blocks;
}

/**
 * The shell reported the command finished. Replace the streamed output with
 * the authoritative text from the main process and record the real exit code.
 * Falls back to opening-then-closing a block if the start event was missed
 * (e.g. shell integration loaded mid-session).
 */
export function closeBlock(
  prev: TerminalBlockData[],
  command: string,
  output: string,
  exitCode: number | null,
  now: number,
): TerminalBlockData[] {
  // Same denoise as the live stream: the shell's captured output still
  // contains the spinner frames a tool painted, and they read as garbage
  // once the animation is gone. Raw mode keeps the unfiltered stream.
  const authoritative = denoise(toDisplayLines(output), undefined).filter(
    (l, i, arr) => !(l === '' && i === arr.length - 1),
  );
  const { lines, truncated } = capLines([], authoritative);

  const last = prev[prev.length - 1];
  // Only fold the result into the open block when it's the SAME command.
  // Without this check a late or mismatched 'D' mark overwrites whichever
  // block happens to be open, which showed one command's output under
  // another command's header.
  const sameCommand =
    !!last && last.endedAt === null && (command === '' || last.command === command);

  if (last && sameCommand) {
    const blocks = prev.slice();
    blocks[blocks.length - 1] = {
      ...last,
      command: command || last.command,
      lines,
      partial: '',
      truncated,
      endedAt: now,
      exitCode,
    };
    return blocks;
  }

  // Mismatch: the open block belongs to something else. Close it honestly
  // rather than rewriting it, then record this result as its own block.
  const base =
    last && last.endedAt === null
      ? prev
          .slice(0, -1)
          .concat({ ...last, partial: '', endedAt: now, exitCode: null })
      : prev;

  const blocks = base.concat({
    id: `${now}-${base.length}-${Math.floor(Math.random() * 1e6)}`,
    command,
    lines,
    startedAt: now,
    endedAt: now,
    truncated,
    exitCode,
    partial: '',
  });
  return blocks.length > MAX_BLOCKS ? blocks.slice(-MAX_BLOCKS) : blocks;
}
