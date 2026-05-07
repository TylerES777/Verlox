import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';

const MAX_LINES = 6;

export interface InputHandle {
  focus: () => void;
  // Programmatic fill, used by the empty-state example chips. Sets the
  // textarea contents and focuses — does NOT submit. The user can edit
  // before pressing Enter.
  setValue: (text: string) => void;
}

interface InputProps {
  onSubmit: (value: string) => void;
}

export const Input = forwardRef<InputHandle, InputProps>(function Input({ onSubmit }, ref) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lineHeightRef = useRef<number>(0);
  const [value, setValue] = useState('');

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
    setValue: (text: string) => {
      // setValue here is the useState setter from the closure above
      // (different identity from the property name on this returned object).
      setValue(text);
      textareaRef.current?.focus();
    },
  }));

  const resize = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    if (lineHeightRef.current === 0) {
      const computed = window.getComputedStyle(ta);
      lineHeightRef.current = parseFloat(computed.lineHeight) || 20;
    }
    ta.style.height = 'auto';
    const max = lineHeightRef.current * MAX_LINES;
    const next = Math.min(ta.scrollHeight, max);
    ta.style.height = `${next}px`;
    ta.style.overflowY = ta.scrollHeight > max ? 'auto' : 'hidden';
  }, []);

  useEffect(() => {
    resize();
  }, [value, resize]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        onSubmit(trimmed);
      }
      setValue('');
    }
  };

  return (
    <div className="shrink-0 p-4">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Type a message..."
        rows={1}
        className="block w-full resize-none rounded-lg border border-transparent bg-[#F5F5F2] px-4 py-3 text-[14px] leading-6 text-gray-700 placeholder:text-gray-400 focus:border-gray-300 focus:outline-none"
      />
    </div>
  );
});
