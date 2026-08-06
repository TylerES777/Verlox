import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { Shell } from '@shared/types';
import { CopyButton } from './CopyButton';
import { registerTerminal, unregisterTerminal } from '../lib/terminalRegistry';
import {
  finalizeProcess,
  registerProcess,
  touchProcess,
} from '../hooks/useRunningProcesses';
import { BlockSurface } from '../lib/blockSurface';
import {
  applyCandidate,
  commandCandidates,
  currentToken,
  historyAppend,
  historyLoad,
  historySearch,
  pathCandidates,
  planCompletion,
  type TokenSpan,
} from '../lib/commandBar';
import {
  appendToOpenBlock,
  applyFallbackEvents,
  attachSnapshotToLastClosed,
  closeBlock,
  markOpenBlockInteractive,
  markOpenBlockStopped,
  openBlock,
  isSafetyBanner,
  PromptFallbackParser,
  shortenPath,
  stripChoiceGuide,
  suggestedReplies,
  WAITING_AFTER_MS,
  type TerminalBlockData,
} from '../lib/terminalBlocks';
import type { VaultEntry } from '@shared/types';
import { PathPicker, type PathSelection } from './PathPicker';
import iconAnthropic from '../assets/providers/anthropic.png';
import iconOpenAI from '../assets/providers/openai.png';
import iconGoogle from '../assets/providers/google.png';
import iconMeta from '../assets/providers/meta.png';
import iconGrok from '../assets/providers/grok.png';
import iconDeepSeek from '../assets/providers/deepseek.png';
import iconQwen from '../assets/providers/qwen.png';

const BRAIN_PROVIDER_PNGS: Record<string, string> = {
  anthropic: iconAnthropic,
  openai: iconOpenAI,
  google: iconGoogle,
  meta: iconMeta,
  xai: iconGrok,
  deepseek: iconDeepSeek,
  qwen: iconQwen,
};

// Raw shows the live xterm surface; Blocks slices the same stream into
// Warp-style command/output cards. Persisted globally — if you prefer
// blocks, you prefer them in every tab and every session.
type OutputMode = 'raw' | 'blocks';
const OUTPUT_MODE_KEY = 'verlox-output-mode';

