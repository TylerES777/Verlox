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
    const openSettings = () => setSettingsOpen(true);
    const openVault = () => setVaultOpen(true);
    window.addEventListener('verlox:open-settings', openSettings);
    window.addEventListener('verlox:open-vault', openVault);
    return () => {
      window.removeEventListener('verlox:open-settings', openSettings);
      window.removeEventListener('verlox:open-vault', openVault);
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
          tabs={tabs}
          activeId={activeId}
          onSelect={setActiveId}
          onClose={handleClose}
          onToggleSidebar={() => setSidebarOpen(false)}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenVault={() => setVaultOpen(true)}
          onOpenTimeline={() => setTimelineOpen(true)}
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
        </div>
          {/* Terminal board — flush white, every terminal stays mounted so
            background tabs keep running. */}
        <div className="min-h-0 flex-1 overflow-hidden">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={tab.id === activeId ? 'h-full' : 'hidden'}
            >
              <TerminalView
                id={tab.id}
                isActive={tab.id === activeId}
                onFirstCommand={(cmd) => renameTab(tab.id, cmd)}
              />
            </div>
          ))}
        </div>
      </div>

      {settingsOpen && <SettingsView onClose={() => setSettingsOpen(false)} />}
      {vaultOpen && <VaultView onClose={() => setVaultOpen(false)} />}
      {timelineOpen && <TimelineView onClose={() => setTimelineOpen(false)} />}
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
