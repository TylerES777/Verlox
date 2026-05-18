import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import type { CwdInfo } from '@shared/types';
import { Header } from './Header';
import { Conversation } from './Conversation';
import { Input, type InputHandle } from './Input';
import { useCommands } from '../hooks/useCommands';

const EXAMPLES = [
  'List the files in this folder',
  'Go to my Documents folder',
  'Show me what’s running on this machine',
];

// Max characters for a tab title before it gets an ellipsis.
const TITLE_MAX = 28;

function deriveTitle(firstUserInput: string): string {
  const trimmed = firstUserInput.trim();
  if (trimmed.length <= TITLE_MAX) return trimmed;
  return `${trimmed.slice(0, TITLE_MAX).trimEnd()}…`;
}

interface EmptyStateProps {
  onExampleClick: (prompt: string) => void;
}

function EmptyState({ onExampleClick }: EmptyStateProps) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-8">
      <h1
        className="text-center font-serif text-[28px] italic font-normal text-ink"
        style={{ letterSpacing: '-0.005em' }}
      >
        What would you like to do?
      </h1>
      <p className="mt-3 max-w-[460px] text-center text-[14px] leading-relaxed text-ink-hint">
        Type in plain English. Vorlox plans the steps, runs them, and tells you what
        happened. Turn on Plan Mode to review every plan before it runs.
      </p>
      <div className="mt-8 flex w-full max-w-[380px] flex-col gap-2">
        {EXAMPLES.map((prompt) => (
          <button
            key={prompt}
            type="button"
            onClick={() => onExampleClick(prompt)}
            className="rounded-lg border-[0.5px] border-subtle-border bg-surface-faint px-3.5 py-2.5 text-left text-[13.5px] text-ink-body hover:bg-surface-subtle focus:outline-none"
          >
            {prompt}
          </button>
        ))}
      </div>
    </div>
  );
}

interface ConversationViewProps {
  conversationId: string;
  // True when this conversation is the active tab. Inactive views stay
  // mounted (hidden via CSS) so running commands and history survive a
  // tab switch — isActive only drives input focus.
  isActive: boolean;
  // Session-wide preferences, owned by ConversationsShell. Every
  // ConversationView shares the same values; the per-conversation
  // Header just renders the toggles bound to these.
  peekDefault: boolean;
  onPeekDefaultChange: (value: boolean) => void;
  planMode: boolean;
  onPlanModeChange: (value: boolean) => void;
  // Reports this conversation's tab title up to the shell. Fired once
  // when the first message arrives (the title derives from it).
  onTitleChange: (conversationId: string, title: string) => void;
}

// One conversation: its own working directory, its own message history,
// its own card. Multiple of these are mounted at once (one per tab) —
// only the active one is visible. ConversationsShell owns the list.
export function ConversationView({
  conversationId,
  isActive,
  peekDefault,
  onPeekDefaultChange,
  planMode,
  onPlanModeChange,
  onTitleChange,
}: ConversationViewProps) {
  // Per-conversation working directory. null = folderless: commands
  // still run (from the home directory), the header shows "No folder".
  // A successful `cd` turn fills this in via onCwdChange below.
  const [cwd, setCwd] = useState<CwdInfo | null>(null);
  const inputRef = useRef<InputHandle>(null);

  const handleCwdChange = useCallback((next: CwdInfo) => {
    setCwd(next);
  }, []);

  const {
    messages,
    forceScrollVersion,
    submitInput,
    stopCommand,
    togglePeek,
    confirmPlan,
    cancelPlan,
  } = useCommands(cwd, peekDefault, planMode, handleCwdChange);

  // Report the tab title up to the shell. The title is "New conversation"
  // until the first message lands, then a truncation of that message.
  // lastTitleRef seeds to the empty-state title so the mount render
  // doesn't fire a redundant report.
  const lastTitleRef = useRef<string>('New conversation');
  useEffect(() => {
    const title =
      messages.length === 0
        ? 'New conversation'
        : deriveTitle(messages[0].userInput);
    if (title !== lastTitleRef.current) {
      lastTitleRef.current = title;
      onTitleChange(conversationId, title);
    }
  }, [messages, conversationId, onTitleChange]);

  // Focus the input when this conversation becomes active (tab switch or
  // first mount). Focusing a display:none element is a no-op, but by the
  // time this effect runs the `hidden` class is already gone.
  useEffect(() => {
    if (isActive) inputRef.current?.focus();
  }, [isActive]);

  // After a Plan Card resolves, pull focus back to the input so the user
  // can keep typing without clicking into the conversation first.
  const handleConfirmPlan = useCallback(
    (id: string) => {
      confirmPlan(id);
      inputRef.current?.focus();
    },
    [confirmPlan],
  );
  const handleCancelPlan = useCallback(
    (id: string) => {
      cancelPlan(id);
      inputRef.current?.focus();
    },
    [cancelPlan],
  );

  const handleConversationClick = (event: MouseEvent<HTMLDivElement>) => {
    const selection = window.getSelection();
    if (selection && selection.toString().length > 0) return;
    if (event.target instanceof HTMLAnchorElement) return;
    if (event.target instanceof HTMLButtonElement) return;
    inputRef.current?.focus();
  };

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-[14px] bg-card shadow-card">
      <Header
        displayPath={cwd?.display ?? null}
        peekDefault={peekDefault}
        onPeekDefaultChange={onPeekDefaultChange}
        planMode={planMode}
        onPlanModeChange={onPlanModeChange}
      />
      {messages.length === 0 ? (
        <EmptyState
          onExampleClick={(prompt) => inputRef.current?.setValue(prompt)}
        />
      ) : (
        <Conversation
          messages={messages}
          forceScrollVersion={forceScrollVersion}
          onStop={stopCommand}
          onTogglePeek={togglePeek}
          onConfirmPlan={handleConfirmPlan}
          onCancelPlan={handleCancelPlan}
          onBackgroundClick={handleConversationClick}
        />
      )}
      <Input ref={inputRef} onSubmit={submitInput} />
    </div>
  );
}
