import { Terminal } from '@xterm/xterm';

// The live terminal surface inside a running block card, and the serializer
// that freezes it into styled HTML when the command ends.
//
// Why this exists: shell output is screen-painting instructions, not text.
// The block TEXT pipeline (terminalBlocks.ts) translates the stream into
// plain lines for analysis — summaries, chips, waiting detection — and that
// translation is deliberately lossy. This module is the presentation layer
// that ISN'T lossy: a real xterm grid renders the command's bytes exactly
// (colors, in-place menus, progress bars), and clicking it sends keystrokes
// straight to the program. One live instance serves whichever block is
// running; closed blocks keep a static snapshot and cost nothing.

// --- Colors ----------------------------------------------------------------

// ANSI 0-15 mapped to the app's calm palette: readable on the light card,
// no neon. Order: black, red, green, yellow, blue, magenta, cyan, white,
// then bright variants.
const PALETTE16 = [
  '#3A3A3A',
  '#B4322B',
  '#3E7A53',
  '#9A6B15',
  '#2E5FA3',
  '#7A4FA3',
  '#2E7A8A',
  '#6B7280',
  '#6B7280',
  '#C94E45',
  '#4C9468',
  '#B4832F',
  '#4577C4',
  '#9467C4',
  '#4795A6',
  '#3A3A3A',
];

// xterm's standard 256-color formula for indexes 16-255.
function paletteColor(i: number): string {
  if (i < 16) return PALETTE16[i] ?? '#3A3A3A';
  if (i < 232) {
    const levels = [0, 95, 135, 175, 215, 255];
    const n = i - 16;
    const r = levels[Math.floor(n / 36)];
    const g = levels[Math.floor(n / 6) % 6];
    const b = levels[n % 6];
    return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
  }
  const v = 8 + (i - 232) * 10;
  return `#${((v << 16) | (v << 8) | v).toString(16).padStart(6, '0')}`;
}

// --- Serializer ------------------------------------------------------------

// Minimal shapes of the xterm buffer API, so tests can feed a fake buffer
// without a DOM.
export interface CellLike {
  getChars(): string;
  getWidth(): number;
  isFgDefault(): number | boolean;
  isBgDefault(): number | boolean;
  isFgRGB(): number | boolean;
  isBgRGB(): number | boolean;
  getFgColor(): number;
  getBgColor(): number;
  isBold(): number;
  isItalic(): number;
  isDim(): number;
  isUnderline(): number;
  isInverse(): number;
}

export interface LineLike {
  length: number;
  getCell(x: number): CellLike | undefined;
  translateToString(trimRight?: boolean): string;
}

export interface BufferLike {
  length: number;
  getLine(y: number): LineLike | undefined;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function cellColor(cell: CellLike, layer: 'fg' | 'bg'): string | null {
  const isDefault = layer === 'fg' ? cell.isFgDefault() : cell.isBgDefault();
  if (isDefault) return null;
  const isRgb = layer === 'fg' ? cell.isFgRGB() : cell.isBgRGB();
  const color = layer === 'fg' ? cell.getFgColor() : cell.getBgColor();
  if (isRgb) return `#${(color >>> 0).toString(16).padStart(6, '0').slice(-6)}`;
  return paletteColor(color);
}

function cellStyle(cell: CellLike): string {
  let fg = cellColor(cell, 'fg');
  let bg = cellColor(cell, 'bg');
  if (cell.isInverse()) {
    // Swap; a default fg on inverse means "card ink on colored ground".
    const f = fg;
    fg = bg ?? '#F7F9FC';
    bg = f ?? '#3A3A3A';
  }
  const parts: string[] = [];
  if (fg) parts.push(`color:${fg}`);
  if (bg) parts.push(`background-color:${bg}`);
  if (cell.isBold()) parts.push('font-weight:600');
  if (cell.isItalic()) parts.push('font-style:italic');
  if (cell.isDim()) parts.push('opacity:0.6');
  if (cell.isUnderline()) parts.push('text-decoration:underline');
  return parts.join(';');
}

// A shell prompt line, used to trim the echo at the top and the returned
// prompt at the bottom of a snapshot. Deliberately the same shape the
// fallback parser keys on.
const SNAPSHOT_PROMPT_RE = /^(?:PS )?[A-Za-z]:[^>]*>\s?/;

export const SNAPSHOT_MAX_ROWS = 400;

/**
 * Freeze a terminal buffer into styled HTML (span-per-style-run inside one
 * <pre>). Leading/trailing blank rows go, prompt rows at either edge go
 * (they're shell chrome, not command output), and long output keeps its
 * tail like the text pipeline does. `command` lets the trimmer also drop a
 * stray echo fragment: winpty sometimes wraps the echoed command's last
 * characters onto their own row ("npm view react" leaving a lone "t").
 */
export function serializeBufferToHtml(buffer: BufferLike, command = ''): string {
  type Row = { text: string; html: string };
  const rows: Row[] = [];

  for (let y = 0; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    const text = line.translateToString(true);
    let html = '';
    let runStyle: string | null = null;
    let runText = '';
    const flush = () => {
      if (!runText) return;
      html += runStyle
        ? `<span style="${runStyle}">${escapeHtml(runText)}</span>`
        : escapeHtml(runText);
      runText = '';
    };
    // Only iterate as far as the trimmed text reaches — the rest of the
    // grid row is empty cells.
    for (let x = 0; x < line.length && html.length + runText.length < 4000; x++) {
      const cell = line.getCell(x);
      if (!cell || cell.getWidth() === 0) continue;
      const chars = cell.getChars() || ' ';
      const style = cellStyle(cell);
      if (style !== runStyle) {
        flush();
        runStyle = style;
      }
      runText += chars;
    }
    flush();
    // Drop the trailing run of blank cells the grid pads rows with.
    html = html.replace(/ +$/, '');
    rows.push({ text, html });
  }

  // Trim blank edges.
  let start = 0;
  let end = rows.length;
  while (start < end && rows[start].text.trim() === '') start++;
  while (end > start && rows[end - 1].text.trim() === '') end--;
  // Prompt chrome at the edges: the command echo above, the returned
  // prompt below. Interior prompt-looking lines are real output.
  while (start < end && SNAPSHOT_PROMPT_RE.test(rows[start].text)) start++;
  while (end > start && SNAPSHOT_PROMPT_RE.test(rows[end - 1].text)) end--;
  // The echo of the typed command can survive as the first row: wrapped
  // tail characters under the prompt (winpty), or the full command line
  // redrawn without its prompt (conpty + PSReadLine). One row, and only
  // when it's the command itself or a strict tail of it.
  if (start < end && command) {
    const frag = rows[start].text.trim();
    const cmd = command.trim();
    if (frag && frag.length <= cmd.length && cmd.endsWith(frag)) start++;
  }
  while (start < end && rows[start].text.trim() === '') start++;
  while (end > start && rows[end - 1].text.trim() === '') end--;

  let kept = rows.slice(start, end);
  if (kept.length > SNAPSHOT_MAX_ROWS) kept = kept.slice(-SNAPSHOT_MAX_ROWS);
  return kept.map((r) => r.html).join('\n');
}

// --- Live surface ----------------------------------------------------------

const SURFACE_ROWS = 24;

export class BlockSurface {
  private term: Terminal;
  private park: HTMLDivElement | null = null;
  private host: HTMLElement | null = null;
  private opened = false;
  private cellPx = 19;
  private raf = 0;
  private command = '';

