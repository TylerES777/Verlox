import { useRef, type MouseEvent } from 'react';
import { Header } from './Header';
import { Conversation } from './Conversation';
import { Input, type InputHandle } from './Input';
import { useCwd } from '../hooks/useCwd';
import { useCommands } from '../hooks/useCommands';

export function ConversationScreen() {
  const { cwd } = useCwd();
  const { messages, forceScrollVersion, runCommand, stopCommand } = useCommands(
    cwd?.display ?? '',
  );
  const inputRef = useRef<InputHandle>(null);

  const handleConversationClick = (event: MouseEvent<HTMLDivElement>) => {
    const selection = window.getSelection();
    if (selection && selection.toString().length > 0) return;
    if (event.target instanceof HTMLAnchorElement) return;
    if (event.target instanceof HTMLButtonElement) return;
    inputRef.current?.focus();
  };

  return (
    <div className="flex h-full w-full flex-col bg-off-white text-gray-700">
      <Header displayPath={cwd?.display ?? ''} />
      <Conversation
        messages={messages}
        forceScrollVersion={forceScrollVersion}
        onStop={stopCommand}
        onBackgroundClick={handleConversationClick}
      />
      <Input ref={inputRef} onSubmit={runCommand} />
    </div>
  );
}
