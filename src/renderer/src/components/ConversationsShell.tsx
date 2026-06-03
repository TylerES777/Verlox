import { useCallback, useEffect, useState } from 'react';
import { TerminalView } from './TerminalView';
import { TabBar, type ConversationTab } from './TabBar';
import { installProcessListeners } from '../hooks/useRunningProcesses';

function makeTerminal(): ConversationTab {
  return { id: crypto.randomUUID(), title: 'Terminal', kind: 'terminal' };
}

// Top-level authed screen. The terminal is now the single home: each tab is
// an interactive terminal with Verlox's agent panel floating over it (talk in
// plain English, approve steps, undo via restore points). The old separate
// conversation surface has been retired. Tabs stay mounted so a command in a
// background tab keeps running; only the active one is visible. Tabs do not
// persist across restarts — every launch starts with one fresh terminal.
export function ConversationsShell() {
  // Install the singleton IPC listeners that route command output / exit
  // into the live-processes registry. Once per app lifetime.
  useEffect(() => {
    installProcessListeners();
  }, []);

  const [tabs, setTabs] = useState<ConversationTab[]>(() => [makeTerminal()]);
  const [activeId, setActiveId] = useState<string>(() => tabs[0].id);

  const handleNew = useCallback(() => {
    const t = makeTerminal();
    setTabs((cs) => [...cs, t]);
    setActiveId(t.id);
  }, []);

  const handleClose = useCallback(
    (id: string) => {
      // Closing the last tab clears it rather than leaving an empty app:
      // swap in a fresh terminal (new id forces a clean remount).
      if (tabs.length === 1) {
        const fresh = makeTerminal();
        setTabs([fresh]);
        setActiveId(fresh.id);
        return;
      }
      const idx = tabs.findIndex((c) => c.id === id);
      const next = tabs.filter((c) => c.id !== id);
      setTabs(next);
      if (activeId === id) setActiveId(next[Math.max(0, idx - 1)].id);
    },
    [tabs, activeId],
  );

  return (
    <div className="flex h-full w-full flex-col">
      {/* Custom title strip — replaces the hidden native title bar. It's the
          window's drag handle; the native min/max/close controls render at
          its right via titleBarOverlay (configured in the main process). */}
      <div
        className="h-10 shrink-0 bg-card"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        aria-hidden="true"
      />
      <div className="flex min-h-0 w-full flex-1 flex-col px-4 pb-4">
        {/* Tab strip */}
        <div className="flex items-center gap-3 py-3">
          <div className="min-w-0 flex-1">
            <TabBar
              tabs={tabs}
              activeId={activeId}
              onSelect={setActiveId}
              onClose={handleClose}
              onNew={handleNew}
            />
          </div>
        </div>
        {/* Every terminal stays mounted; inactive ones are display:none so
            background work survives a tab switch. */}
        <div className="min-h-0 flex-1">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={tab.id === activeId ? 'h-full' : 'hidden'}
            >
              <TerminalView id={tab.id} isActive={tab.id === activeId} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
