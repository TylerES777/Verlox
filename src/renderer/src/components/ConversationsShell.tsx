import { useCallback, useEffect, useState } from 'react';
import { ConversationView } from './ConversationView';
import { TabBar, type ConversationTab } from './TabBar';
import { RunningPill, type RunningItem } from './RunningPill';
import { Timeline } from './Timeline';
import { usePlanMode } from '../hooks/usePlanMode';

// What each ConversationView reports about its in-flight commands.
type RunningEntry = { stepId: string; command: string };

function makeConversation(): ConversationTab {
  return { id: crypto.randomUUID(), title: 'New conversation' };
}

// Persist the Timeline sidebar's open/closed state across launches.
// Default open — first impression of the app is the prompt history
// rail, which gives the user immediate "this is mine" recognition.
const TIMELINE_STORAGE_KEY = 'vorlox.timelineOpen';
function readTimelineOpen(): boolean {
  try {
    return window.localStorage.getItem(TIMELINE_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

// Top-level authed screen. Owns the list of open conversations (tabs),
// which one is active, the session-wide Plan Mode preference, and the
// Timeline sidebar that lists the user's prompt history across
// sessions. Each conversation is an independent <ConversationView> —
// all kept mounted so a command running in a background tab keeps
// going; only the active one is visible.
//
// Conversations do not persist across app restarts (decided for v1):
// every launch starts with a single empty conversation.
export function ConversationsShell() {
  const { planMode, setPlanMode } = usePlanMode();

  // Seed with one conversation. The second initializer reads `tabs`
  // (already initialized by the first hook) so both agree on the id.
  const [tabs, setTabs] = useState<ConversationTab[]>(() => [makeConversation()]);
  const [activeId, setActiveId] = useState<string>(() => tabs[0].id);

  // Timeline sidebar open/closed, persisted to localStorage.
  const [timelineOpen, setTimelineOpen] = useState<boolean>(readTimelineOpen);
  useEffect(() => {
    try {
      window.localStorage.setItem(
        TIMELINE_STORAGE_KEY,
        timelineOpen ? 'true' : 'false',
      );
    } catch {
      // localStorage unavailable — state still works in memory.
    }
  }, [timelineOpen]);

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
      {/* Timeline sidebar — slides in from the left. Width transition
          keeps the main area's centring smooth when toggled. */}
      <aside
        className={`shrink-0 overflow-hidden border-r border-hairline transition-[width] duration-200 ease-out ${
          timelineOpen ? 'w-[260px]' : 'w-0'
        }`}
        aria-hidden={!timelineOpen}
      >
        {/* Inner pane has its own fixed width so the contents don't
            reflow during the width transition. */}
        <div className="h-full w-[260px]">
          <Timeline onSelect={handleTimelineSelect} />
        </div>
      </aside>

      {/* Main pane */}
      <div className="relative flex flex-1 min-w-0 flex-col p-6">
        {/* Sidebar toggle — sits in the top-left of the main pane,
            outside the centred conversation column. Same icon flips
            between collapse / expand. */}
        <button
          type="button"
          onClick={() => setTimelineOpen((v) => !v)}
          aria-label={timelineOpen ? 'Hide timeline' : 'Show timeline'}
          title={timelineOpen ? 'Hide timeline' : 'Show timeline'}
          className="absolute left-3 top-3 flex h-7 w-7 items-center justify-center rounded-md text-ink-hint transition-colors hover:bg-surface-subtle hover:text-ink focus:outline-none"
        >
          <SidebarGlyph open={timelineOpen} />
        </button>

        {/* Left-anchored (no mx-auto) so the conversation card sits
            right next to the Timeline sidebar instead of floating in
            the middle of the window with a huge gap on its left.
            max-w-app still caps the column on ultra-wide screens; the
            extra room falls to the right of the card as natural
            breathing space. */}
        <div className="flex w-full max-w-app flex-1 flex-col min-h-0">
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

// Two-state glyph: a small panel-with-line icon. Open variant shows
// the line as the right edge of the panel (sidebar visible); closed
// variant flips the line to suggest expansion.
function SidebarGlyph({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <line x1={open ? '6.5' : '9.5'} y1="3" x2={open ? '6.5' : '9.5'} y2="13" />
    </svg>
  );
}
