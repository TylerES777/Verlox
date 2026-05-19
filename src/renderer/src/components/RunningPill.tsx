import { useEffect, useRef, useState } from 'react';

// One running command, aggregated across all conversations for the pill.
export interface RunningItem {
  conversationId: string;
  conversationTitle: string;
  // The command-runner step id — what window.api.stopCommand expects.
  stepId: string;
  command: string;
}

interface RunningPillProps {
  items: RunningItem[];
  // Jump to (activate) the conversation a command is running in.
  onJump: (conversationId: string) => void;
}

// Ephemeral indicator of commands running across ALL conversations.
// Renders nothing when nothing is running — no permanent chrome. Click
// opens a popover listing each running command: which conversation, the
// command, a live pulse, and stop / jump-to. Stopping goes straight to
// the main process by step id; the owning conversation reacts to the
// resulting exit event on its own.
export function RunningPill({ items, onJump }: RunningPillProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Nothing running — make sure a stale popover doesn't linger.
  useEffect(() => {
    if (items.length === 0) setOpen(false);
  }, [items.length]);

  // Close on outside-click / Escape while open.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (items.length === 0) return null;

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-full border-[0.5px] border-subtle-border bg-card px-2.5 py-1 text-[11px] text-ink-label transition-colors hover:text-ink focus:outline-none"
      >
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber" />
        {items.length} running
      </button>

      {open && (
        <div className="absolute right-0 top-full z-10 mt-2 w-[320px] overflow-hidden rounded-xl border-[0.5px] border-[rgba(0,0,0,0.08)] bg-card shadow-popover">
          <div className="border-b-[0.5px] border-hairline px-3 py-2 text-[11px] uppercase tracking-[0.06em] text-ink-micro">
            Running
          </div>
          <div className="max-h-[280px] overflow-y-auto py-1">
            {items.map((item) => (
              <div
                key={item.stepId}
                className="flex items-center gap-2 px-3 py-1.5 hover:bg-surface-subtle"
              >
                <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber" />
                {/* Tapping the row jumps to that conversation. */}
                <button
                  type="button"
                  onClick={() => {
                    onJump(item.conversationId);
                    setOpen(false);
                  }}
                  className="min-w-0 flex-1 text-left focus:outline-none"
                >
                  <div className="truncate text-[12px] text-ink-label">
                    {item.conversationTitle}
                  </div>
                  <div className="truncate font-mono text-[12px] text-ink">
                    {item.command}
                  </div>
                </button>
                {/* Stop goes straight to the main process by step id. */}
                <button
                  type="button"
                  onClick={() => window.api.stopCommand(item.stepId)}
                  className="shrink-0 text-[11px] text-ink-hint hover:text-ink focus:outline-none"
                >
                  stop
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
