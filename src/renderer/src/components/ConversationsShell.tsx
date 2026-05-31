import { useCallback, useEffect, useState } from 'react';
import { ConversationView } from './ConversationView';
import { TabBar, type ConversationTab } from './TabBar';
import { RunningPill, type RunningItem } from './RunningPill';
import { RunningProcesses } from './RunningProcesses';
import { Timeline } from './Timeline';
import { usePlanMode } from '../hooks/usePlanMode';
import { useModelChoice } from '../hooks/useModelChoice';
import { installProcessListeners } from '../hooks/useRunningProcesses';

// What each ConversationView reports about its in-flight commands.
type RunningEntry = { stepId: string; command: string };

function makeConversation(): ConversationTab {
  return { id: crypto.randomUUID(), title: 'New conversation' };
}

// Top-level authed screen. Owns the list of open conversations (tabs),
// which one is active, the session-wide Plan Mode preference, and the
// always-visible Timeline sidebar that lists the user's prompt history
// across sessions. Each conversation is an independent
// <ConversationView> — all kept mounted so a command running in a
// background tab keeps going; only the active one is visible.
//
// Conversations do not persist across app restarts (decided for v1):
// every launch starts with a single empty conversation.
export function ConversationsShell() {
  const { planMode, setPlanMode } = usePlanMode();
  const { modelChoice, setModelChoice } = useModelChoice();

  // Install the singleton IPC listeners that route command output /
  // exit into the live-processes board. Once per app lifetime.
  useEffect(() => {
    installProcessListeners();
  }, []);

  // Seed with one conversation. The second initializer reads `tabs`
  // (already initialized by the first hook) so both agree on the id.
  const [tabs, setTabs] = useState<ConversationTab[]>(() => [makeConversation()]);
  const [activeId, setActiveId] = useState<string>(() => tabs[0].id);

  // Insert-into-input request from a Timeline click. `tick` changes
  // per click so clicking the same prompt repeatedly still re-pastes.
  // The active ConversationView watches its insertRequest prop and
  // calls setValue on its Input handle.
  const [insertRequest, setInsertRequest] = useState<{
    value: string;
    tick: number;
  } | null>(null);
  const handleTimelineSelect = useCallback((text: string) => {
    setInsertRequest({ value: text, tick: Date.now() });
  }, []);

  // "Ask Verlox why" from the processes board — activates the source
  // conversation AND pre-fills its input with a diagnostic prompt.
  const handleAskWhy = useCallback(
    (conversationId: string, prompt: string) => {
      setActiveId(conversationId);
      setInsertRequest({ value: prompt, tick: Date.now() });
    },
    [],
  );

  const handleNew = useCallback(() => {
    const c = makeConversation();
    setTabs((cs) => [...cs, c]);
    setActiveId(c.id);
  }, []);

  const handleClose = useCallback(
    (id: string) => {
      // Closing the last remaining tab clears it instead of leaving an
      // empty app: swap in a fresh conversation. The new id forces the
      // ConversationView to remount, so its history and folder reset.
      if (tabs.length === 1) {
        const fresh = makeConversation();
        setTabs([fresh]);
        setActiveId(fresh.id);
        return;
      }
      const idx = tabs.findIndex((c) => c.id === id);
      const next = tabs.filter((c) => c.id !== id);
      setTabs(next);
      // If the closed tab was the active one, fall back to its left
      // neighbour (or the new first tab).
      if (activeId === id) {
        setActiveId(next[Math.max(0, idx - 1)].id);
      }
    },
    [tabs, activeId],
  );

  const handleTitleChange = useCallback((id: string, title: string) => {
    setTabs((cs) => cs.map((c) => (c.id === id ? { ...c, title } : c)));
  }, []);

  // Running commands per conversation, reported by each ConversationView.
  // The global running pill aggregates these across all tabs.
  const [runningByConv, setRunningByConv] = useState<Record<string, RunningEntry[]>>(
    {},
  );
  const handleRunningChange = useCallback(
    (id: string, running: RunningEntry[]) => {
      setRunningByConv((prev) => ({ ...prev, [id]: running }));
    },
    [],
  );

  // Flatten into pill items, attaching each conversation's current title.
  // Iterating `tabs` (not runningByConv) means a closed tab's stale entry
  // is naturally excluded — no separate cleanup needed.
  const runningItems: RunningItem[] = tabs.flatMap((tab) =>
    (runningByConv[tab.id] ?? []).map((rc) => ({
      conversationId: tab.id,
      conversationTitle: tab.title,
      stepId: rc.stepId,
      command: rc.command,
    })),
  );

  return (
    <div className="flex h-full w-full flex-col">
      {/* Custom title strip — replaces the hidden native title bar. It's
          the window's drag handle (WebkitAppRegion: drag), and the native
          min/max/close controls render at its right via titleBarOverlay
          (configured in the main process). White, so it blends into the
          app instead of the old black OS bar. */}
      <div
        className="h-10 shrink-0 bg-card"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        aria-hidden="true"
      />
      <div className="flex min-h-0 w-full flex-1">
      {/* Sidebar — 440px wide. The Timeline sizes to its content and
          self-caps its scroll window at ~8 entries (see TIMELINE_
          SCROLL_MAX), so it stays a compact board near the top rather
          than a full-height column. The Running pane below takes the
          remaining space. */}
      <aside
        className="flex w-[440px] shrink-0 flex-col border-r border-hairline"
        aria-label="Prompt timeline and running processes"
      >
        <div className="shrink-0">
          <Timeline onSelect={handleTimelineSelect} />
        </div>
        {/* Live processes pane — sits below the Timeline. Only present
            when there's something to show (it self-manages fade-in /
            fade-out and collapses to nothing when empty so the Timeline
            reclaims the vertical space). The board carries its own
            border / elevation, so this wrapper stays chrome-free. */}
        <div className="min-h-0 flex-1">
          <RunningProcesses
            tabs={tabs}
            onJump={setActiveId}
            onAskWhy={handleAskWhy}
          />
        </div>
      </aside>

      {/* Main pane — conversation centred in its available space.
          The double-centring (this outer wrapper + the inner reading
          column) gives the document-feel composition. */}
      <div className="flex flex-1 min-w-0 flex-col p-6">
        <div className="mx-auto flex w-full max-w-app flex-1 flex-col min-h-0">
          {/* Tab strip + the global running-commands pill on the right. */}
          <div className="flex items-center gap-3 pb-3">
            <div className="min-w-0 flex-1">
              <TabBar
                tabs={tabs}
                activeId={activeId}
                onSelect={setActiveId}
                onClose={handleClose}
                onNew={handleNew}
              />
            </div>
            <RunningPill items={runningItems} onJump={setActiveId} />
          </div>
          {/* Every conversation stays mounted; inactive ones are display:none
              so background work survives a tab switch. */}
          <div className="flex-1 min-h-0">
            {tabs.map((tab) => (
              <div
                key={tab.id}
                className={tab.id === activeId ? 'h-full' : 'hidden'}
              >
                <ConversationView
                  conversationId={tab.id}
                  isActive={tab.id === activeId}
                  planMode={planMode}
                  onPlanModeChange={setPlanMode}
                  modelChoice={modelChoice}
                  onModelChoiceChange={setModelChoice}
                  onTitleChange={handleTitleChange}
                  onRunningChange={handleRunningChange}
                  insertRequest={tab.id === activeId ? insertRequest : null}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}
