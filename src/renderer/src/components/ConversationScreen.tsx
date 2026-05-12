import { useEffect, useRef, type MouseEvent } from 'react';
import { Header } from './Header';
import { Conversation } from './Conversation';
import { Input, type InputHandle } from './Input';
import { useCwd } from '../hooks/useCwd';
import { useCommands } from '../hooks/useCommands';
import { usePeekDefault } from '../hooks/usePeekDefault';

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
  // Single owner of the session-wide peek preference. Passed into
  // useCommands as the seed for new turns, and threaded through Header
  // to the HeaderMenu's preference toggle. Keeping one hook instance
  // means ConversationScreen always sees the latest value the moment
  // the user flips it in the popover.
  const { peekDefault, setPeekDefault } = usePeekDefault();
  const { messages, forceScrollVersion, submitInput, stopCommand, togglePeek } =
    useCommands(cwd, peekDefault);
  const inputRef = useRef<InputHandle>(null);

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
            onBackgroundClick={handleConversationClick}
          />
        )}
        <Input ref={inputRef} onSubmit={submitInput} />
      </div>
    </div>
  );
}
