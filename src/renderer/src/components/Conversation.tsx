import { useEffect, useLayoutEffect, useRef, type MouseEvent } from 'react';
import { Message } from './Message';
import type { CommandMessage } from '../hooks/useCommands';

interface ConversationProps {
  messages: CommandMessage[];
  forceScrollVersion: number;
  onStop: (id: string) => void;
  onConfirm: (id: string) => void;
  onCancel: (id: string) => void;
  onBackgroundClick?: (event: MouseEvent<HTMLDivElement>) => void;
}

export function Conversation({
  messages,
  forceScrollVersion,
  onStop,
  onConfirm,
  onCancel,
  onBackgroundClick,
}: ConversationProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handleScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickToBottomRef.current = distance < 8;
    };
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, []);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    stickToBottomRef.current = true;
    el.scrollTop = el.scrollHeight;
  }, [forceScrollVersion]);

  return (
    <div
      ref={containerRef}
      onMouseUp={onBackgroundClick}
      className="flex-1 overflow-y-auto px-6 py-4"
    >
      {messages.map((m) => (
        <Message
          key={m.id}
          message={m}
          onStop={onStop}
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      ))}
    </div>
  );
}
