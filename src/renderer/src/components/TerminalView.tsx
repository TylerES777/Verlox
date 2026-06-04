import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { Shell } from '@shared/types';
import { AgentPanel } from './AgentPanel';
import { registerTerminal, unregisterTerminal } from '../lib/terminalRegistry';
import { finalizeProcess, registerProcess } from '../hooks/useRunningProcesses';

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
        <OutputModeToggle />
      </div>

      {/* The outer box owns the padding + width cap; the INNER box is the
          xterm mount and carries NO padding, so FitAddon measures a clean box
          and fits the rows exactly — no clipped/unreachable last line. The
          large bottom padding keeps the live prompt above the floating chat
          panel (collapsed), so what you type is never cut off by it. */}
      <div className="min-h-0 w-full max-w-[900px] flex-1 overflow-hidden px-4 pb-24 pt-3">
        <div
          ref={hostRef}
          onMouseDown={() => termRef.current?.focus()}
          className="h-full w-full overflow-hidden"
        />
      </div>

      {/* Custom premium scrollbar — floats at the card's right edge (not the
          text-column edge) and mirrors the terminal's scroll. */}
      {sb.visible && (
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

// Raw vs AI output toggle. Raw shows the shell's real output; AI (when its
// pipeline is wired) explains each command's output in plain English instead,
// leaving commands that need live interaction untouched.
// Raw vs AI output. The AI-explains-output pipeline isn't wired yet, so the
// whole control is locked with a "Soon" tag until it ships.
function OutputModeToggle() {
  return (
    <div
      className="flex cursor-default select-none items-center gap-1.5 rounded-full border border-hairline bg-surface-subtle px-2.5 py-0.5 text-[10.5px] font-medium text-ink-hint"
      role="group"
      aria-label="Output mode (coming soon)"
      title="Raw / AI output — coming soon"
    >
      <span>Raw</span>
      <span aria-hidden="true" className="text-ink-micro">
        ·
      </span>
      <span className="flex items-center gap-0.5">
        <span aria-hidden="true">✦</span>AI
      </span>
      <span className="ml-0.5 rounded-full bg-black/[0.06] px-1.5 py-px text-[8.5px] font-semibold uppercase tracking-wide text-ink-micro">
        Soon
      </span>
    </div>
  );
}