// Blocks is the default: it's the surface that carries the summaries, Fix
// this, Explain, and the vault links — the reason to pick Verlox over any
// other terminal. Landing in Raw made a new user's first impression
// identical to every other terminal. Raw stays one click away for
// interactive programs (vim, REPLs, other AI CLIs) and full-fidelity
// scrollback, and the choice persists once made.
function loadOutputMode(): OutputMode {
  try {
    return localStorage.getItem(OUTPUT_MODE_KEY) === 'raw' ? 'raw' : 'blocks';
  } catch {
    return 'blocks';
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
  // the visible mode, so toggling later shows the history since open (shell
  // integration can't reconstruct scrollback it never saw).
  const [mode, setMode] = useState<OutputMode>(loadOutputMode);
  const [blocks, setBlocks] = useState<TerminalBlockData[]>([]);
  // Where the shell currently is, read off the prompt. Shown as a chip on
  // the folder browser so the command bar always says where you are.
  const [cwd, setCwd] = useState('');
  // True while a full-screen program owns the terminal (alternate screen
  // buffer). Blocks steps aside for it and comes back when it exits.
  const [altScreen, setAltScreen] = useState(false);
  // Mirror of altScreen for the PTY data listener, which is registered once
  // and would otherwise close over a stale value.
  const altScreenRef = useRef(false);

  // Surface a command the user runs in the Running board — but only if it's
  // still going after a beat, so quick commands (ls, cd) never flash in.
  // Defined at component scope (not inside the xterm effect) because BOTH
  // entry paths need it: keystrokes typed into the raw terminal, and
  // commands sent from the Blocks command bar, which never touch xterm.
  const beginTermRunRef = useRef((command: string) => {
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
          cwd: lastCwdRef.current || envHomeRef.current,
          shell: envShellRef.current,
          source: 'terminal',
        });
      }
    }, 1500);
  });

  // Any output at all counts as the process still working, which is what
  // separates a busy row from one parked at a prompt.
  const touchTermRunRef = useRef(() => {
    const entry = termRunRef.current;
    if (entry?.registered) touchProcess(entry.runId);
  });

  // The command finished: drop it from the Running board. Called from the
  // shell-integration close event, which is definitive and shell-agnostic
  // (the raw path also has a prompt-watching fallback, see checkTermDone).
  const endTermRunRef = useRef((exitCode: number | null) => {
    const entry = termRunRef.current;
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.registered) finalizeProcess(entry.runId, { exitCode, signal: null });
    termRunRef.current = null;
  });

  // The live surface that renders the RUNNING command's bytes exactly —
  // colors, in-place menus, progress bars — inside its card, and freezes
  // to a styled snapshot when the command ends. One instance serves
  // whichever block is running; the text pipeline (blocks state) keeps
  // running unchanged underneath for summaries, chips and waiting logic.
  const surfaceRef = useRef<BlockSurface | null>(null);
  const getSurface = () => {
    if (!surfaceRef.current) {
      surfaceRef.current = new BlockSurface((data) =>
        window.api.ptyInput({ id, data }),
      );
    }
    return surfaceRef.current;
  };
  useEffect(
    () => () => {
      surfaceRef.current?.dispose();
      surfaceRef.current = null;
    },
    [],
  );
  // Stable identity: React calls a ref callback on every render if its
  // identity changes, which would bounce the live element between parents.
  const surfaceMount = useRef((node: HTMLDivElement | null) => {
    getSurface().mountInto(node);
  }).current;
  const surfaceFocus = useRef(() => {
    surfaceRef.current?.focus();
  }).current;

  // Blocks is shown when the user is in Blocks mode AND no full-screen
  // program is running. vim/top take the terminal for as long as they
  // need it, then Blocks returns on its own.
  const showBlocks = mode === 'blocks' && !altScreen;

  // Focus the terminal the moment a full-screen program appears, so typing
  // reaches it without a click.
  useEffect(() => {
    if (altScreen) termRef.current?.focus();
  }, [altScreen]);

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

  // Blocks come from OSC 133 shell integration, parsed in the main process:
  // block-start opens a running card, raw pty:data streams live output into
  // it, and block (the 'D' mark) closes it with the shell's real exit code.
  // Nothing here parses the prompt, so this works on any shell that emits
  // the marks — PowerShell today, zsh/bash when their hooks land.
  useEffect(() => {
    // True once any OSC 133 mark arrives. Until then we can't assume shell
    // integration loaded, so raw data also feeds the prompt-reading fallback
    // — otherwise a shell that never emits marks would show no blocks at all.
    let oscActive = false;
    const fallback = new PromptFallbackParser();

    // Whether the live surface is collecting the current command's bytes.
    // Begins on block open (either path), ends when the block closes; the
    // closing freeze attaches the snapshot to the block.
    let surfaceActive = false;
    const surfaceBegin = (command: string) => {
      getSurface().beginCommand(termRef.current?.cols ?? 120, command);
      surfaceActive = true;
    };
    const surfaceFreeze = () => {
      if (!surfaceActive) return;
      surfaceActive = false;
      const html = surfaceRef.current?.snapshot() ?? '';
      if (html) setBlocks((prev) => attachSnapshotToLastClosed(prev, html));
    };

    const titleFrom = (command: string) => {
      if (titledRef.current || !command) return;
      titledRef.current = true;
      onFirstCommandRef.current?.(command);
    };

    const offStart = window.api.onPtyBlockStart((event) => {
      if (event.id !== id) return;
      oscActive = true;
      const command = event.command.trim();
      if (!command || isSafetyBanner(command)) return;
      titleFrom(command);
      // Commands sent from the Blocks command bar bypass xterm's onData, so
      // this is where they get surfaced in the Running board.
      beginTermRunRef.current(command);
      setBlocks((prev) => openBlock(prev, command, Date.now()));
      surfaceBegin(command);
    });

    const offData = window.api.onPtyData((event) => {
      if (event.id !== id) return;
      // While a full-screen program owns the terminal, its output is cursor
      // painting meant for the screen, not scrollback. xterm renders it; the
      // block ignores it.
      if (altScreenRef.current) return;
      touchTermRunRef.current();
      if (oscActive) {
        if (surfaceActive) getSurface().feed(event.data);
        setBlocks((prev) => appendToOpenBlock(prev, event.data));
        return;
      }
      const events = fallback.feed(event.data);
      // The Running board has to be fed from BOTH paths. When the shell
      // marks never arrive this is the only place a command's start and end
      // are observed, so a REPL launched here would otherwise never appear.
      for (const ev of events) {
        if (ev.type === 'start') {
          titleFrom(ev.text);
          beginTermRunRef.current(ev.text);
        } else if (ev.type === 'end') {
          endTermRunRef.current(null);
        }
      }
      // Surface sequencing. One chunk can end command A AND start command
      // B, and the grid must freeze for A before it resets for B — so the
      // chunk feeds the CURRENT grid when an end is present, and only a
      // pure start feeds the fresh one (echo included; snapshots trim
      // prompt rows either way).
      const hasEnd = events.some((ev) => ev.type === 'end');
      const started = events.some(
        (ev) => ev.type === 'start' && !isSafetyBanner(ev.text),
      );
      if ((hasEnd || !started) && surfaceActive) getSurface().feed(event.data);
      if (events.length > 0)
        setBlocks((prev) => applyFallbackEvents(prev, events, Date.now()));
      if (hasEnd) surfaceFreeze();
      if (started) {
        const startEv = events.find(
          (ev) => ev.type === 'start' && !isSafetyBanner(ev.text),
        );
        surfaceBegin(startEv?.text ?? '');
        if (!hasEnd) getSurface().feed(event.data);
      }
    });

    const offBlock = window.api.onPtyBlock((event) => {
      if (event.id !== id) return;
      oscActive = true;
      endTermRunRef.current(event.exitCode);
      setBlocks((prev) =>
        closeBlock(prev, event.command.trim(), event.output, event.exitCode, Date.now()),
      );
      surfaceFreeze();
    });

    return () => {
      offStart();
      offData();
      offBlock();
    };
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

    const beginTermRun = beginTermRunRef.current;
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
        // Drives the folder chip in the Blocks command bar, and seeds the
        // folder browser so it opens where the shell actually is.
        setCwd(cwd);
        window.dispatchEvent(new CustomEvent('verlox:cwd-changed', { detail: { id, cwd } }));
      }
    };

    // Full-screen programs (vim, less, top, htop, REPL TUIs, other AI CLIs)
    // switch the terminal to its ALTERNATE screen buffer. When that happens
    // the Blocks overlay steps aside and the live terminal takes over, so
    // interactive programs work exactly as they do in Raw — then Blocks
    // returns when the program exits. The user never toggles a mode.
    const sbBuffer = term.buffer.onBufferChange(() => {
      const alt = term.buffer.active.type === 'alternate';
      altScreenRef.current = alt;
      setAltScreen(alt);
      // Tag the block that launched it, so when the program exits the block
      // reads "(interactive session)" instead of pages of screen painting.
      if (alt) setBlocks((prev) => markOpenBlockInteractive(prev));
    });

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
      // A hidden tab's container measures near zero. Fitting then would
      // shrink the PTY to a sliver and every program would hard-wrap its
      // output at that width — and the wrapping is baked into the stream,
      // so it survives the tab becoming visible again. Only fit real
      // geometry; the observer fires again when the tab returns.
      if (host.clientWidth < 200 || host.clientHeight < 80) return;
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
      sbBuffer.dispose();
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
    <div className="flex h-full w-full overflow-hidden bg-white">
      {/* Left: the terminal column (chrome bar + raw/blocks content). */}
      <div className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden">
        {/* Raw / Blocks toggle — floats over the top-right corner of the
            terminal, no chrome strip behind it. */}
        {/* Hidden while a full-screen program is running: switching modes
            mid-vim would be meaningless, and the toggle would overlap it. */}
        {!altScreen && (
          <div className="absolute right-4 top-2.5 z-20">
            <OutputModeToggle mode={mode} onChange={switchMode} />
          </div>
        )}

        {/* The outer box owns the padding + width cap; the INNER box is the
            xterm mount and carries NO padding, so FitAddon measures a clean
            box and fits the rows exactly — no clipped/unreachable last line.
            In Blocks mode the xterm box stays mounted at full size (it keeps
            consuming the PTY stream, and hiding via opacity rather than
            display:none keeps FitAddon's geometry valid) with BlocksView
            layered over it.
            That always-mounted terminal is what lets Blocks host interactive
            programs: when one takes the alternate screen, we simply stop
            hiding the terminal instead of asking the user to switch modes. */}
        <div className="relative min-h-0 w-full flex-1">
          <div
            aria-hidden={showBlocks}
            className={`h-full w-full max-w-[1200px] overflow-hidden px-6 pb-6 pt-3 transition-opacity duration-200 ${
              showBlocks ? 'pointer-events-none opacity-0' : 'opacity-100'
            }`}
          >
            <div
              ref={hostRef}
              onMouseDown={() => termRef.current?.focus()}
              className="h-full w-full overflow-hidden"
            />
          </div>
          {showBlocks && (
            <BlocksView
              terminalId={id}
              blocks={blocks}
              cwd={cwd}
              onStopped={(stopped) =>
                setBlocks((prev) => markOpenBlockStopped(prev, stopped))
              }
              surfaceMount={surfaceMount}
              surfaceFocus={surfaceFocus}
            />
          )}
        </div>

        {/* Custom premium scrollbar — floats at the column's right edge (not
            the text-column edge) and mirrors the terminal's scroll. Raw mode
            only; BlocksView scrolls natively. */}
        {sb.visible && !showBlocks && (
          <div
            ref={scrollbarTrackRef}
            className="absolute right-1.5 top-3 bottom-3 z-[7] w-1.5"
          >
            <div
              onMouseDown={onScrollbarThumbDown}
              className="absolute left-0 w-full cursor-pointer rounded-full bg-black/15 transition-colors hover:bg-black/30"
              style={{ top: `${sb.topPct}%`, height: `${sb.heightPct}%` }}
            />
          </div>
        )}
      </div>

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
      className="flex select-none items-center gap-0.5 rounded-full border border-black/[0.08] p-0.5 text-[10.5px] font-medium"
      style={{ background: SHEEN_BG, boxShadow: SHEEN_SHADOW }}
    >
      {pill('raw', 'Raw')}
      {pill('blocks', 'Blocks')}
    </div>
  );
}

