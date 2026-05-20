import { useCallback, useEffect, useState } from 'react';
import { ConversationView } from './ConversationView';
import { TabBar, type ConversationTab } from './TabBar';
import { RunningPill, type RunningItem } from './RunningPill';
import { RunningProcesses } from './RunningProcesses';
import { Timeline } from './Timeline';
import { usePlanMode } from '../hooks/usePlanMode';
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

  // "Ask Vorlox why" from the processes board — activates the source
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
    <div className="flex h-full w-full">
      {/* Timeline sidebar — always visible. Fixed-width column on the
          left; no collapse affordance because the app's empty-state
          felt off without it. */}
      {/* Sidebar — 440px wide. The Timeline lives in a bounded
          area near the top (max 65vh) so it stays a board, not a
          full-height column; everything below is reserved for future
          additions. A soft white fade at the Timeline's bottom edge
          softens the scroll cut-off into the empty space. */}
      <aside
        className="flex w-[440px] shrink-0 flex-col border-r border-hairline"
        aria-label="Prompt timeline and running processes"
      >
        <div className="relative max-h-[65vh] min-h-0 shrink overflow-hidden">
          <Timeline onSelect={handleTimelineSelect} />
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-b from-transparent to-white"
            aria-hidden="true"
          />
        </div>
        {/* Live processes board — sits below the Timeline, takes the
            remaining vertical space. Lists every long-lived shell
            process Vorlox has running with stop / restart / open / ask
            controls. */}
        <div className="min-h-0 flex-1 border-t border-hairline">
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
  );
}
