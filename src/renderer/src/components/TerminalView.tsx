import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { SnapshotPanel } from './SnapshotPanel';
import { AgentPanel } from './AgentPanel';
import { registerTerminal, unregisterTerminal } from '../lib/terminalRegistry';

interface TerminalViewProps {
  // The owning tab's id. Doubles as the PTY session key, so input, output,
  // resize and teardown all route to the right shell when several
  // terminal tabs are open at once.
  id: string;
  // Whether this tab is the visible one. A hidden tab measures as 0×0, so
  // we defer the first fit (and re-fit on show) until it's actually on
  // screen — otherwise the PTY would be sized to nothing.
  isActive: boolean;
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
export function TerminalView({ id, isActive }: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // The restore-points panel, opened by the shield button. Lives over the
  // terminal surface so it never resizes the shell.
  const [snapshotsOpen, setSnapshotsOpen] = useState(false);
  // At-a-glance protection state for the shield: 'off' (no folder / no git),
  // 'manual' (folder protected, auto-save off), 'on' (protected + auto-save).
  const [protection, setProtection] = useState<'off' | 'manual' | 'on'>('off');
  // Becomes true once the PTY has been spawned, so a deferred first fit
  // (for a tab that mounts while hidden) knows whether to start it.
  const startedRef = useRef(false);

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
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      // A calm, light terminal that belongs to the white app surface
      // instead of dropping a black box into it.
      theme: {
        background: '#FBFBFA',
        foreground: '#3A3A3A',
        cursor: '#3A3A3A',
        selectionBackground: '#D8E6F2',
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

  // Keep the shield's appearance in sync with the real protection state.
  // Refetched on mount and whenever the panel opens or closes, so changing
  // the guarded folder or toggling auto-save updates the shield immediately.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const s = await window.api.snapshotStatus();
        if (cancelled) return;
        setProtection(
          !s.guardedFolder || !s.gitAvailable
            ? 'off'
            : s.autoEnabled
              ? 'on'
              : 'manual',
        );
      } catch {
        // Status is best-effort; leave the shield as-is on failure.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [snapshotsOpen]);

  const shieldStyle = {
    off: 'border-black/10 bg-white/90 text-[#6A6A6A] hover:bg-white hover:text-[#3A3A3A]',
    manual: 'border-[#3A3A3A]/25 bg-white text-[#3A3A3A] hover:bg-black/5',
    on: 'border-[#3E7A53]/30 bg-[#EAF3ED] text-[#3E7A53] hover:bg-[#E2EEE7]',
  }[protection];
  const shieldLabel = protection === 'on' ? 'Protected' : 'Restore points';
  const shieldTitle =
    protection === 'on'
      ? 'Protected — Verlox is saving this folder automatically. Click to see restore points.'
      : protection === 'manual'
        ? 'Protected — saving when you checkpoint. Click to see restore points.'
        : 'Restore points — pick a folder to protect so Verlox can rewind mistakes.';

  // Clicking anywhere in the pane focuses the terminal, so a click after
  // the terminal has lost focus (e.g. to DevTools or another tab) always
  // restores typing. mousedown (not click) so focus lands before the
  // browser's default selection handling runs.
  return (
    <div className="relative h-full w-full overflow-hidden">
      <div
        ref={hostRef}
        onMouseDown={() => termRef.current?.focus()}
        className="h-full w-full overflow-hidden"
      />

      {/* Restore-points toggle. The shield is the calm signal that Verlox
          has your back; it fills green once a folder is protected. Clicking
          it opens the timeline of restore points. */}
      <button
        onClick={() => setSnapshotsOpen((v) => !v)}
        className={`absolute right-2 top-2 z-10 flex items-center gap-1 rounded-lg border px-2 py-1 text-xs shadow-sm backdrop-blur ${shieldStyle}`}
        title={shieldTitle}
        aria-label={shieldLabel}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
            fill={protection === 'on' ? 'currentColor' : 'none'}
            fillOpacity={protection === 'on' ? 0.12 : 0}
          />
          {protection !== 'off' && (
            <path
              d="M8.7 12.1l2.2 2.2 4.4-4.6"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
        </svg>
        {shieldLabel}
      </button>

      {snapshotsOpen && <SnapshotPanel onClose={() => setSnapshotsOpen(false)} />}

      {/* The floating natural-language panel where you and Verlox talk and
          approve actions. It floats over the terminal and never resizes the
          shell. See AgentPanel.tsx. */}
      <AgentPanel terminalId={id} />
    </div>
  );
}