function getCommandSuggestions(command: string): string[] {
  const cmd = command.trim().toLowerCase().replace(/^['"]+|['"]+$/g, '');
  if (/^npm (install|i)(\s|$)/.test(cmd) || cmd === 'npm install' || cmd === 'npm i')
    return ['npm start', 'npm run build', 'npm test'];
  if (/^npm start/.test(cmd)) return ['npm run build', 'npm test'];
  if (/^git add/.test(cmd)) return ['git commit -m ""', 'git status', 'git diff --staged'];
  if (/^git commit/.test(cmd)) return ['git push', 'git log --oneline -5'];
  if (/^git status/.test(cmd)) return ['git add .', 'git diff', 'git log --oneline -5'];
  if (/^git clone/.test(cmd)) return ['ls', 'npm install'];
  if (/^git pull/.test(cmd)) return ['git log --oneline -5', 'git status'];
  if (/^cd /.test(cmd)) return ['ls', 'dir', 'code .'];
  if (/^(ls|dir)/.test(cmd)) return ['cd', 'code .'];
  if (/^python/.test(cmd)) return ['pip install -r requirements.txt', 'python -m pytest'];
  if (/^pip install/.test(cmd)) return ['python -m pytest', 'pip list'];
  if (/^docker build/.test(cmd)) return ['docker run', 'docker ps'];
  if (/^docker run/.test(cmd)) return ['docker ps', 'docker logs'];
  return [];
}

// Signatures of a failed command, used ONLY when the shell gave us no exit
// code. Deliberately broad: missing a failure is worse than a false positive,
// because a wrongly-green block tells the user everything is fine when we
// genuinely don't know.
const ERROR_RE =
  /\b(error|failed|failure|not recognized|not found|no such file|exception|cannot|can't|unable to|denied|refused|fatal|traceback|bad option|unknown option|invalid|unexpected|missing|abort(ed)?|panic)\b|^usage:/i;

// Plain-English summary of what a command did and how it turned out. No AI
// call — this is a fast local read of the command + its output, which is why
// the panel never claims a token cost for a plain shell command.
//
// Success/failure comes from the shell's real exit code (OSC 133) whenever we
// have one. When the shell didn't report a code, we do NOT assume success —
// unknown is not the same as fine — so we fall back to scanning the output for
// an error signature, which is the old heuristic used only as a safety net.
function summarizeBlock(block: TerminalBlockData): {
  headline: string;
  status: 'ok' | 'error' | 'stopped' | 'partial';
} {
  const cmd = block.command.trim();
  const word = cmd.split(/\s+/)[0]?.replace(/^['"]+|['"]+$/g, '') ?? cmd;

  // A deliberate stop is its own outcome. Judging it by exit code would
  // brand every stopped command a failure (force-kills exit non-zero), and
  // calling it success would be just as wrong.
  if (block.stopped) {
    const name = word || 'The command';
    if (block.stopped.reason === 'replaced') {
      const next = (block.stopped.next ?? '').split(/\s+/)[0] || 'the next command';
      const state = block.stopped.waiting
        ? `${name} was waiting for your input`
        : `${name} was still running`;
      return {
        headline: `${state}, so Verlox stopped it to run ${next}. Nothing failed.`,
        status: 'stopped',
      };
    }
    return {
      headline: `You stopped ${name}. Nothing failed.`,
      status: 'stopped',
    };
  }

  // Verlox's own safe-delete prints structured reports, so deletes can be
  // summarized by counting real outcomes instead of pattern-guessing. This
  // runs before the generic error scan because a delete that half-worked
  // ("moved b.txt, '/P' wasn't found") is a partial outcome, not a plain
  // error — calling it error hides that a file actually moved.
  const moved = block.lines.filter((l) =>
    /Verlox: moved '.+' to the Recycle Bin/.test(l),
  ).length;
  const missing = block.lines
    .map((l) => /Verlox: '(.+?)' was not found\. Nothing deleted\./.exec(l))
    .filter((m): m is RegExpExecArray => m !== null);
  const kept = block.lines.filter((l) =>
    /Verlox: couldn't safely delete/.test(l),
  ).length;
  if (moved > 0 || missing.length > 0 || kept > 0) {
    const movedText =
      moved === 1
        ? 'Moved 1 item to the Recycle Bin (recoverable)'
        : `Moved ${moved} items to the Recycle Bin (recoverable)`;
    const missingText =
      missing.length === 1
        ? `'${missing[0][1]}' wasn't found`
        : `${missing.length} paths weren't found`;
    const keptText =
      kept === 1 ? '1 item couldn’t be moved and stayed put' : `${kept} items stayed put`;
    const problems = [
      ...(missing.length > 0 ? [missingText] : []),
      ...(kept > 0 ? [keptText] : []),
    ].join('; ');
    if (moved > 0 && problems) {
      return { headline: `${movedText}. Also: ${problems}.`, status: 'partial' };
    }
    if (moved > 0) {
      return {
        headline: `${movedText}. Restore ${moved === 1 ? 'it' : 'them'} from the Recycle Bin if you change your mind.`,
        status: 'ok',
      };
    }
    return { headline: `Nothing was deleted: ${problems}.`, status: 'error' };
  }

  const errLineFound = block.lines.find((l) => ERROR_RE.test(l)) ?? '';
  const failed =
    block.exitCode !== null ? block.exitCode !== 0 : errLineFound !== '';
  if (failed) {
    // A spinner frame can end up glued to the front of the line the error
    // scan picked ("-npm error code E404"); the headline drops it.
    const errLine = errLineFound.replace(/^[\s\\|/-]+(?=\w)/, '');
    if (/not recognized/i.test(errLine))
      return { headline: `“${word}” isn’t a recognized command. Check the spelling.`, status: 'error' };
    if (/not found|no such file/i.test(errLine))
      return { headline: 'A file or path in the command could not be found.', status: 'error' };
    if (/denied|permission/i.test(errLine))
      return { headline: 'Permission was denied. The command needs higher access.', status: 'error' };
    if (/^usage:/i.test(errLine.trim()))
      return {
        headline: `“${word}” needs arguments to do anything. Its usage guide is in the output above.`,
        status: 'error',
      };
    if (errLine.trim())
      return { headline: `Command failed: ${errLine.trim().slice(0, 80)}`, status: 'error' };
    return { headline: `Command failed with exit code ${block.exitCode}.`, status: 'error' };
  }
  const lc = cmd.toLowerCase();
  if (/^(ls|dir|gci|get-childitem)/.test(lc))
    return { headline: `Listed ${block.lines.length} line${block.lines.length === 1 ? '' : 's'} of directory contents.`, status: 'ok' };
  if (/^cd /.test(lc)) return { headline: 'Changed the working directory.', status: 'ok' };
  if (/^git commit/.test(lc)) return { headline: 'Committed staged changes.', status: 'ok' };
  if (/^git push/.test(lc)) return { headline: 'Pushed commits to the remote.', status: 'ok' };
  if (/^git status/.test(lc)) return { headline: 'Reported the working-tree status.', status: 'ok' };
  if (/^npm (install|i)/.test(lc)) return { headline: 'Installed npm dependencies.', status: 'ok' };
  if (/^(npm run|npm start)/.test(lc)) return { headline: 'Ran an npm script.', status: 'ok' };
  const out = block.lines.length;
  if (out === 0) return { headline: 'Completed with no output.', status: 'ok' };
  return { headline: `Completed and produced ${out} line${out === 1 ? '' : 's'} of output.`, status: 'ok' };
}

// One shiny tone for the whole insight surface: a cool platinum gradient with
// an inset top highlight so it reads as glass, not flat grey. The gradient
// ends deep enough — and the card shadow lifts enough — that the surface
// separates clearly from the app's white background.
const SHEEN_BG = 'linear-gradient(180deg, #fafbfe 0%, #eff2f8 55%, #e8ecf4 100%)';
const SHEEN_SHADOW = 'inset 0 1px 0 rgba(255,255,255,0.9), 0 1px 2px rgba(16,24,40,0.05)';
// Elevation for whole cards (blocks, command bar): visible hairline + a soft
// two-layer drop so the card floats off the white instead of dissolving in.
const CARD_SHADOW =
  'inset 0 1px 0 rgba(255,255,255,0.9), 0 1px 3px rgba(16,24,40,0.07), 0 6px 16px rgba(16,24,40,0.06)';

function readBrain(): {
  label: string;
  provider: string;
  engine: string;
  model: string;
  providerId: string;
} {
  try {
    return {
      label: localStorage.getItem('verlox-brain-label') || 'AI',
      provider: localStorage.getItem('verlox-brain-provider') || 'anthropic',
      engine: localStorage.getItem('verlox-brain-engine') || 'verlox',
      model: localStorage.getItem('verlox-brain-model') || 'sonnet',
      providerId: localStorage.getItem('verlox-brain-provider-id') || '',
    };
  } catch {
    return { label: 'AI', provider: 'anthropic', engine: 'verlox', model: 'sonnet', providerId: '' };
  }
}

// `aiUsed` is false for plain shell commands (the user typed straight into the
// PTY, no model in the loop) — no token line, no model badge. When the AI ran
// the step, pass aiUsed + tokens and the model icon + token count appear.
function BlockInsights({
  block,
  onSendCommand,
  aiUsed = false,
  tokens = 0,
}: {
  block: TerminalBlockData;
  onSendCommand: (cmd: string) => void;
  aiUsed?: boolean;
  tokens?: number;
}) {
  const [open, setOpen] = useState(false);
  // In-block AI explanation ("Explain" chip). Generated on demand with the
  // same brain the chat panel uses; rendered right here in the block, with
  // the model that wrote it credited underneath.
  const [explain, setExplain] = useState<{
    state: 'loading' | 'done' | 'error';
    text: string;
    brainLabel: string;
    brainProvider: string;
  } | null>(null);
  const runExplain = async (fix = false) => {
    if (explain?.state === 'loading') return;
    const brain = readBrain();
    setExplain({ state: 'loading', text: '', brainLabel: brain.label, brainProvider: brain.provider });
    try {
      const env = await window.api.getEnvironment();
      const res = await window.api.agentPlanStep({
        goal:
          (fix
            ? `This terminal command failed. Explain in plain English what went wrong and give the corrected command to run. Reply with the explanation and the fix only; do not run anything.\n\n`
            : `Explain in plain English what this terminal command did, based on its output. ` +
              `Reply with the explanation only. Do NOT propose, suggest, or run any commands.\n\n`) +
          `Command: ${block.command}\nOutput:\n${block.lines.slice(-60).join('\n').slice(-2500)}`,
        priorSteps: [],
        cwd: env.homeDir,
        platform: env.platform,
        shell: env.shell,
        engine: brain.engine as never,
        model: brain.model,
        providerId: brain.providerId || undefined,
      });
      if (res.ok) {
        setExplain({
          state: 'done',
          text: res.step.message || 'No explanation came back. Try again.',
          brainLabel: brain.label,
          brainProvider: brain.provider,
        });
      } else {
        setExplain({ state: 'error', text: res.error, brainLabel: brain.label, brainProvider: brain.provider });
      }
    } catch {
      setExplain({
        state: 'error',
        text: 'The explanation could not be generated. Try again.',
        brainLabel: brain.label,
        brainProvider: brain.provider,
      });
    }
  };
  // Real Recovery Vault entries captured while this block ran. Checked once
  // on expand (not per render) — the panel only appears when something is
  // genuinely restorable, never as a vague "may be recoverable".
  const [vaultHits, setVaultHits] = useState<VaultEntry[]>([]);
  const vaultCheckedRef = useRef(false);
  useEffect(() => {
    if (!open || vaultCheckedRef.current || block.endedAt === null) return;
    vaultCheckedRef.current = true;
    void window.api
      .vaultList()
      .then((entries) => {
        const ended = block.endedAt ?? Date.now();
        setVaultHits(
          entries.filter(
            (e) => e.capturedAt >= block.startedAt - 2000 && e.capturedAt <= ended + 2000,
          ),
        );
      })
      .catch(() => {});
  }, [open, block.startedAt, block.endedAt]);

  if (block.endedAt === null) return null;

  const { headline, status } = summarizeBlock(block);
  const ok = status !== 'error';
  const durationMs = Math.max(0, block.endedAt - block.startedAt);
  const durationText = durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`;
  const suggestions = getCommandSuggestions(block.command).slice(0, 3);
  const brain = aiUsed ? readBrain() : null;
  const brainPng = brain ? BRAIN_PROVIDER_PNGS[brain.provider] : undefined;

  return (
    <div className="border-t border-black/[0.04]">
      {/* The disclosure has to read as one thing: the caret sits WITH the
          label (not stranded in the far corner), and while collapsed the
          summary itself previews inline — seeing the sentence start is what
          tells you there's more to open, far better than any glyph. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? 'Hide details' : headline}
        className="group/ins flex w-full items-center gap-1.5 px-3 py-1.5 text-left transition-colors hover:bg-black/[0.025]"
      >
        <span
          className="shrink-0 text-[8px] text-ink-micro transition-transform duration-200 group-hover/ins:text-ink-label"
          style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}
          aria-hidden="true"
        >
          ▶
        </span>
        <span className="shrink-0 text-[10px] text-ink-label" aria-hidden="true">✦</span>
        <span className="shrink-0 text-[11px] font-medium text-ink-label">
          What happened
        </span>
        <span
          className={`shrink-0 text-[10px] ${
            status === 'ok'
              ? 'text-[#3E7A53]'
              : status === 'stopped'
                ? 'text-[#2E5FA3]'
                : status === 'partial'
                  ? 'text-amber-600'
                  : 'text-[#B4322B]'
          }`}
        >
          {status === 'ok'
            ? '● success'
            : status === 'stopped'
              ? '● stopped'
              : status === 'partial'
                ? '● partial'
                : '● error'}
        </span>
        <span className="shrink-0 text-[10px] text-ink-micro">{durationText}</span>
        {!open && (
          <span className="min-w-0 flex-1 truncate text-[11px] text-ink-hint">
            {headline}
          </span>
        )}
        <span className="ml-auto shrink-0 pl-2 text-[10px] text-ink-micro opacity-0 transition-opacity group-hover/ins:opacity-100">
          {open ? 'Hide' : 'Details'}
        </span>
      </button>
      <div
        className="overflow-hidden transition-all duration-300 ease-out"
        style={{ maxHeight: open ? (explain ? '680px' : '300px') : '0px' }}
      >
        <div className="px-3 pb-3 pt-1">
          {/* Summary line */}
          <p className="mb-2.5 text-[12px] leading-snug text-[#3A3A3A]">{headline}</p>

          {/* Recovery Vault — only when something from this block is actually
              held in the vault and restorable. */}
          {vaultHits.length > 0 && (
            <div
              className="mb-2.5 rounded-lg border border-white/60 px-2.5 py-2"
              style={{ background: 'rgba(255,255,255,0.55)', boxShadow: SHEEN_SHADOW }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-ink-label">
                  {vaultHits.length === 1
                    ? `${vaultHits[0].name} is in the Recovery Vault.`
                    : `${vaultHits.length} items from this command are in the Recovery Vault.`}
                </span>
                <button
                  type="button"
                  onClick={() => window.dispatchEvent(new Event('verlox:open-vault'))}
                  className="shrink-0 rounded-md border border-hairline bg-white px-2 py-0.5 text-[10.5px] font-medium text-ink-label transition-colors hover:border-ink/20 hover:text-ink"
                >
                  Restore
                </button>
              </div>
            </div>
          )}

          {/* Actions: try again + suggested next commands, one shiny chip style. */}
          <div className="flex flex-wrap gap-1">
            <button
              type="button"
              onClick={() => onSendCommand(block.command)}
              className="rounded-lg border border-white/70 px-2 py-1 font-mono text-[10.5px] font-medium text-ink transition-all hover:brightness-[0.97]"
              style={{ background: 'rgba(255,255,255,0.7)', boxShadow: SHEEN_SHADOW }}
            >
              ↻ Try again
            </button>
            {/* Both answer inline, right in the block: Explain on success,
                a what-went-wrong + corrected-command answer on failure. */}
            {ok ? (
              <button
                type="button"
                onClick={() => void runExplain()}
                disabled={explain?.state === 'loading'}
                className="rounded-lg border border-white/70 px-2 py-1 text-[10.5px] font-medium text-ink-label transition-all hover:brightness-[0.97] hover:text-ink disabled:opacity-60"
                style={{ background: 'rgba(255,255,255,0.7)', boxShadow: SHEEN_SHADOW }}
              >
                {explain?.state === 'loading' ? '✦ Explaining' : '✦ Explain'}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void runExplain(true)}
                disabled={explain?.state === 'loading'}
                className="rounded-lg border border-white/70 px-2 py-1 text-[10.5px] font-medium text-[#B4322B] transition-all hover:brightness-[0.97] disabled:opacity-60"
                style={{ background: 'rgba(255,255,255,0.7)', boxShadow: SHEEN_SHADOW }}
              >
                {explain?.state === 'loading' ? '✦ Working' : '✦ Fix this'}
              </button>
            )}
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => onSendCommand(s)}
                className="rounded-lg border border-white/70 px-2 py-1 font-mono text-[10.5px] text-ink-label transition-all hover:brightness-[0.97] hover:text-ink"
                style={{ background: 'rgba(255,255,255,0.7)', boxShadow: SHEEN_SHADOW }}
              >
                {s}
              </button>
            ))}
          </div>

          {/* In-block AI explanation, with the model that wrote it credited. */}
          {explain && (
            <div
              className="mt-2.5 rounded-lg border border-white/60 px-2.5 py-2"
              style={{ background: 'rgba(255,255,255,0.55)', boxShadow: SHEEN_SHADOW }}
            >
              {explain.state === 'loading' ? (
                <p className="text-[11.5px] text-ink-hint">Reading the output.</p>
              ) : (
                <>
                  <p
                    className={`whitespace-pre-wrap text-[12px] leading-relaxed ${
                      explain.state === 'error' ? 'text-[#B4322B]' : 'text-[#3A3A3A]'
                    }`}
                  >
                    {explain.text}
                  </p>
                  {explain.state === 'done' && (
                    <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-ink-micro">
                      {BRAIN_PROVIDER_PNGS[explain.brainProvider] ? (
                        <img
                          src={BRAIN_PROVIDER_PNGS[explain.brainProvider]}
                          alt=""
                          aria-hidden="true"
                          className="h-3 w-3 object-contain opacity-80"
                        />
                      ) : null}
                      <span>{explain.brainLabel}</span>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Footer: model icon + tokens only when the AI ran this step. */}
          {aiUsed && brain && (
            <div className="mt-2 flex items-center gap-1.5 text-[10px] text-ink-micro">
              {brainPng ? (
                <img src={brainPng} alt="" aria-hidden="true" className="h-3.5 w-3.5 object-contain opacity-80" />
              ) : null}
              <span>{brain.label}</span>
              <span>· {tokens} tokens</span>
            </div>
          )}
        </div>
      </div>
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
  cwd,
  onStopped,
  surfaceMount,
  surfaceFocus,
}: {
  terminalId: string;
  blocks: TerminalBlockData[];
  // Absolute path the shell is in, or '' before the first prompt is read.
  cwd: string;
  // Records WHY the open block is being ended (Stop button / replaced by a
  // new command) so its summary can say so instead of guessing.
  onStopped: (stopped: NonNullable<TerminalBlockData['stopped']>) => void;
  // The live terminal surface for the running card: a STABLE ref callback
  // that reparents the shared grid element in/out, and a click-to-focus so
  // keystrokes go to the program.
  surfaceMount: (node: HTMLDivElement | null) => void;
  surfaceFocus: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState('');
  // Home directory, for collapsing the cwd chip to `~`. Fetched once.
  const [home, setHome] = useState('');
  useEffect(() => {
    void window.api
      .getEnvironment()
      .then((env) => setHome(env.homeDir))
      .catch(() => {});
  }, []);
  const label = shortenPath(cwd, home);
  // Folder browser for the command bar: picking a folder cd's the shell
  // there, picking a file cd's to its parent. Saves typing long paths.
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerWrapRef = useRef<HTMLDivElement | null>(null);

  // A running block going quiet is a state change with no event behind it,
  // so a slow tick re-renders to let "running" become "waiting for input".
  // Only ticks while something is actually running.
  const anyRunning = blocks.some((b) => b.endedAt === null);
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => setTick(Date.now()), 500);
    return () => clearInterval(t);
  }, [anyRunning]);

  // A NEW command card always scrolls fully into view — submitting a
  // command and then having to hunt for its card defeats the point.
  const lastBlockId = blocks.length > 0 ? blocks[blocks.length - 1].id : null;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !lastBlockId) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [lastBlockId]);

  // Stick to the bottom while output streams in, unless the user has
  // scrolled up to read something (then leave them alone). Runs on the
  // waiting tick too, because the live surface grows its height outside
  // React and block state alone doesn't see it.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [blocks, tick]);

  // Close the picker on an outside click or Escape.
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      if (pickerWrapRef.current && !pickerWrapRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setPickerOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [pickerOpen]);

  // Send a real `cd` through the shell rather than tracking cwd ourselves —
  // the shell stays the single source of truth for where the terminal is.
  const goToFolder = (selection: PathSelection) => {
    const target = selection.isDirectory ? selection.path : selection.dir;
    setPickerOpen(false);
    window.api.ptyInput({ id: terminalId, data: `cd "${target}"\r` });
  };

  // A command submitted while another is still running: main stops the old
  // one and runs the new one once it's actually gone (ptyRunCommand). The
  // sequencing lives in the main process on purpose — gating it on block
  // state here once deadlocked on a block that was stuck open. `pending` is
  // only a short-lived hint plus a debounce against Enter-mashing while the
  // handoff (~1s) is in flight.
  const [pending, setPending] = useState<{ cmd: string; at: number } | null>(null);

  const send = (e: FormEvent) => {
    e.preventDefault();
    const cmd = draft.trim();
    if (!cmd) return;
    historyAppend(cmd);
    historyRef.current = historyLoad();
    histPosRef.current = null;
    setCompletion(null);
    const last = blocks[blocks.length - 1];
    if (last && last.endedAt === null) {
      // Covers the worst-case handoff: kill sweep + shell respawn + resend.
      if (pending && Date.now() - pending.at < 4500) return;
      window.api.ptyRunCommand({ id: terminalId, command: cmd, cwd: cwd || undefined });
      onStopped({
        reason: 'replaced',
        next: cmd,
        waiting: Date.now() - last.lastOutputAt > WAITING_AFTER_MS,
      });
      setPending({ cmd, at: Date.now() });
    } else {
      window.api.ptyInput({ id: terminalId, data: `${cmd}\r` });
    }
    setDraft('');
  };

  // --- Bar keyboard memory: history (Up/Down) and Tab completion ----------
  const barRef = useRef<HTMLInputElement | null>(null);
  const historyRef = useRef<string[]>(historyLoad());
  // Where Up/Down is in history, and the in-progress draft stashed when
  // the user first pressed Up so Down past the newest entry restores it.
  const histPosRef = useRef<number | null>(null);
  const histStashRef = useRef('');
  const [completion, setCompletion] = useState<{
    original: string;
    span: TokenSpan;
    dirPart: string;
    // Path candidates get quoted when they contain spaces; command-line
    // candidates are whole commands and never are.
    kind: 'command' | 'path';
    candidates: string[];
    index: number;
  } | null>(null);
  const completionSeq = useRef(0);

  const placeCaret = (at: number) => {
    requestAnimationFrame(() => barRef.current?.setSelectionRange(at, at));
  };

  const applyCompletion = (
    c: NonNullable<typeof completion>,
    index: number,
  ) => {
    const { next, caret } = applyCandidate(
      c.original,
      c.span,
      c.dirPart,
      c.candidates[index],
      c.kind === 'path',
    );
    setDraft(next);
    placeCaret(caret);
    setCompletion(c.candidates.length > 1 ? { ...c, index } : null);
  };

  // Compute and apply completion for `value` at `caret`. Shared by the Tab
  // key and the quick buttons beside the bar.
  const beginTabCompletion = (value: string, caret: number) => {
    const span = currentToken(value, caret);
    // An empty token is meaningful AFTER a command ("cd " Tab = list the
    // folders, "git checkout " Tab = list the branches). Only a fully
    // empty bar has nothing to complete.
    if (!span.text && value.slice(0, span.start).trim() === '') return;
    const start = (
      candidates: string[],
      dirPart: string,
      kind: 'command' | 'path',
    ) => {
      if (candidates.length === 0) return;
      applyCompletion(
        { original: value, span, dirPart, kind, candidates, index: 0 },
        0,
      );
    };
    const before = value.slice(0, span.start).trim();
    const words = before.split(/\s+/).filter(Boolean).map((w) => w.toLowerCase());
    const isFirst = words.length === 0;
    const plan = planCompletion(span.text, isFirst);

    // Context-aware sources: the token's MEANING beats its shape. A bare
    // token after `git checkout` is a branch, after `npm run` a script —
    // things only the machine knows, fetched from main.
    const bare = span.text.startsWith('"') ? span.text.slice(1) : span.text;
    const plainToken = !/[\\/~:]/.test(bare);
    const contextKind: 'git-branches' | 'npm-scripts' | null =
      !plainToken || words.length !== 2
        ? null
        : words[0] === 'git' &&
            ['checkout', 'switch', 'merge', 'rebase', 'branch', 'log', 'diff', 'push', 'pull'].includes(words[1])
          ? 'git-branches'
          : words[0] === 'npm' && words[1] === 'run'
            ? 'npm-scripts'
            : null;
    if (contextKind) {
      const seq = ++completionSeq.current;
      void window.api
        .completionContext({ kind: contextKind, cwd: cwd || home || '' })
        .then((list) => {
          if (seq !== completionSeq.current) return;
          const p = bare.toLowerCase();
          start(
            list.filter((c) => c.toLowerCase().startsWith(p)).slice(0, 24),
            '',
            'command',
          );
        });
      return;
    }

    if (plan.kind === 'command') {
      start(commandCandidates(plan.prefix, historyRef.current), plan.dirPart, 'command');
      return;
    }
    // Path tokens hit the filesystem; a newer keystroke or Tab makes an
    // in-flight listing stale. After `cd`, only folders make sense.
    const seq = ++completionSeq.current;
    const dp = plan.dirPart;
    const base = /^[A-Za-z]:[\\/]/.test(dp)
      ? dp
      : dp.startsWith('~')
        ? (home || '') + dp.slice(1)
        : `${cwd || home || '.'}\\${dp}`;
    const dirsOnly = words[0] === 'cd' || words[0] === 'pushd';
    void window.api.listDir(base).then((res) => {
      if (seq !== completionSeq.current || res.error) return;
      start(pathCandidates(plan.prefix, res.entries, dirsOnly), dp, 'path');
    });
  };

  // Ctrl+R's engine, shared with the `recent` quick button: the current
  // draft is the query, matches open in the panel.
  const openHistorySearch = () => {
    const matches = historySearch(draft, historyRef.current);
    if (matches.length === 0) return;
    applyCompletion(
      {
        original: draft,
        span: { start: 0, end: draft.length, text: draft },
        dirPart: '',
        kind: 'command',
        candidates: matches,
        index: 0,
      },
      0,
    );
  };

  // The quick buttons: same act as typing the text and pressing Tab, for
  // users who'd rather click than learn the key. They toggle — pressing
  // again while the panel is open closes it.
  const quickComplete = (insert: string) => {
    if (completion) {
      setCompletion(null);
      return;
    }
    barRef.current?.focus();
    if (insert === '') {
      openHistorySearch();
      return;
    }
    setDraft(insert);
    beginTabCompletion(insert, insert.length);
  };

  // What each button types-and-Tabs. A trailing space completes the EMPTY
  // token after the word: folders for cd, package.json scripts for npm run.
  const QUICK_BUTTONS: { label: string; insert: string }[] = [
    { label: 'git', insert: 'git' },
    { label: 'cd', insert: 'cd ' },
    { label: 'npm run', insert: 'npm run ' },
    { label: 'recent', insert: '' },
  ];

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Ctrl+C with nothing typed stops the running command for real — the
    // same stop the button does. With a draft present, the browser keeps
    // its copy/clear behavior.
    if (e.ctrlKey && e.key === 'c' && draft === '') {
      const last = blocks[blocks.length - 1];
      if (last && last.endedAt === null) {
        e.preventDefault();
        onStopped({ reason: 'stop' });
        window.api.ptyStopForeground({ id: terminalId, cwd: cwd || undefined });
      }
      return;
    }

    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const hist = historyRef.current;
      if (hist.length === 0) return;
      e.preventDefault();
      setCompletion(null);
      let pos = histPosRef.current;
      if (e.key === 'ArrowUp') {
        if (pos === null) {
          histStashRef.current = draft;
          pos = hist.length - 1;
        } else if (pos > 0) pos--;
        histPosRef.current = pos;
        setDraft(hist[pos]);
        placeCaret(hist[pos].length);
      } else {
        if (pos === null) return;
        pos++;
        if (pos >= hist.length) {
          histPosRef.current = null;
          setDraft(histStashRef.current);
          placeCaret(histStashRef.current.length);
        } else {
          histPosRef.current = pos;
          setDraft(hist[pos]);
          placeCaret(hist[pos].length);
        }
      }
      return;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      if (completion) {
        const n = completion.candidates.length;
        const next = (completion.index + (e.shiftKey ? -1 : 1) + n) % n;
        applyCompletion(completion, next);
        return;
      }
      beginTabCompletion(draft, barRef.current?.selectionStart ?? draft.length);
      return;
    }

    // Ctrl+R: search history by substring — what's typed is the query,
    // matches open in the same panel, Ctrl+R (or Tab) cycles older ones.
    if (e.ctrlKey && (e.key === 'r' || e.key === 'R')) {
      e.preventDefault();
      if (completion) {
        const n = completion.candidates.length;
        applyCompletion(completion, (completion.index + 1) % n);
        return;
      }
      openHistorySearch();
      return;
    }

    if (e.key === 'Escape' && completion) {
      e.preventDefault();
      setDraft(completion.original);
      setCompletion(null);
    }
  };

  const running = blocks.length > 0 && blocks[blocks.length - 1].endedAt === null;
  // The running program's name, for the placeholder and the held-command
  // hint ("Stopping node, then running python").
  const runningName = running
    ? (blocks[blocks.length - 1].command.trim().split(/\s+/)[0] ?? '').slice(0, 24)
    : '';

  // The hint clears itself; main owns the actual handoff.
  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(() => setPending(null), 4500);
    return () => clearTimeout(t);
  }, [pending]);
  const fmtTime = (ms: number) =>
    new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="absolute inset-0 flex flex-col">
      <div
        ref={scrollRef}
        className={`min-h-0 w-full max-w-[1200px] flex-1 px-6 ${
          blocks.length === 0 ? 'overflow-hidden' : 'overflow-y-auto pt-3'
        }`}
      >
        {blocks.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center pb-16">
            {/* A quiet hero: glyph, one line, and starter commands so the
                empty board invites a first run instead of sitting blank. */}
            <div
              className="flex h-12 w-12 items-center justify-center rounded-2xl border border-black/[0.08]"
              style={{ background: SHEEN_BG, boxShadow: CARD_SHADOW }}
            >
              <span className="font-mono text-[18px] text-[#3E7A53]" aria-hidden="true">
                ❯
              </span>
            </div>
            <p className="mt-4 text-[13.5px] font-medium text-ink">
              Every command becomes a block.
            </p>
            <p className="mt-1 max-w-[340px] text-center text-[12px] leading-relaxed text-ink-hint">
              Output, a summary of what happened, and one-click next steps,
              all in one card.
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-1.5">
              {['ls', 'git status', 'node -v'].map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => window.api.ptyInput({ id: terminalId, data: `${c}\r` })}
                  className="rounded-lg border border-black/[0.08] px-2.5 py-1 font-mono text-[11px] text-ink-label transition-all hover:brightness-[0.98] hover:text-ink"
                  style={{ background: SHEEN_BG, boxShadow: SHEEN_SHADOW }}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="space-y-2.5 pb-3">
          {blocks.map((b) => {
            const isRunning = b.endedAt === null;
            // A running command that has gone quiet is waiting on the user,
            // not working. Saying which is the difference between "is this
            // stuck?" and "oh, it wants something from me".
            const isWaiting = isRunning && tick - b.lastOutputAt > WAITING_AFTER_MS;
            const replies = isWaiting ? suggestedReplies(b.lines, b.partial) : [];
            // Keystroke tables ([Y] Yes [A] Yes to All ...) are instructions
            // for typing letters. The buttons ARE the choices, so the table
            // never renders. Menus can arrive glued to real content (echoed
            // answers, reprints), so each line is stripped, not just hidden;
            // lines that were only menu disappear, genuine blanks stay.
            const cleaned: string[] = [];
            for (const l of b.lines) {
              const s = stripChoiceGuide(l);
              if (s !== '' || l.trim() === '') cleaned.push(s);
            }
            const output = cleaned.join('\n');
            const shownPartial = stripChoiceGuide(b.partial);
            return (
              <div
                key={b.id}
                className="group overflow-hidden rounded-xl border border-black/[0.08]"
                style={{ background: SHEEN_BG, boxShadow: CARD_SHADOW }}
              >
                <div className="flex items-center gap-2 border-b border-black/[0.04] px-3 py-1.5">
                  <span aria-hidden="true" className="font-mono text-[12px] text-[#3E7A53]">
                    ❯
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] font-medium text-[#3A3A3A]">
                    {b.command}
                  </span>
                  {isRunning ? (
                    <>
                      {isWaiting ? (
                        <span className="flex items-center gap-1 font-mono text-[10px] text-[#2E5FA3]">
                          <span className="h-1.5 w-1.5 rounded-full bg-[#2E5FA3]" aria-hidden="true" />
                          waiting for input
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 font-mono text-[10px] text-amber-600">
                          <span
                            className="h-1.5 w-1.5 animate-flicker rounded-full bg-amber-500"
                            aria-hidden="true"
                          />
                          running
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          onStopped({ reason: 'stop' });
                          window.api.ptyStopForeground({
                            id: terminalId,
                            cwd: cwd || undefined,
                          });
                        }}
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
                  <div className="max-h-96 overflow-y-auto px-3 py-2 font-mono text-[12px] leading-[1.55] text-[#3A3A3A]">
                    {/* Output, best source first: the LIVE grid while the
                        command runs (exact rendering, click to type), the
                        frozen colored snapshot once it's done, and the
                        plain-text pipeline as the fallback for blocks
                        that predate the surface or went interactive. */}
                    {isRunning && !b.interactive ? (
                      <div
                        onMouseDown={surfaceFocus}
                        className="cursor-text overflow-x-auto rounded-md"
                      >
                        <div ref={surfaceMount} className="overflow-hidden" />
                      </div>
                    ) : b.snapshotHtml && !isRunning ? (
                      <pre
                        className="overflow-x-auto whitespace-pre font-mono"
                        // Built by our own serializer from terminal cells,
                        // content HTML-escaped there.
                        dangerouslySetInnerHTML={{ __html: b.snapshotHtml }}
                      />
                    ) : (
                      <>
                        {b.truncated && (
                          <p className="text-ink-micro">… earlier output trimmed</p>
                        )}
                        {output ? (
                          <pre className="whitespace-pre-wrap break-words font-mono">{output}</pre>
                        ) : !isRunning ? (
                          <span className="text-ink-micro">(no output)</span>
                        ) : null}
                        {isRunning && shownPartial && (
                          <p className="whitespace-pre-wrap break-words text-ink-hint">{shownPartial}</p>
                        )}
                      </>
                    )}
                    {/* Talking to the running program happens INSIDE its
                        card: chips for replies it offered, and a free-form
                        input. The bottom bar always means "run a command". */}
                    {isWaiting && (
                      <div className="mt-2 flex flex-wrap items-center gap-1">
                        {replies.map((r) => (
                          <button
                            key={r.label}
                            type="button"
                            onClick={() =>
                              window.api.ptyInput({ id: terminalId, data: r.send })
                            }
                            className={`rounded-lg border px-2 py-1 text-[10.5px] transition-all hover:brightness-[0.97] ${
                              r.recommended
                                ? 'border-[#2E5FA3]/30 font-medium text-ink'
                                : 'border-white/70 text-ink-label hover:text-ink'
                            }`}
                            style={{ background: 'rgba(255,255,255,0.7)', boxShadow: SHEEN_SHADOW }}
                          >
                            {r.label}
                            {r.recommended && (
                              <span className="ml-1 text-[9px] font-normal text-[#2E5FA3]">
                                recommended
                              </span>
                            )}
                          </button>
                        ))}
                        <BlockReplyInput
                          programName={b.command.trim().split(/\s+/)[0] ?? ''}
                          onSend={(text) =>
                            window.api.ptyInput({ id: terminalId, data: `${text}\r` })
                          }
                          onSendRaw={(data) =>
                            window.api.ptyInput({ id: terminalId, data })
                          }
                        />
                      </div>
                    )}
                  </div>
                )}
                <BlockInsights
                  block={b}
                  onSendCommand={(cmd) => {
                    window.api.ptyInput({ id: terminalId, data: `${cmd}\r` });
                  }}
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* Command bar — types into the same shell the Raw view shows. The
          bottom margin keeps it above the floating chat panel. */}
      <form onSubmit={send} className="w-full max-w-[1200px] px-6 pb-4 pt-1">
        {pending && (
          <p className="px-3 pb-1 text-[11px] text-ink-hint">
            Stopping {runningName || 'the running command'}, then running{' '}
            <span className="font-mono">{pending.cmd}</span>
          </p>
        )}
        <div
          className="relative flex items-center gap-2 rounded-xl border border-black/[0.08] px-3 py-2"
          style={{ background: SHEEN_BG, boxShadow: CARD_SHADOW }}
        >
          {/* Tab-completion candidates: a frosted panel floating above the
              bar (no layout shift), easing in. Tab cycles, Esc restores,
              click picks. Only shown while there's a real choice. */}
          {completion && completion.candidates.length > 1 && (
            <div
              className="absolute bottom-full left-0 right-0 z-30 mb-2 animate-pane-in rounded-xl border border-black/[0.08] px-2.5 py-2"
              style={{
                background: 'rgba(255,255,255,0.72)',
                backdropFilter: 'blur(12px)',
                boxShadow: CARD_SHADOW,
              }}
            >
              <div className="flex flex-wrap items-center gap-1">
                {completion.candidates.map((c, i) => (
                  <button
                    key={c}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      applyCompletion(completion, i);
                    }}
                    className={`max-w-[340px] truncate rounded-md border px-2 py-1 font-mono text-[11px] transition-colors ${
                      i === completion.index
                        ? 'border-[#2E5FA3]/40 bg-white text-ink'
                        : 'border-transparent text-ink-label hover:bg-white/70 hover:text-ink'
                    }`}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>
          )}
          {/* Folder browser — jumps the shell to any folder without typing
              the path. Wrapper is relative so the picker floats above it. */}
          <div ref={pickerWrapRef} className="relative z-20 shrink-0">
            {pickerOpen && <PathPicker initialPath={cwd || null} onPick={goToFolder} />}
            <button
              type="button"
              onClick={() => setPickerOpen((o) => !o)}
              aria-label={cwd ? `Browse folders. Currently in ${cwd}` : 'Browse folders'}
              aria-expanded={pickerOpen}
              title={cwd || 'Browse folders'}
              className={`flex h-6 max-w-[200px] items-center gap-1.5 rounded-md px-1.5 font-mono text-[11.5px] transition-colors ${
                pickerOpen
                  ? 'bg-black/[0.06] text-ink'
                  : 'text-ink-label hover:bg-black/[0.05] hover:text-ink'
              }`}
            >
              <svg
                viewBox="0 0 18 18"
                className="h-4 w-4 shrink-0"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M2 4.5h5l1.7 2H16v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
              </svg>
              {label && <span className="truncate">{label}</span>}
            </button>
          </div>
          <span aria-hidden="true" className="font-mono text-[13px] text-[#3E7A53]">
            ❯
          </span>
          <input
            ref={barRef}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              // Typing invalidates completion cycling, history position,
              // and any in-flight directory listing.
              setCompletion(null);
              completionSeq.current++;
              histPosRef.current = null;
            }}
            onKeyDown={onKeyDown}
            placeholder={
              running
                ? `Run a command (stops ${runningName || 'the current one'} first). Reply to it inside its card.`
                : 'Run a command'
            }
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-[#3A3A3A] outline-none placeholder:text-ink-micro"
          />
          {/* One-click completion for the things everyone reaches for:
              each is identical to typing the text and pressing Tab (or
              Ctrl+R for `recent`). Always visible, and TOGGLES: pressing
              again while the panel is open closes it. */}
          {QUICK_BUTTONS.map((b) => (
            <button
              key={b.label}
              type="button"
              aria-pressed={!!completion}
              onMouseDown={(e) => {
                e.preventDefault();
                quickComplete(b.insert);
              }}
              title={
                completion
                  ? 'Close suggestions'
                  : b.insert === ''
                    ? 'Browse recent commands (Ctrl+R)'
                    : `Complete ${b.label}`
              }
              className={`shrink-0 rounded-md border px-1.5 py-0.5 font-mono text-[10.5px] transition-colors duration-200 ${
                completion
                  ? 'border-[#2E5FA3]/40 bg-white text-ink'
                  : 'border-hairline text-ink-hint hover:bg-white/70 hover:text-ink'
              }`}
            >
              {b.label}
            </button>
          ))}
        </div>
      </form>
    </div>
  );
}

// Free-form stdin for a waiting program, living inside its card so replying
// to node is visually distinct from running a shell command in the bottom
// bar. Sits alongside the reply chips.
//
// While EMPTY it also forwards arrow keys and bare Enter as raw bytes.
// That's the bridge into inquirer-style menus: the first arrow press makes
// the menu repaint, the repaint trips the in-place TUI detector, and the
// live terminal takes over with focus for the rest of the interaction.
const ARROW_BYTES: Record<string, string> = {
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
};

function BlockReplyInput({
  programName,
  onSend,
  onSendRaw,
}: {
  programName: string;
  onSend: (text: string) => void;
  onSendRaw: (data: string) => void;
}) {
  const [text, setText] = useState('');
  return (
    <input
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const t = text.trim();
          if (t) onSend(t);
          else onSendRaw('\r');
          setText('');
          return;
        }
        if (text === '' && ARROW_BYTES[e.key]) {
          e.preventDefault();
          onSendRaw(ARROW_BYTES[e.key]);
        }
      }}
      placeholder={programName ? `Reply to ${programName}` : 'Reply'}
      spellCheck={false}
      autoCapitalize="off"
      autoComplete="off"
      className="min-w-[140px] flex-1 rounded-lg border border-white/70 bg-white/50 px-2 py-1 font-mono text-[10.5px] text-ink outline-none placeholder:text-ink-micro focus:bg-white/80"
    />
  );
}
