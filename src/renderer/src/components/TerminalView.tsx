import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { Shell } from '@shared/types';
import { AgentPanel } from './AgentPanel';
import { CopyButton } from './CopyButton';
import { registerTerminal, unregisterTerminal } from '../lib/terminalRegistry';
import { finalizeProcess, registerProcess } from '../hooks/useRunningProcesses';
import {
  applyBlockEvents,
  BlockStreamParser,
  type TerminalBlockData,
} from '../lib/terminalBlocks';

// Raw shows the live xterm surface; Blocks slices the same stream into
// Warp-style command/output cards. Persisted globally — if you prefer
// blocks, you prefer them in every tab and every session.
type OutputMode = 'raw' | 'blocks';
const OUTPUT_MODE_KEY = 'verlox-output-mode';

function loadOutputMode(): OutputMode {
  try {
    return localStorage.getItem(OUTPUT_MODE_KEY) === 'blocks' ? 'blocks' : 'raw';
  } catch {
    return 'raw';
  }
}

interface TerminalViewProps {
  // The owning tab's id. Doubles as the PTY session key, so input, output,
  // resize and teardown all route to the right shell when several
  // terminal tabs are open at once.
  id: string;
  // Whether this tab is the visible one. A hidden tab measures as 0×0, so
  // we defer the first fit (and re-fit on show) until it's actually on
  // screen — otherwise the PTY would be sized to nothing.
  isActive: boolean;
  // Called once with the first command the user runs, so the tab can be
  // renamed from "Terminal" to that command.
  onFirstCommand?: (command: string) => void;
}

// In dev, React StrictMode mounts → unmounts → remounts each component in
// the same tick to surface side-effect bugs. A naive cleanup would kill the
// freshly-spawned shell on that throwaway unmount, and the remount a moment
// later would be left typing into a dead shell. So we don't kill on unmount
// immediately: we SCHEDULE the kill and let a remount (which arrives within
// microseconds) cancel it. A real tab close has no remount, so the scheduled
// kill still fires and the shell is torn down. Keyed by tab id so several
// terminals never cross wires. No-op effect in production (no double-mount).
const pendingKills = new Map<string, ReturnType<typeof setTimeout>>();

