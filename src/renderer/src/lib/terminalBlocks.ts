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

// Cursor-to-column-1 (ESC[G / ESC[1G) is how PowerShell repaints a prompt
// line in place (its -Confirm menu does this). For text reconstruction it
// means the same thing as a carriage return, so it becomes one — otherwise
// stripping it would glue the repaint onto the first paint, duplicated.
const CUP_COL1_RE = /\x1b\[0*1?G/g;

export function stripAnsi(s: string): string {
  return s
    .replace(CUP_COL1_RE, '\r')
    .replace(OSC_RE, '')
    .replace(CSI_RE, '')
    .replace(ESC2_RE, '');
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

/**
 * Replies a running command is plainly offering, pulled from its own output
 * so nothing is invented. Three shapes cover most prompts:
 *
 *   Python's banner   Type "help", "copyright", "credits" or "license"
 *   yes/no gates      Continue? [y/N]     Overwrite? (yes/no)
 *   bracketed choices Choose [start|stop|restart]
 *
 * Only the last few lines are considered, so an option mentioned early in a
 * long session doesn't resurface as a stale suggestion.
 */
export interface SuggestedReply {
  // What the button says. Always the MEANING ("Yes to All"), never the
  // keystroke — the user shouldn't have to decode a letter table.
  label: string;
  // The bytes to write to the pty, Enter included where one is needed.
  send: string;
  // The choice the program itself defaults to, e.g. (default is "Y").
  recommended?: boolean;
}

// Meanings for letter-only menus, which offer no labels of their own
// (git add -p prints `[y,n,q,a,d,e,?]` and nothing else). Only letters
// whose meaning is stable across the tools that use this form.
const LETTER_MEANINGS: Record<string, string> = {
  y: 'Yes',
  n: 'No',
  q: 'Quit',
  a: 'All remaining',
  d: 'Skip remaining',
  e: 'Edit',
  s: 'Split',
  j: 'Next',
  k: 'Previous',
  '?': 'Help',
};

// The control byte for Ctrl+<letter>. Ctrl+Z needs the Return that Windows
// expects after it; the rest are the bare byte.
function ctrlSend(letter: string): string {
  const byte = String.fromCharCode(letter.toUpperCase().charCodeAt(0) - 64);
  return letter.toUpperCase() === 'Z' ? `${byte}\r` : byte;
}

// A run of two or more bracketed key choices with their labels, e.g.
//   [Y] Yes  [A] Yes to All  [N] No  [L] No to All  [S] Suspend  [?] Help
// Labels are bounded to a few words so real prose containing a bracketed
// letter is never mistaken for a menu.
const CHOICE_MENU_RUN =
  /(?:\[[A-Za-z?]\]\s+\w+(?:[ '-]\w+){0,3}[\s:]*){2,}(?:\(default is "?\w+"?\)[\s:]*)?/g;

/**
 * The safety banner the shell-integration script prints on every shell
 * start. Meaningful in Raw mode; in Blocks it's chrome — and after a shell
 * respawn it lands mid-stream, gluing itself onto whatever card is open.
 */
export function isSafetyBanner(text: string): boolean {
  return text.trim().startsWith('Verlox safety on:');
}

// Keystroke instructions the buttons and reply input replace: "Press ^C at
// any time to quit.", "Press Enter to continue...:". Stripped as segments
// (not whole lines) because re-prompts glue them together on one line.
const INSTRUCTION_SEGMENTS: RegExp[] = [
  /Press (?:\^|Ctrl[+-])[A-Za-z] at any time to \w+\.?/gi,
  /Press (?:Enter|Return|any key) to continue[\s.]*:?/gi,
  /Verlox safety on: deletes here go to the Recycle Bin, so they can be undone\.?/g,
];

/**
 * Remove keystroke-menu tables from a display line, keeping whatever else
 * the line says. Once choices render as labeled buttons, the letter table
 * is instructions for a keyboard the user no longer needs — and menus can
 * arrive glued to real content (reprinted mid-line, or with the typed
 * answer echoed after them), so this strips the segment rather than
 * hiding whole lines. Returns '' when the line was only menu.
 */
export function stripChoiceGuide(line: string): string {
  let out = line;
  for (const re of INSTRUCTION_SEGMENTS) out = out.replace(re, '');
  if (/\[[A-Za-z?]\]\s+[A-Za-z]/.test(out)) {
    out = out
      .replace(CHOICE_MENU_RUN, '')
      .replace(/\(default is "?\w+"?\):?/gi, '');
  } else {
    // No menu run; the only other guide artifact is a wrapped default
    // clause stranded alone (with a possible echoed answer after it).
    out = out.replace(/^\s*\(default is "?\w+"?\):?\s*/i, '');
  }
  // Untouched lines pass through verbatim — collapsing whitespace would
  // wreck aligned table output (sc.exe, dir). Only stripped lines are
  // tidied, and what survives is real content: a question or an echo.
  if (out === line) return line;
  const tidy = out.replace(/\s+/g, ' ').trim();
  return tidy === ':' ? '' : tidy;
}

/** True when a display line is nothing but keystroke-menu chrome. */
export function isChoiceGuideLine(line: string): boolean {
  return line.trim() !== '' && stripChoiceGuide(line) === '';
}

/**
 * Replies a waiting command is asking for, as labeled buttons.
 *
 * Everything here is read from what the program actually printed — we never
 * invent an option. Where the program spells out what a key means ("[A] Yes
 * to All"), the button says the meaning and sends the key. Where it names a
 * default, that button is marked recommended.
 */
export function suggestedReplies(lines: string[], partial: string): SuggestedReply[] {
  const recent = lines.slice(-4).concat(partial).join('\n');
  if (!recent.trim()) return [];
  const out: SuggestedReply[] = [];
  const add = (label: string, send: string, recommended = false) => {
    const t = label.trim().replace(/\s+/g, ' ');
    if (!t || t.length > 24) return;
    if (out.some((o) => o.label.toLowerCase() === t.toLowerCase())) return;
    out.push(recommended ? { label: t, send, recommended: true } : { label: t, send });
  };

  // The program's own default: (default is "Y")
  const defMatch = recent.match(/default is "?([A-Za-z]+)"?/i);
  const def = defMatch ? defMatch[1].toLowerCase() : '';

  // npm-style default in parens on the question line itself:
  //   package name: (tyler)      Is this OK? (yes)      Ok to proceed? (y)
  // Enter accepts it, so the chip is the default value and sends Enter.
  // The unterminated partial is the usual home of the current question,
  // but npm sometimes newline-terminates it and parks a spinner as the
  // partial — so the last completed line is the backstop.
  const PAREN_DEF_RE = /[:?]\s*\(([^()\n]{1,24})\)\s*$/;
  let parenDef = PAREN_DEF_RE.exec(partial.trimEnd());
  if (!parenDef) {
    const lastLine = [...lines].reverse().find((l) => l.trim() !== '');
    if (lastLine) parenDef = PAREN_DEF_RE.exec(lastLine.trimEnd());
  }
  if (parenDef && !parenDef[1].includes('/')) add(parenDef[1], '\r', true);

  // Labeled keystroke menus, where the meaning is printed next to the key:
  //   [Y] Yes  [A] Yes to All  [N] No  [L] No to All  [S] Suspend  [?] Help
  // This is the richest form, so it wins outright when present.
  const labeled = [...recent.matchAll(/\[([A-Za-z?])\]\s+(\w+(?:[ '-]\w+){0,3})/g)];
  if (labeled.length >= 2) {
    for (const m of labeled) {
      const key = m[1];
      add(m[2], `${key}\r`, key.toLowerCase() === def);
    }
    return out.slice(0, 6);
  }

  // Letter-only menus: git add -p's  Stage this hunk [y,n,q,a,d,e,?]?
  const comma = recent.match(/\[([a-z?](?:,[a-z?]){2,})\]/i);
  if (comma) {
    for (const c of comma[1].split(',')) {
      const key = c.toLowerCase();
      add(LETTER_MEANINGS[key] ?? key, `${c}\r`, key === def);
    }
    return out.slice(0, 6);
  }

  // Quoted options: "help", "copyright", "credits" or "license"
  const quoted = recent.match(/"([^"\n]{1,24})"/g);
  if (quoted && quoted.length >= 2)
    for (const q of quoted) {
      const v = q.slice(1, -1);
      add(v, `${v}\r`, v.toLowerCase() === def);
    }

  // A single quoted offer still counts when the program invites typing it:
  // node's banner is  Type ".help" for more information.
  for (const m of recent.matchAll(/\b(?:type|enter|try|use)\s+"([^"\n]{1,24})"/gi))
    add(m[1], `${m[1]}\r`);

  // Unquoted command after "type": node's  ... or type .exit)
  for (const m of recent.matchAll(/\btype\s+([.\w()-]{1,24})/gi)) {
    let v = m[1];
    if (!v.endsWith('()')) v = v.replace(/[).,:;]+$/g, '');
    if (v && !/^(?:the|a|an|your|it|in)$/i.test(v)) add(v, `${v}\r`);
  }

  // Function-call offers on the way out: python's  Use exit() ... to exit
  if (/to (?:exit|quit)/i.test(recent))
    for (const m of recent.matchAll(/\b([A-Za-z_]\w*\(\))/g)) add(m[1], `${m[1]}\r`);

  // Control-key offers, in both spellings (Ctrl+C and npm's ^C). The label
  // is the action the program says the key performs ("Exit the REPL",
  // "Quit"), falling back to the key itself when the sentence doesn't name
  // one.
  for (const m of recent.matchAll(
    /(?:Ctrl[+-]|\^)([A-Za-z])\b(?:\s+(?:at any time\s+)?to\s+([a-z][a-z ]{2,23}?))?(?=[,.)\n]|\s+or\s|$)/gi,
  )) {
    const key = m[1].toUpperCase();
    const action = m[2]?.trim();
    const label = action ? action.charAt(0).toUpperCase() + action.slice(1) : `Ctrl+${key}`;
    add(label, ctrlSend(key));
  }

  // yes/no gates: [y/N], (y/n), and ssh's (yes/no/[fingerprint]). The
  // capitalized side is the default, which is how these prompts have always
  // signalled it — [y/N] means No unless you say otherwise.
  const yn = recent.match(/[[(]\s*(y(?:es)?)\s*\/\s*(no?)\b/i);
  if (yn) {
    const yesDefault = yn[1][0] === 'Y' && yn[2][0] !== 'N';
    const noDefault = yn[2][0] === 'N' && yn[1][0] !== 'Y';
    add('Yes', 'y\r', yesDefault);
    add('No', 'n\r', noDefault);
  }

  // Press Enter / press any key to continue (pause, installers).
  if (/press (?:any key|enter|return)/i.test(recent)) add('Continue', '\r');

  // Pipe-separated choices inside brackets: [start|stop|restart]
  const piped = recent.match(/[[(]([a-z0-9_-]+(?:\s*\|\s*[a-z0-9_-]+)+)[\])]/i);
  if (piped)
    for (const opt of piped[1].split('|')) {
      const v = opt.trim();
      add(v, `${v}\r`, v.toLowerCase() === def);
    }

  return out.slice(0, 6);
}

/**
 * Shorten an absolute path for a UI chip: the home directory collapses to
 * `~`, and anything deeper than two segments keeps only the tail so the chip
 * stays a fixed, readable width.
 *   C:\Users\tyler                  → ~
 *   C:\Users\tyler\Documents        → ~\Documents
 *   C:\Users\tyler\a\b\c            → ~\…\c
 *   C:\Program Files\nodejs         → …\nodejs
 */
export function shortenPath(absolute: string, home: string): string {
  if (!absolute) return '';
  const sep = absolute.includes('\\') ? '\\' : '/';
  const norm = (s: string) => s.replace(/[\\/]+$/, '');
  const path = norm(absolute);
  const h = norm(home);

  if (h && path.toLowerCase() === h.toLowerCase()) return '~';
  if (h && path.toLowerCase().startsWith(`${h.toLowerCase()}${sep}`)) {
    const rest = path.slice(h.length + 1).split(/[\\/]/);
    if (rest.length === 1) return `~${sep}${rest[0]}`;
    return `~${sep}…${sep}${rest[rest.length - 1]}`;
  }

  // Outside home: keep the path whole while it's short. The drive letter
  // ("C:") isn't a folder, so it doesn't count toward the depth budget.
  const parts = path.split(/[\\/]/).filter(Boolean);
  const folders = /^[a-z]:$/i.test(parts[0] ?? '') ? parts.slice(1) : parts;
  if (folders.length <= 2) return path;
  return `…${sep}${parts[parts.length - 1]}`;
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
  // True when this command took over the screen (vim, top, a REPL). Its
  // "output" is thousands of cursor-painting sequences that mean nothing as
  // scrollback, so the block shows a one-line note instead of the dump.
  interactive: boolean;
  // When output last arrived. A running block that has been quiet for a
  // beat is almost certainly waiting on the user, which the UI says plainly
  // instead of showing an indefinite "running".
  lastOutputAt: number;
  // Present when the app itself ended the command: the user pressed Stop,
  // or submitted a new command that replaced this one (`next` names it,
  // `waiting` records whether it was sitting at a prompt at the time).
  // The summary uses this to say what actually happened instead of judging
  // a deliberate stop as success or failure.
  stopped?: { reason: 'stop' | 'replaced'; next?: string; waiting?: boolean };
  // Styled-HTML freeze of the live terminal surface at the moment the
  // command ended (see blockSurface.ts). When present, the card renders
  // this instead of `lines` — colors and layout exactly as the terminal
  // drew them. `lines` still exists regardless: every analysis (summary,
  // chips, error scan) reads the plain text.
  snapshotHtml?: string;
  // True when the AI submitted this command (an accepted proposal in an AI
  // session). The card wears the model icon so it's always clear who
  // typed what into the shared terminal.
  byAi?: boolean;
}

// How long a running command must be silent before it reads as waiting for
// input rather than working.
export const WAITING_AFTER_MS = 1200;

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
  // REPL chrome. The app owns stopping and replying, so a line that is only
  // a REPL prompt (`>`, `>>>`), node's how-to-exit hint, or python's bare
  // KeyboardInterrupt echo is residue, not output. A real traceback keeps
  // its KeyboardInterrupt because the preceding frame lines are indented.
  if (/^[>»]+$/.test(t)) return true;
  if (t === '(To exit, press Ctrl+C again or Ctrl+D or type .exit)') return true;
  if (t === 'KeyboardInterrupt' && !(prev && /^\s/.test(prev))) return true;
  // The shell-start safety banner: chrome in Blocks, and after a respawn
  // it arrives mid-stream into whatever card is open.
  if (isSafetyBanner(t)) return true;
  // A repaint of the exact same line adds nothing.
  return t === prev?.trim();
}

// A closing block's trailing blank lines are separators whose second half
// got filtered (REPL chrome, interrupt echoes); nothing follows them.
function trimTrailingBlanks(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end--;
  return end === lines.length ? lines : lines.slice(0, end);
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
  type: 'start' | 'output' | 'end' | 'partial';
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

    // The shell's final prompt has no trailing newline, so it never reaches
    // the loop above. Without this check the last block would sit "running"
    // forever, even though the command already finished.
    const tail = reduceLine(this.buf).trimEnd();
    if (this.open) {
      const m = tail.match(PROMPT_RE);
      const isIdlePrompt = !!m && /[\\/]/.test(m[1]) && m[2].trim() === '';
      if (isIdlePrompt) {
        events.push({ type: 'end', text: '' });
        this.open = false;
      } else {
        // An unterminated tail while a command runs is usually the command
        // asking a question (confirm menus never end in a newline). Surface
        // it as the block's partial line so the user sees the question and
        // the reply chips can read it.
        events.push({ type: 'partial', text: tail });
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
      // A respawned shell's banner can glue onto a prompt line and read
      // like a submitted command. It never is one.
      if (isSafetyBanner(ev.text)) continue;
      blocks = openBlock(blocks, ev.text, now);
    } else if (ev.type === 'output') {
      blocks = appendToOpenBlock(blocks, `${ev.text}\n`);
    } else if (ev.type === 'partial') {
      const last = blocks[blocks.length - 1];
      if (last && last.endedAt === null && last.partial !== ev.text) {
        blocks = blocks
          .slice(0, -1)
          .concat({ ...last, partial: ev.text, lastOutputAt: now });
      }
    } else {
      const last = blocks[blocks.length - 1];
      if (last && last.endedAt === null) {
        blocks = blocks.slice(0, -1).concat({
          ...last,
          lines: trimTrailingBlanks(last.lines),
          endedAt: now,
          partial: '',
        });
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
    b.endedAt === null
      ? { ...b, lines: trimTrailingBlanks(b.lines), endedAt: now, partial: '' }
      : b,
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
    interactive: false,
    lastOutputAt: now,
  });
  return blocks.length > MAX_BLOCKS ? blocks.slice(-MAX_BLOCKS) : blocks;
}

/**
 * Attach the frozen surface snapshot to the block that just closed. Runs
 * as its own update right after closeBlock/applyFallbackEvents settle the
 * block, so neither close path needs to know snapshots exist. Interactive
 * (alt-screen) blocks are skipped: their grid holds screen-painting junk,
 * and the "(interactive session)" note is the honest render.
 */
export function attachSnapshotToLastClosed(
  prev: TerminalBlockData[],
  html: string,
): TerminalBlockData[] {
  // The closed block is usually last, but when one chunk carried both a
  // command's end AND the next command's start, the new open block sits
  // after it — look back a step or two, never further.
  if (!html) return prev;
  for (let i = prev.length - 1; i >= 0 && i >= prev.length - 3; i--) {
    const b = prev[i];
    if (b.endedAt === null) continue;
    if (b.interactive || b.snapshotHtml) return prev;
    const next = prev.slice();
    next[i] = { ...b, snapshotHtml: html };
    return next;
  }
  return prev;
}

/**
 * Record that the app is deliberately ending the running command (Stop
 * button, or a new command replacing it). The block still closes through
 * the normal path when the process actually dies; this only remembers why.
 */
export function markOpenBlockStopped(
  prev: TerminalBlockData[],
  stopped: NonNullable<TerminalBlockData['stopped']>,
): TerminalBlockData[] {
  const last = prev[prev.length - 1];
  if (!last || last.endedAt !== null) return prev;
  return prev.slice(0, -1).concat({ ...last, stopped });
}

/**
 * Flag the running block as a full-screen program. Called when the terminal
 * switches to its alternate screen buffer, so the block renders a note
 * instead of thousands of cursor-painting sequences.
 */
export function markOpenBlockInteractive(
  prev: TerminalBlockData[],
): TerminalBlockData[] {
  const last = prev[prev.length - 1];
  if (!last || last.endedAt !== null || last.interactive) return prev;
  return prev.slice(0, -1).concat({ ...last, interactive: true, partial: '' });
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
    lastOutputAt: Date.now(),
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
  const authoritative = trimTrailingBlanks(denoise(toDisplayLines(output), undefined));
  const { lines, truncated } = capLines([], authoritative);

  const last = prev[prev.length - 1];
  // A close with no command and nothing open is prompt housekeeping (a
  // Ctrl+C redraw at an idle prompt) — materializing it would show an
  // empty phantom card.
  if (command === '' && (!last || last.endedAt !== null)) return prev;
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
      // A full-screen program's captured "output" is screen painting, not
      // scrollback. Showing it would be pages of noise, so say what it was.
      lines: last.interactive ? ['(interactive session)'] : lines,
      partial: '',
      truncated: last.interactive ? false : truncated,
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
    interactive: false,
    lastOutputAt: now,
  });
  return blocks.length > MAX_BLOCKS ? blocks.slice(-MAX_BLOCKS) : blocks;
}
