import { useCallback, useEffect, useState } from 'react';
import { TerminalView } from './TerminalView';
import { SqlConsoleView } from './SqlConsoleView';
import { TabBar, type ConversationTab } from './TabBar';
import { Sidebar } from './Sidebar';
import { SettingsView } from './SettingsView';
import { VaultView, VaultGlyph } from './VaultView';
import { TimelineView, ClockGlyph } from './TimelineView';
import { installProcessListeners } from '../hooks/useRunningProcesses';

function makeTerminal(): ConversationTab {
  return { id: crypto.randomUUID(), title: 'Terminal', kind: 'terminal' };
}

function makeSql(): ConversationTab {
  return { id: crypto.randomUUID(), title: 'SQL', kind: 'sql' };
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
  // Sidebar collapse. Starts open; the title-bar toggle hides/shows it.
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // The Settings page (modal). Opened by the top-bar gear, or by anything that
  // fires the 'verlox:open-settings' event (e.g. the chat bar's "add provider").
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The Recovery Vault page (modal), opened by its top-bar button.
  const [vaultOpen, setVaultOpen] = useState(false);
  // The Timeline replay page (modal), opened by its top-bar button.
  const [timelineOpen, setTimelineOpen] = useState(false);
  useEffect(() => {
    const open = () => setSettingsOpen(true);
    window.addEventListener('verlox:open-settings', open);
    return () => window.removeEventListener('verlox:open-settings', open);
  }, []);

  const handleNew = useCallback(() => {
    const t = makeTerminal();
    setTabs((cs) => [...cs, t]);
    setActiveId(t.id);
  }, []);

  const handleNewSql = useCallback(() => {
    const t = makeSql();
    setTabs((cs) => [...cs, t]);
    setActiveId(t.id);
  }, []);

  // Rename a tab from its first command (only while still the default title).
  const renameTab = useCallback((tabId: string, command: string) => {
    const title = command.length > 22 ? `${command.slice(0, 21)}…` : command;
    setTabs((cs) =>
      cs.map((c) =>
        c.id === tabId && c.title === 'Terminal' ? { ...c, title } : c,
      ),
    );
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
    <div className="flex h-full w-full flex-col bg-canvas">
      {/* Custom title strip — replaces the hidden native title bar. It's the
          window's drag handle; the native min/max/close controls render at
          its right via titleBarOverlay (configured in the main process). The
          sidebar show/hide toggle sits at its left (no-drag). */}
      <div
        className="flex h-10 shrink-0 items-center pl-2"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <button
          type="button"
          onClick={() => setSidebarOpen((v) => !v)}
          aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
          title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-ink-label transition-colors hover:bg-surface-subtle hover:text-ink focus:outline-none"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <svg
            viewBox="0 0 16 16"
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="2.25" y="3.25" width="11.5" height="9.5" rx="2" />
            <line x1="6.5" y1="3.5" x2="6.5" y2="12.5" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          aria-label="Settings"
          title="Settings"
          className="ml-1 flex h-7 w-7 items-center justify-center rounded-lg text-ink-label transition-colors hover:bg-surface-subtle hover:text-ink focus:outline-none"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.5" />
            <path
              d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => setVaultOpen(true)}
          aria-label="Recovery Vault"
          title="Recovery Vault"
          className="flex h-7 w-7 items-center justify-center rounded-lg text-ink-label transition-colors hover:bg-surface-subtle hover:text-ink focus:outline-none"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <VaultGlyph className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => setTimelineOpen(true)}
          aria-label="Timeline"
          title="Timeline — everything Verlox has done"
          className="flex h-7 w-7 items-center justify-center rounded-lg text-ink-label transition-colors hover:bg-surface-subtle hover:text-ink focus:outline-none"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <ClockGlyph className="h-4 w-4" />
        </button>
      </div>
      {/* Body: collapsible sidebar (search, tabs, rewind, running) + the
          terminal board, both as rounded panels with even spacing. */}
      <div className="flex min-h-0 w-full flex-1 gap-3 px-3 pb-3 pt-2">
        {sidebarOpen && (
          <Sidebar
            tabs={tabs}
            activeId={activeId}
            onSelect={setActiveId}
            onClose={handleClose}
          />
        )}
        <div className="flex min-h-0 flex-1 flex-col">
          {/* The terminal board is fluid: it fills the space next to the
              sidebar with a comfortable margin, and only caps (and centers)
              on ultra-wide windows so line lengths stay sane. This avoids the
              fixed-island look that left a big dead gap beside the sidebar. */}
          <div className="mx-auto flex min-h-0 w-full max-w-[1500px] flex-1 flex-col pb-2">
            {/* Top tab strip — the original tab bar (tabs + new-terminal
                button), back at the top of the board area. */}
            <div className="flex items-center gap-3 pb-2">
              <div className="min-w-0 flex-1">
                <TabBar
                  tabs={tabs}
                  activeId={activeId}
                  onSelect={setActiveId}
                  onClose={handleClose}
                  onNew={handleNew}
                  onNewSql={handleNewSql}
                />
              </div>
            </div>
            {/* The centered terminal board. Every terminal stays mounted;
                inactive ones are display:none so background work survives a
                tab switch. */}
            <div className="min-h-0 flex-1 overflow-hidden rounded-2xl bg-card">
              {tabs.map((tab) => (
                <div
                  key={tab.id}
                  className={tab.id === activeId ? 'h-full' : 'hidden'}
                >
                  {tab.kind === 'sql' ? (
                    <SqlConsoleView id={tab.id} />
                  ) : (
                    <TerminalView
                      id={tab.id}
                      isActive={tab.id === activeId}
                      onFirstCommand={(cmd) => renameTab(tab.id, cmd)}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {settingsOpen && <SettingsView onClose={() => setSettingsOpen(false)} />}
      {vaultOpen && <VaultView onClose={() => setVaultOpen(false)} />}
      {timelineOpen && <TimelineView onClose={() => setTimelineOpen(false)} />}
    </div>
  );
}