// A live interactive terminal tab. Renders an xterm.js surface and relays
// raw bytes to/from a node-pty process in the main process (see
// pty-manager.ts). Unlike the plan-execution flow, there's no AI in the
// loop here: the user types straight into a real shell, so interactive
// CLIs (Claude Code, vim, REPLs) work exactly as they would in any
// terminal. The approve-before-run layer sits on top of this, not inside it.
// Rewind / restore points now live in the sidebar, not over the terminal.
export function TerminalView({ id, isActive, onFirstCommand }: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // Becomes true once the PTY has been spawned, so a deferred first fit
  // (for a tab that mounts while hidden) knows whether to start it.
  const startedRef = useRef(false);
  // Title the tab from the first command run; ref so the once-only check and
  // latest callback survive across renders without re-running the mount effect.
  const titledRef = useRef(false);
  const onFirstCommandRef = useRef(onFirstCommand);
  onFirstCommandRef.current = onFirstCommand;
  // For surfacing long-running commands the user types directly (not just
  // agent-run ones) in the sidebar's Running section.
  const envShellRef = useRef<Shell>('powershell');
  const envHomeRef = useRef('');
  const termRunRef = useRef<{
    runId: string;
    timer: ReturnType<typeof setTimeout> | null;
    registered: boolean;
  } | null>(null);
  // Last cwd parsed from the prompt, so we only emit on an actual change.
  const lastCwdRef = useRef('');
  // Custom scrollbar that floats at the card's right edge (xterm's native one
  // is hidden via CSS, since it would sit at the narrow text-column edge). The
  // thumb's size/position mirror the terminal's scroll; dragging it scrolls.
  const scrollbarTrackRef = useRef<HTMLDivElement | null>(null);
  const lastSbRef = useRef('');
  const [sb, setSb] = useState<{ visible: boolean; topPct: number; heightPct: number }>({
    visible: false,
    topPct: 0,
    heightPct: 0,
  });

  // Raw vs Blocks output. Blocks accrue from terminal mount regardless of
  // the visible mode, so toggling later shows the history since open (the
  // parser can't reconstruct scrollback it never saw).
  const [mode, setMode] = useState<OutputMode>(loadOutputMode);
  const [blocks, setBlocks] = useState<TerminalBlockData[]>([]);
  const [pendingLine, setPendingLine] = useState('');

  const switchMode = (next: OutputMode) => {
    setMode(next);
    try {
      localStorage.setItem(OUTPUT_MODE_KEY, next);
    } catch {
      /* private mode etc. — preference just won't stick */
    }
    if (next === 'raw') {
      // The xterm box was visually hidden (opacity 0, geometry intact), so
      // a fit is cheap insurance and the scroll position snaps to live.
      requestAnimationFrame(() => {
        try {
          fitRef.current?.fit();
        } catch {
          /* hidden-measure race — next resize refits */
        }
        termRef.current?.scrollToBottom();
        termRef.current?.focus();
      });
    }
  };

  // Second, independent tap on the PTY stream (xterm keeps its own). The
  // parser slices bytes into block events; state updates batch per chunk.
  useEffect(() => {
    const parser = new BlockStreamParser();
    let lastPending = '';
    const off = window.api.onPtyData((event) => {
      if (event.id !== id) return;
      const events = parser.feed(event.data);
      if (events.length > 0) {
        const now = Date.now();
        setBlocks((prev) => applyBlockEvents(prev, events, now));
      }
      if (parser.pending !== lastPending) {
        lastPending = parser.pending;
        setPendingLine(parser.pending);
      }
    });
    return off;
  }, [id]);

  const onScrollbarThumbDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const t = termRef.current;
    const track = scrollbarTrackRef.current;
    if (!t || !track) return;
    const startY = e.clientY;
    const startViewportY = t.buffer.active.viewportY;
    const maxScroll = t.buffer.active.baseY;
    const heightFrac = Math.max(t.rows / t.buffer.active.length, 0.05);
    const travelPx = track.clientHeight * (1 - heightFrac);
    const onMove = (ev: MouseEvent) => {
      const tt = termRef.current;
      if (!tt) return;
      const dy = ev.clientY - startY;
      const dLines = travelPx > 0 ? (dy / travelPx) * maxScroll : 0;
      const target = Math.max(0, Math.min(maxScroll, Math.round(startViewportY + dLines)));
      tt.scrollLines(target - tt.buffer.active.viewportY);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  // Mount the terminal once. Tabs stay mounted across switches (so a
  // long-running shell survives), so this effect runs a single time per
  // terminal tab for its whole lifetime.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // If this is a StrictMode remount, a kill from the throwaway unmount is
    // sitting in the queue — cancel it so the shell we're about to reuse
    // survives instead of being torn down a beat later.
    const pendingKill = pendingKills.get(id);
    if (pendingKill) {
      clearTimeout(pendingKill);
      pendingKills.delete(id);
    }

    const term = new Terminal({
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 15,
      lineHeight: 1.2,
      cursorBlink: true,
      // A calm, light terminal that belongs to the white app surface
      // instead of dropping a black box into it. The ANSI palette is tuned
      // for a near-white background — xterm's defaults are built for dark
      // terminals, so their yellow/green/cyan are garish and low-contrast
      // here (e.g. PowerShell's PSReadLine paints the command token bright
      // yellow). These are muted, darker variants that stay legible on white.
      theme: {
        background: '#FFFFFF',
        foreground: '#3A3A3A',
        cursor: '#3A3A3A',
        cursorAccent: '#FBFBFA',
        selectionBackground: '#D8E6F2',
        black: '#3A3A3A',
        red: '#B4322B',
        green: '#3E7A53',
        yellow: '#9A7D2E',
        blue: '#2E5FA3',
        magenta: '#8A4D9E',
        cyan: '#2C7A7A',
        white: '#9A9A9A',
        brightBlack: '#6A6A6A',
        brightRed: '#C0392B',
        brightGreen: '#2E8B57',
        brightYellow: '#B07A1E',
        brightBlue: '#3B73C4',
        brightMagenta: '#A05BB5',
        brightCyan: '#2C9C9C',
        brightWhite: '#4A4A4A',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;
    // Register this terminal so the agent panel can read its on-screen
    // content (always-on terminal awareness, across tabs).
    registerTerminal(id, term);

    // Keep the custom scrollbar in sync with the terminal's scroll position
    // and content height. Throttled to one update per frame; only commits to
    // state when the values actually change, so heavy output / cursor blinks
    // don't cause a flood of re-renders.
    let sbRaf = 0;
    const updateSb = () => {
      if (sbRaf) return;
      sbRaf = requestAnimationFrame(() => {
        sbRaf = 0;
        const b = term.buffer.active;
        let next: { visible: boolean; topPct: number; heightPct: number };
        if (b.length <= term.rows) {
          next = { visible: false, topPct: 0, heightPct: 0 };
        } else {
          const heightFrac = Math.max(term.rows / b.length, 0.05);
          const posFrac = b.baseY > 0 ? b.viewportY / b.baseY : 1;
          next = {
            visible: true,
            topPct: posFrac * (1 - heightFrac) * 100,
            heightPct: heightFrac * 100,
          };
        }
        const key = `${next.visible}|${next.topPct.toFixed(2)}|${next.heightPct.toFixed(2)}`;
        if (key !== lastSbRef.current) {
          lastSbRef.current = key;
          setSb(next);
        }
      });
    };
    // Know the shell/home for labelling user-typed running commands.
    void window.api
      .getEnvironment()
      .then((e) => {
        envShellRef.current = e.shell;
        envHomeRef.current = e.homeDir;
      })
      .catch(() => {});

    // Surface a command the user TYPES (not just agent-run ones) in the
    // Running board — but only if it's still going after a beat, so quick
    // commands (ls, cd) never flash in. Completion is detected by the shell
    // prompt returning (see checkTermDone), so dev servers / watchers persist.
    const beginTermRun = (command: string) => {
      if (termRunRef.current?.timer) clearTimeout(termRunRef.current.timer);
      const runId = `term-${id}-${crypto.randomUUID()}`;
      const entry = {
        runId,
        timer: null as ReturnType<typeof setTimeout> | null,
        registered: false,
      };
      termRunRef.current = entry;
      entry.timer = setTimeout(() => {
        if (termRunRef.current === entry && !entry.registered) {
          entry.registered = true;
          registerProcess({
            stepId: runId,
            conversationId: id,
            command,
            cwd: envHomeRef.current,
            shell: envShellRef.current,
            source: 'terminal',
          });
        }
      }, 1500);
    };
    const checkTermDone = () => {
      const entry = termRunRef.current;
      if (!entry) return;
      const buf = term.buffer.active;
      const cursorLine =
        buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true)?.trim() ?? '';
      // A fresh PowerShell prompt with nothing typed after it = shell is idle,
      // so the typed command has finished.
      if (/^PS .*>$/.test(cursorLine)) {
        if (entry.timer) clearTimeout(entry.timer);
        if (entry.registered) finalizeProcess(entry.runId, { exitCode: 0, signal: null });
        termRunRef.current = null;
      }
    };

    // Track the shell's directory from the prompt (PS <path>>), and tell the
    // agent panel when it changes so its working folder follows the terminal.
    const checkCwd = () => {
      const buf = term.buffer.active;
      const cursorLine =
        buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true)?.trim() ?? '';
      const m = cursorLine.match(/^PS (.+?)>$/);
      if (!m) return;
      const cwd = m[1].trim();
      if (cwd && cwd !== lastCwdRef.current) {
        lastCwdRef.current = cwd;
        window.dispatchEvent(new CustomEvent('verlox:cwd-changed', { detail: { id, cwd } }));
      }
    };

    const sbScroll = term.onScroll(() => updateSb());
    const sbRender = term.onRender(() => {
      updateSb();
      checkTermDone();
      checkCwd();
    });

    const start = () => {
      if (startedRef.current) return;
      try {
        fit.fit();
      } catch {
        // Host not measurable yet; a later resize will fit + start.
      }
      const { cols, rows } = term;
      if (cols < 2 || rows < 2) return; // not laid out yet — wait
      startedRef.current = true;
      window.api.ptyStart({ id, cols, rows });
      // Grab keyboard focus the moment the shell is live, so the user can
      // type straight away without a click. Without this the focus often
      // sits on the "New terminal" button that opened the tab.
      term.focus();
    };

    // Forward keystrokes / pastes straight to the PTY.
    const dataSub = term.onData((data) => {
      window.api.ptyInput({ id, data });
      // On Enter, read the command on the prompt line. First one names the tab;
      // every one feeds the long-running-command detector.
      if (data.includes('\r')) {
        const buf = term.buffer.active;
        const line =
          buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true) ?? '';
        const cmd = line.split('> ').pop()?.trim() ?? '';
        if (cmd) {
          if (!titledRef.current) {
            titledRef.current = true;
            onFirstCommandRef.current?.(cmd);
          }
          beginTermRun(cmd);
        }
      }
    });

    // PTY output → screen. Filter by id so each terminal only renders
    // its own shell's bytes.
    const offData = window.api.onPtyData((event) => {
      if (event.id === id) term.write(event.data);
    });

    const offExit = window.api.onPtyExit((event) => {
      if (event.id !== id) return;
      term.write(`\r\n\x1b[90m[process exited: ${event.exitCode}]\x1b[0m\r\n`);
    });

    // Keep the PTY sized to the viewport.
    const resize = () => {
      const f = fitRef.current;
      const t = termRef.current;
      if (!f || !t) return;
      try {
        f.fit();
      } catch {
        return;
      }
      if (!startedRef.current) {
        start();
        return;
      }
      window.api.ptyResize({ id, cols: t.cols, rows: t.rows });
    };

    const observer = new ResizeObserver(() => resize());
    observer.observe(host);

    // Attempt an initial start (works when the tab mounts visible).
    start();

    return () => {
      observer.disconnect();
      dataSub.dispose();
      sbScroll.dispose();
      sbRender.dispose();
      if (sbRaf) cancelAnimationFrame(sbRaf);
      // Clear any pending/registered terminal-run tracking for this tab.
      if (termRunRef.current?.timer) clearTimeout(termRunRef.current.timer);
      if (termRunRef.current?.registered) {
        finalizeProcess(termRunRef.current.runId, { exitCode: null, signal: 'closed' });
      }
      termRunRef.current = null;
      offData();
      offExit();
      unregisterTerminal(id);
      // Defer the kill so a StrictMode remount can cancel it (see the note on
      // pendingKills above). A real close has no remount, so this fires.
      pendingKills.set(
        id,
        setTimeout(() => {
          pendingKills.delete(id);
          window.api.ptyKill(id);
        }, 250),
      );
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [id]);

  // When this tab becomes visible (or the window resizes it), re-fit and
  // focus. A tab that first mounted while hidden gets its PTY started here.
  useEffect(() => {
    if (!isActive) return;
    const t = termRef.current;
    const f = fitRef.current;
    if (!t || !f) return;
    // Defer to the next frame so layout has settled before we measure.
    const raf = requestAnimationFrame(() => {
      try {
        f.fit();
      } catch {
        return;
      }
      if (!startedRef.current) {
        if (t.cols >= 2 && t.rows >= 2) {
          startedRef.current = true;
          window.api.ptyStart({ id, cols: t.cols, rows: t.rows });
        }
      } else {
        window.api.ptyResize({ id, cols: t.cols, rows: t.rows });
      }
      t.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [isActive, id]);

  // Clicking anywhere in the pane focuses the terminal, so a click after
  // the terminal has lost focus (e.g. to DevTools or another tab) always
  // restores typing. mousedown (not click) so focus lands before the
  // browser's default selection handling runs.
  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-white">
      {/* Chrome bar — a solid header strip with the Raw / AI output toggle. */}
      <div className="flex shrink-0 items-center justify-between border-b border-hairline bg-surface-subtle px-3 py-1.5">
        <div className="flex items-center gap-2">
          <span className="flex gap-1" aria-hidden="true">
            <span className="h-2 w-2 rounded-full bg-black/[0.08]" />
            <span className="h-2 w-2 rounded-full bg-black/[0.08]" />
            <span className="h-2 w-2 rounded-full bg-black/[0.08]" />
          </span>
          <span className="text-[11px] font-medium text-ink-hint">Terminal</span>
        </div>
        <OutputModeToggle mode={mode} onChange={switchMode} />
      </div>

      {/* The outer box owns the padding + width cap; the INNER box is the
          xterm mount and carries NO padding, so FitAddon measures a clean box
          and fits the rows exactly — no clipped/unreachable last line. The
          large bottom padding keeps the live prompt above the floating chat
          panel (collapsed), so what you type is never cut off by it.
          In Blocks mode the xterm box stays mounted at full size (it keeps
          consuming the PTY stream, and hiding via opacity rather than
          display:none keeps FitAddon's geometry valid) with BlocksView
          layered over it. */}
      <div className="relative min-h-0 w-full flex-1">
        <div
          aria-hidden={mode === 'blocks'}
          className={`h-full w-full max-w-[900px] overflow-hidden px-4 pb-24 pt-3 ${
            mode === 'blocks' ? 'pointer-events-none opacity-0' : ''
          }`}
        >
          <div
            ref={hostRef}
            onMouseDown={() => termRef.current?.focus()}
            className="h-full w-full overflow-hidden"
          />
        </div>
        {mode === 'blocks' && (
          <BlocksView
            terminalId={id}
            blocks={blocks}
            pendingLine={pendingLine}
          />
        )}
      </div>

      {/* Custom premium scrollbar — floats at the card's right edge (not the
          text-column edge) and mirrors the terminal's scroll. Raw mode only;
          BlocksView scrolls natively. */}
      {sb.visible && mode === 'raw' && (
        <div
          ref={scrollbarTrackRef}
          className="absolute right-1.5 top-11 bottom-3 z-[7] w-1.5"
        >
          <div
            onMouseDown={onScrollbarThumbDown}
            className="absolute left-0 w-full cursor-pointer rounded-full bg-black/15 transition-colors hover:bg-black/30"
            style={{ top: `${sb.topPct}%`, height: `${sb.heightPct}%` }}
          />
        </div>
      )}

      {/* The floating natural-language panel where you and Verlox talk and
          approve actions. It floats over the terminal and never resizes the
          shell. See AgentPanel.tsx. */}
      <AgentPanel terminalId={id} />
    </div>
  );
}

// Raw vs Blocks output toggle. Raw is the live xterm surface; Blocks slices
// the same stream into one card per command (Warp-style). A future AI mode
// (explain each command's output in plain English) can join as a third pill.
function OutputModeToggle({
  mode,
  onChange,
}: {
  mode: OutputMode;
  onChange: (mode: OutputMode) => void;
}) {
  const pill = (m: OutputMode, label: string) => (
    <button
      type="button"
      onClick={() => onChange(m)}
      aria-pressed={mode === m}
      className={`rounded-full px-2.5 py-0.5 transition-colors ${
        mode === m
          ? 'bg-[#15161A] text-white'
          : 'text-ink-hint hover:text-[#3A3A3A]'
      }`}
    >
      {label}
    </button>
  );
  return (
    <div
      role="group"
      aria-label="Output mode"
      className="flex select-none items-center gap-0.5 rounded-full border border-hairline bg-white p-0.5 text-[10.5px] font-medium"
    >
      {pill('raw', 'Raw')}
      {pill('blocks', 'Blocks')}
    </div>
  );
}

// The Blocks view: every command the shell ran since this tab opened, one
// card each, newest at the bottom, with a command bar that types into the
// same PTY. Reading is the point; the Raw view stays a toggle away for
// full-fidelity scrollback and interactive CLIs (vim, REPLs).
function BlocksView({
  terminalId,
  blocks,
  pendingLine,
}: {
  terminalId: string;
  blocks: TerminalBlockData[];
  pendingLine: string;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState('');

  // Stick to the bottom while new output streams in, unless the user has
  // scrolled up to read something (then leave them alone).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [blocks, pendingLine]);

  const send = (e: FormEvent) => {
    e.preventDefault();
    const cmd = draft.trim();
    if (!cmd) return;
    window.api.ptyInput({ id: terminalId, data: `${cmd}\r` });
    setDraft('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Ctrl+C with nothing typed interrupts the running command, same as a
    // real terminal. With a draft present, let the browser copy/clear it.
    if (e.ctrlKey && e.key === 'c' && draft === '') {
      e.preventDefault();
      window.api.ptyInput({ id: terminalId, data: '\x03' });
    }
  };

  const running = blocks.length > 0 && blocks[blocks.length - 1].endedAt === null;
  const fmtTime = (ms: number) =>
    new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="absolute inset-0 flex flex-col">
      <div ref={scrollRef} className="min-h-0 w-full max-w-[900px] flex-1 overflow-y-auto px-4 pt-3">
        {blocks.length === 0 && (
          <p className="mt-8 text-center text-[12.5px] text-ink-hint">
            Each command you run becomes a block here, with its output and a
            copy button. Run something below to start.
          </p>
        )}
        <div className="space-y-2.5 pb-3">
          {blocks.map((b) => {
            const isRunning = b.endedAt === null;
            const output = b.lines.join('\n');
            return (
              <div
                key={b.id}
                className="group overflow-hidden rounded-xl border border-hairline bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04)]"
              >
                <div className="flex items-center gap-2 border-b border-hairline bg-surface-subtle px-3 py-1.5">
                  <span aria-hidden="true" className="font-mono text-[12px] text-[#3E7A53]">
                    ❯
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] font-medium text-[#3A3A3A]">
                    {b.command}
                  </span>
                  {isRunning ? (
                    <>
                      <span className="font-mono text-[10px] text-amber-600">running</span>
                      <button
                        type="button"
                        onClick={() => window.api.ptyInput({ id: terminalId, data: '\x03' })}
                        className="rounded-md border border-hairline px-2 py-0.5 text-[10px] font-medium text-ink-hint hover:text-[#3A3A3A]"
                      >
                        Stop
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="font-mono text-[10px] text-ink-micro">
                        {fmtTime(b.startedAt)}
                      </span>
                      <span className="opacity-0 transition-opacity group-hover:opacity-100">
                        <CopyButton
                          text={output || b.command}
                          variant="inline"
                          label="Copy"
                        />
                      </span>
                    </>
                  )}
                </div>
                {(output || isRunning || !b.truncated) && (
                  <div className="max-h-72 overflow-y-auto px-3 py-2 font-mono text-[12px] leading-[1.55] text-[#3A3A3A]">
                    {b.truncated && (
                      <p className="text-ink-micro">… earlier output trimmed</p>
                    )}
                    {output ? (
                      <pre className="whitespace-pre-wrap break-words font-mono">{output}</pre>
                    ) : !isRunning ? (
                      <span className="text-ink-micro">(no output)</span>
                    ) : null}
                    {isRunning && pendingLine && (
                      <p className="whitespace-pre-wrap break-words text-ink-hint">{pendingLine}</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Command bar — types into the same shell the Raw view shows. The
          bottom margin keeps it above the floating chat panel. */}
      <form onSubmit={send} className="w-full max-w-[900px] px-4 pb-24 pt-1">
        <div className="flex items-center gap-2 rounded-xl border border-subtle-border bg-white px-3 py-2 shadow-[0_1px_2px_rgba(16,24,40,0.06)]">
          <span aria-hidden="true" className="font-mono text-[13px] text-[#3E7A53]">
            ❯
          </span>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={running ? 'A command is running. Ctrl+C interrupts it.' : 'Run a command'}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-[#3A3A3A] outline-none placeholder:text-ink-micro"
          />
        </div>
      </form>
    </div>
  );
}
