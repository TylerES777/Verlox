import { useEffect, useRef, type MouseEvent } from 'react';
import { Header } from './Header';
import { Conversation } from './Conversation';
import { Input, type InputHandle } from './Input';
import { useCwd } from '../hooks/useCwd';
import { useCommands } from '../hooks/useCommands';

export function ConversationScreen() {
  const { cwd } = useCwd();
  const { messages, forceScrollVersion, submitInput, confirmRun, cancelRun, stopCommand } =
    useCommands(cwd);
  const inputRef = useRef<InputHandle>(null);

  // Belt-and-suspenders for the keyboard flow: the user clicked Sign in (or
  // the avatar's Sign out → ... → another sign-in), focus was on a button
  // that just unmounted. Input.tsx also auto-focuses on its own mount, but
  // explicitly focusing here means we don't depend on that timing detail.
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
    <div className="flex h-full w-full flex-col bg-off-white text-gray-700">
      <Header displayPath={cwd?.display ?? ''} />
      <Conversation
        messages={messages}
        forceScrollVersion={forceScrollVersion}
        onStop={stopCommand}
        onConfirm={confirmRun}
        onCancel={cancelRun}
        onBackgroundClick={handleConversationClick}
      />
      <Input ref={inputRef} onSubmit={submitInput} />
    </div>
  );
}