  constructor(onInput: (data: string) => void) {
    this.term = new Terminal({
      cols: 120,
      rows: SURFACE_ROWS,
      scrollback: 600,
      fontSize: 12.5,
      lineHeight: 1.35,
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      cursorBlink: false,
      theme: {
        background: '#f5f7fb',
        foreground: '#3A3A3A',
        cursor: '#2E5FA3',
        cursorAccent: '#f5f7fb',
        selectionBackground: '#c7d7ef',
        black: PALETTE16[0],
        red: PALETTE16[1],
        green: PALETTE16[2],
        yellow: PALETTE16[3],
        blue: PALETTE16[4],
        magenta: PALETTE16[5],
        cyan: PALETTE16[6],
        white: PALETTE16[7],
        brightBlack: PALETTE16[8],
        brightRed: PALETTE16[9],
        brightGreen: PALETTE16[10],
        brightYellow: PALETTE16[11],
        brightBlue: PALETTE16[12],
        brightMagenta: PALETTE16[13],
        brightCyan: PALETTE16[14],
        brightWhite: PALETTE16[15],
      },
    });
    this.term.onData(onInput);
  }

  // xterm needs a measurable element to open into. The park node sits
  // offscreen (not display:none, which would break font measurement); the
  // rendered element is then MOVED into whichever card is running.
  private ensureOpen(): void {
    if (this.opened) return;
    this.park = document.createElement('div');
    this.park.style.cssText =
      'position:absolute;left:-10000px;top:0;width:900px;height:500px;overflow:hidden;';
    document.body.appendChild(this.park);
    this.term.open(this.park);
    this.opened = true;
    const el = this.term.element;
    if (el && el.offsetHeight > 0) this.cellPx = el.offsetHeight / this.term.rows;
  }

  /** A command is starting: clear the grid and match the pty's width. */
  beginCommand(cols: number, command = ''): void {
    this.command = command;
    this.ensureOpen();
    const want = Math.min(Math.max(cols || 120, 20), 400);
    try {
      if (want !== this.term.cols) this.term.resize(want, SURFACE_ROWS);
    } catch {
      // Bad geometry mid-layout; keep current size.
    }
    this.term.reset();
    this.fitHost();
  }

  feed(data: string): void {
    if (!this.opened) return;
    this.term.write(data);
    // Height follows content, but at most once a frame.
    if (!this.raf) {
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        this.fitHost();
      });
    }
  }

  /** Move the live element into a card (node) or back offscreen (null). */
  mountInto(node: HTMLElement | null): void {
    this.ensureOpen();
    const el = this.term.element;
    if (!el) return;
    this.host = node;
    if (node) {
      node.appendChild(el);
      this.fitHost();
      this.term.scrollToBottom();
    } else if (this.park) {
      this.park.appendChild(el);
    }
  }

  // The grid is a fixed 24 rows; the card should only be as tall as the
  // rows actually used, so `dir` doesn't get an empty half-screen.
  private fitHost(): void {
    if (!this.host) return;
    const b = this.term.buffer.active;
    const used = Math.max(2, Math.min(b.baseY + b.cursorY + 1, this.term.rows));
    this.host.style.height = `${Math.ceil(used * this.cellPx)}px`;
  }

  focus(): void {
    this.term.focus();
  }

  snapshot(): string {
    if (!this.opened) return '';
    return serializeBufferToHtml(
      this.term.buffer.active as unknown as BufferLike,
      this.command,
    );
  }

  dispose(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    try {
      this.term.dispose();
    } catch {
      // Already gone.
    }
    this.park?.remove();
    this.park = null;
    this.host = null;
  }
}
