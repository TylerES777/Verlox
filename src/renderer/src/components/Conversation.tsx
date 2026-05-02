import { forwardRef, type MouseEvent, type ReactNode } from 'react';

interface ConversationProps {
  children?: ReactNode;
  onBackgroundClick?: (event: MouseEvent<HTMLDivElement>) => void;
}

export const Conversation = forwardRef<HTMLDivElement, ConversationProps>(
  function Conversation({ children, onBackgroundClick }, ref) {
    return (
      <div
        ref={ref}
        onMouseUp={onBackgroundClick}
        className="flex-1 overflow-y-auto px-6 py-4"
      >
        {children}
      </div>
    );
  },
);
