import { useCallback, useEffect, useRef, type MouseEvent } from 'react';
import { Header } from './Header';
import { Conversation } from './Conversation';
import { Input, type InputHandle } from './Input';
import { useCwd } from '../hooks/useCwd';
import { useCommands } from '../hooks/useCommands';
import { usePeekDefault } from '../hooks/usePeekDefault';
import { usePlanMode } from '../hooks/usePlanMode';

const EXAMPLES = [
  'List the files in this folder',
  'Go to my Documents folder',
  'Show me what’s running on this machine',
];

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
        Type what you&rsquo;d like to do, in plain English. Vorlox will translate it to a
        command and ask before running anything risky.
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

export function ConversationScreen() {
  const { cwd } = useCwd();
  // Single owner of the session-wide peek + plan-mode preferences.
  // Passed into useCommands as seeds for new turns, and threaded
  // through Header to the toggle UIs. Keeping one hook instance per
  // preference means ConversationScreen always sees the latest value
  // the moment the user flips it.
  const { peekDefault, setPeekDefault } = usePeekDefault();
  const { planMode, setPlanMode } = usePlanMode();
  const {
    messages,
    forceScrollVersion,
    submitInput,
    stopCommand,
    togglePeek,
    confirmPlan,
    cancelPlan,
  } = useCommands(cwd, peekDefault, planMode);
  const inputRef = useRef<InputHandle>(null);

  // After the user resolves a Plan Card (either button), the Cancel/Run
  // button unmounts and focus would fall back to document.body. Pull
  // focus back to the input so the user can keep typing without first
  // clicking into the conversation. The same wrapper is fine for both
  // buttons — the underlying action differs (confirm vs cancel) but the
  // focus refocus is identical.
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

  // Focus input on mount (post-sign-in keyboard flow).
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleConversationClick = (event: MouseEvent<HTMLDivElement>) => {
    const selection = window.getSelection();
    if (selection && selection.toString().length > 0) return;
    if (event.target instanceof HTMLAnchorElement) return;
    if (event.target instanceof HTMLButtonElement) return;
    inputRef.current?.focus();
  };

  return (
    <div className="h-full w-full bg-canvas p-6">
      <div className="mx-auto flex h-full max-w-app flex-col overflow-hidden rounded-[14px] bg-card shadow-card">
        <Header
          displayPath={cwd?.display ?? ''}
          peekDefault={peekDefault}
          onPeekDefaultChange={setPeekDefault}
          planMode={planMode}
          onPlanModeChange={setPlanMode}
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
    </div>
  );
}
