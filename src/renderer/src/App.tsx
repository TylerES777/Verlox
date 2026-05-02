import { useEffect, useRef, type MouseEvent } from 'react';
import { Header } from './components/Header';
import { Conversation } from './components/Conversation';
import { Input, type InputHandle } from './components/Input';
import { useCwd } from './hooks/useCwd';

export default function App() {
  const { cwd } = useCwd();
  const inputRef = useRef<InputHandle>(null);

  useEffect(() => {
    window.api
      .ping()
      .then((reply) => console.log('IPC ping →', reply))
      .catch((err) => console.error('IPC ping failed:', err));
  }, []);

  const handleConversationClick = (event: MouseEvent<HTMLDivElement>) => {
    const selection = window.getSelection();
    if (selection && selection.toString().length > 0) return;
    if (event.target instanceof HTMLAnchorElement) return;
    inputRef.current?.focus();
  };

  return (
    <div className="flex h-full w-full flex-col bg-off-white text-gray-700">
      <Header displayPath={cwd?.display ?? ''} />
      <Conversation onBackgroundClick={handleConversationClick} />
      <Input ref={inputRef} />
    </div>
  );
}
