import { useCallback, useState } from 'react';
import { ConversationView } from './ConversationView';
import { TabBar, type ConversationTab } from './TabBar';
import { RunningPill, type RunningItem } from './RunningPill';
import { usePeekDefault } from '../hooks/usePeekDefault';
import { usePlanMode } from '../hooks/usePlanMode';

// What each ConversationView reports about its in-flight commands.
type RunningEntry = { stepId: string; command: string };

function makeConversation(): ConversationTab {
  return { id: crypto.randomUUID(), title: 'New conversation' };
}

// Top-level authed screen. Owns the list of open conversations (tabs),
// which one is active, and the two session-wide preferences (peek
// default, Plan Mode). Each conversation is an independent <ConversationView>
// — all kept mounted so a command running in a background tab keeps
// going; only the active one is visible.
//
// Conversations do not persist across app restarts (decided for v1):
// every launch starts with a single empty conversation.
export function ConversationsShell() {
  const { peekDefault, setPeekDefault } = usePeekDefault();
  const { planMode, setPlanMode } = usePlanMode();

  // Seed with one conversation. The second initializer reads `tabs`
  // (already initialized by the first hook) so both agree on the id.
  const [tabs, setTabs] = useState<ConversationTab[]>(() => [makeConversation()]);
  const [activeId, setActiveId] = useState<string>(() => tabs[0].id);

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
    <div className="flex h-full w-full flex-col p-6">
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
                peekDefault={peekDefault}
                onPeekDefaultChange={setPeekDefault}
                planMode={planMode}
                onPlanModeChange={setPlanMode}
                onTitleChange={handleTitleChange}
                onRunningChange={handleRunningChange}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
