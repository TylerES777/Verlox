import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { PathPicker, type PathSelection } from './PathPicker';

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
  // Directory the path picker starts browsing in (the conversation's
  // current folder, or null for home).
  pickerInitialPath: string | null;
  // Called when the user locks the conversation to a folder/file via the
  // picker. ConversationView turns this into the per-conversation lock.
  onPickPath: (selection: PathSelection) => void;
  // True when the conversation has a folder or file locked. Drives the
  // folder button's amber "locked" state so the user gets confirmation
  // from the button itself, without checking the header.
  locked: boolean;
}

export const Input = forwardRef<InputHandle, InputProps>(function Input(
  { onSubmit, pickerInitialPath, onPickPath, locked },
  ref,
) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lineHeightRef = useRef<number>(0);
  const [value, setValue] = useState('');

  // Path picker open state. The wrapper ref spans BOTH the folder button
  // and the picker panel, so a click on either counts as "inside" and
  // the click-outside handler only fires for genuine outside clicks.
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerWrapRef = useRef<HTMLDivElement>(null);

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

  // Close the picker on click-outside or Escape — only while it's open.
  useEffect(() => {
    if (!pickerOpen) return;
    function onPointerDown(e: MouseEvent) {
      if (
        pickerWrapRef.current &&
        !pickerWrapRef.current.contains(e.target as Node)
      ) {
        setPickerOpen(false);
      }
    }
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') setPickerOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [pickerOpen]);

  const submit = () => {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      onSubmit(trimmed);
    }
    setValue('');
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const canSend = value.trim().length > 0;

  const handlePick = (selection: PathSelection) => {
    onPickPath(selection);
    setPickerOpen(false);
    textareaRef.current?.focus();
  };

  return (
    <div className="shrink-0 p-4">
      <div className="flex items-end gap-2">
        {/* Folder-icon button — opens the lock-to-folder/file picker.
            The picker panel renders inside this wrapper so a click on
            either the button or the panel is "inside". */}
        <div ref={pickerWrapRef} className="relative shrink-0">
          {pickerOpen && (
            <PathPicker initialPath={pickerInitialPath} onPick={handlePick} />
          )}
          <button
            type="button"
            onClick={() => setPickerOpen((o) => !o)}
            aria-label="Lock to a folder or file"
            title={
              locked
                ? 'Locked — change the folder or file'
                : 'Lock to a folder or file'
            }
            aria-pressed={locked}
            className={`flex h-12 w-12 items-center justify-center rounded-xl border-[0.5px] transition-colors focus:outline-none ${
              locked
                ? // A lock is active — amber state. Confirmation lives on
                  // the button itself; no need to glance at the header.
                  'border-amber/50 bg-amber/[0.08] text-amber'
                : pickerOpen
                  ? 'border-input-border bg-surface-subtle text-ink'
                  : 'border-subtle-border bg-surface-subtle text-ink-label hover:text-ink'
            }`}
          >
            <FolderIcon />
          </button>
        </div>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask Vorlox…"
          rows={1}
          className="block w-full flex-1 resize-none rounded-2xl border-[0.5px] border-subtle-border bg-surface-subtle px-4 py-3 text-[14px] leading-6 text-ink placeholder:text-ink-hint focus:border-input-border focus:outline-none transition-colors"
        />
        {/* Send button — a dark circle. Enter still submits; this is the
            visible affordance. Fades when there's nothing to send. */}
        <button
          type="button"
          onClick={submit}
          disabled={!canSend}
          aria-label="Send"
          className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full transition-colors focus:outline-none ${
            canSend
              ? 'bg-ink text-card hover:bg-black'
              : 'bg-ink/25 text-card'
          }`}
        >
          <SendIcon />
        </button>
      </div>
    </div>
  );
});

function SendIcon() {
  return (
    <svg
      viewBox="0 0 18 18"
      className="h-[17px] w-[17px]"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="9" y1="14.5" x2="9" y2="3.5" />
      <polyline points="4.5,8 9,3.5 13.5,8" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg
      viewBox="0 0 18 18"
      className="h-[18px] w-[18px]"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 4.5h5l1.7 2H16v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
    </svg>
  );
}
