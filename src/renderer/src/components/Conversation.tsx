import { useEffect, useLayoutEffect, useRef, type MouseEvent } from 'react';
import { Message } from './Message';
import type { CommandMessage } from '../hooks/useCommands';

interface ConversationProps {
  messages: CommandMessage[];
  forceScrollVersion: number;
  onStop: (id: string) => void;
  // Plan Card buttons (Chunk 4). Threaded to each Message so a paused
  // turn can resolve via Run or Cancel.
  onConfirmPlan: (id: string) => void;
  onCancelPlan: (id: string) => void;
  onBackgroundClick?: (event: MouseEvent<HTMLDivElement>) => void;
}

export function Conversation({
  messages,
  forceScrollVersion,
  onStop,
  onConfirmPlan,
  onCancelPlan,
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
      className="flex-1 overflow-y-auto"
    >
      {/* Reading-column constraint. Document feel — content stays in a 580px
          column centered in the card, regardless of how wide the card is on
          large monitors. Generous top padding keeps the first turn off the
          header edge so it never reads as jammed into the corner. */}
      <div className="mx-auto max-w-reading px-6 pb-6 pt-10">
        {messages.map((m) => (
          <Message
            key={m.id}
            message={m}
            onStop={onStop}
            onConfirmPlan={onConfirmPlan}
            onCancelPlan={onCancelPlan}
          />
        ))}
      </div>
    </div>
  );
}
