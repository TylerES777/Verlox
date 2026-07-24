import { useCallback, useEffect, useState } from 'react';
import { TerminalView } from './TerminalView';
import { TabBar, type ConversationTab } from './TabBar';
import { Sidebar } from './Sidebar';
import { SettingsView } from './SettingsView';
import { VaultView } from './VaultView';
import { TimelineView } from './TimelineView';
import { installProcessListeners } from '../hooks/useRunningProcesses';

function makeTerminal(): ConversationTab {
  return { id: crypto.randomUUID(), title: 'Terminal', kind: 'terminal' };
}

// The surfaces the sidebar navigates between.
export type AppView = 'terminal' | 'settings' | 'vault' | 'timeline';

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
  // Which surface fills the main area. Settings / Vault / Timeline are real
  // pages navigated from the sidebar, not floating modals. Terminals stay
  // mounted (hidden) on other views so background commands keep running.
  const [view, setView] = useState<AppView>('terminal');
  useEffect(() => {
    const openSettings = () => setView('settings');
    const openVault = () => setView('vault');
    const selectTab = (e: Event) => {
      const id = (e as CustomEvent<{ id: string }>).detail?.id;
      if (!id) return;
      setActiveId(id);
      setView('terminal');
    };
    window.addEventListener('verlox:open-settings', openSettings);
    window.addEventListener('verlox:open-vault', openVault);
    window.addEventListener('verlox:select-tab', selectTab);
    return () => {
      window.removeEventListener('verlox:open-settings', openSettings);
      window.removeEventListener('verlox:open-vault', openVault);
      window.removeEventListener('verlox:select-tab', selectTab);
    };
  }, []);

  const handleNew = useCallback(() => {
    const t = makeTerminal();
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
    /* No separate title strip: the sidebar runs to the very top of the
       window, and the tab row doubles as the drag handle (the native
       min/max/close overlay renders over its right edge). */
    <div className="flex h-full w-full bg-white">
      {sidebarOpen && (
        <Sidebar
          activeView={view}
          onNavigate={setView}
          onToggleSidebar={() => setSidebarOpen(false)}
        />
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Tab strip — also the window drag region now that the title strip
            is gone. Interactive children opt out via no-drag. */}
        <div
          className="flex items-center gap-3 border-b border-hairline px-4 py-2 pr-[150px]"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          {!sidebarOpen && (
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              aria-label="Show sidebar"
              title="Show sidebar"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ink-label transition-colors hover:bg-surface-subtle hover:text-ink focus:outline-none"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            >
              <SidebarGlyph />
            </button>
          )}
          {view === 'terminal' ? (
            <div
              className="min-w-0 flex-1"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            >
              <TabBar
                tabs={tabs}
                activeId={activeId}
                onSelect={setActiveId}
                onClose={handleClose}
                onNew={handleNew}
              />
            </div>
          ) : (
            /* Pages own their titles; this stays a plain drag strip. */
            <span className="h-7 flex-1" />
          )}
        </div>
        {/* Main area. Terminals stay mounted (hidden) on every view so
            background tabs keep running; pages render instead when active. */}
        <div className="min-h-0 flex-1 overflow-hidden">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={view === 'terminal' && tab.id === activeId ? 'h-full' : 'hidden'}
            >
              <TerminalView
                id={tab.id}
                isActive={view === 'terminal' && tab.id === activeId}
                onFirstCommand={(cmd) => renameTab(tab.id, cmd)}
              />
            </div>
          ))}
          {view === 'settings' && (
            <SettingsView page onClose={() => setView('terminal')} />
          )}
          {view === 'vault' && <VaultView page onClose={() => setView('terminal')} />}
          {view === 'timeline' && (
            <TimelineView page onClose={() => setView('terminal')} />
          )}
        </div>
      </div>
    </div>
  );
}

function SidebarGlyph() {
  return (
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
  );
}
