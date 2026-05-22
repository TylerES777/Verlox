import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import type { AttachedImage } from '@shared/types';
import { PathPicker, type PathSelection } from './PathPicker';

const MAX_LINES = 6;

// Cap each attached image at 5 MB raw. Anthropic accepts up to ~5 MB
// per image content block (3.75 MB base64 ≈ 5 MB raw); we enforce
// before encoding so the user gets a clean error instead of a 400.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

// Renderer-side representation: wire payload (mediaType + base64Data)
// plus display-only fields (dataUrl for the preview, filename + size
// for the chip label).
interface AttachmentState extends AttachedImage {
  dataUrl: string;
  name: string;
  byteSize: number;
}

export interface InputHandle {
  focus: () => void;
  // Programmatic fill, used by the empty-state example chips. Sets the
  // textarea contents and focuses — does NOT submit. The user can edit
  // before pressing Enter.
  setValue: (text: string) => void;
}

interface InputProps {
  onSubmit: (value: string, image: AttachedImage | null) => void;
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
  // True while the AI is generating / typing a response. Locks the
  // whole input row so the user can't submit a second turn over the
  // one in flight. Clears the instant the turn finishes or is stopped.
  busy: boolean;
}

export const Input = forwardRef<InputHandle, InputProps>(function Input(
  { onSubmit, pickerInitialPath, onPickPath, locked, busy },
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

  // Image attached to the next submit. Cleared on submit OR via the
  // chip's X button. Only one image per turn — re-attaching replaces.
  const [attachment, setAttachment] = useState<AttachmentState | null>(null);
  // Soft error surfaced under the input when an attach attempt fails
  // (wrong type / too big). Cleared on the next successful attach or
  // on user dismiss.
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  // Hidden file input — the visible paperclip button clicks this.
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Drag-over visual state: highlights the textarea border when the
  // user drags an image file into the input area.
  const [isDraggingImage, setIsDraggingImage] = useState(false);

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

  // Accept a File from the file picker, a paste, or a drop. Validates
  // type + size, base64-encodes, and stores as the current attachment.
  // Replaces any prior attachment — one image per submit.
  const acceptFile = useCallback(async (file: File): Promise<void> => {
    if (!ACCEPTED_IMAGE_TYPES.has(file.type)) {
      setAttachmentError(
        'Only PNG, JPEG, WebP, and GIF images are supported.',
      );
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      const mb = (file.size / (1024 * 1024)).toFixed(1);
      setAttachmentError(`Image is ${mb} MB — the limit is 5 MB.`);
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const base64Data = dataUrl.includes(',')
        ? dataUrl.slice(dataUrl.indexOf(',') + 1)
        : dataUrl;
      setAttachment({
        mediaType: file.type,
        base64Data,
        dataUrl,
        name: file.name || 'screenshot',
        byteSize: file.size,
      });
      setAttachmentError(null);
    } catch {
      setAttachmentError("Couldn't read that file. Try a different image.");
    }
  }, []);

  const handleFileInputChange = (
    e: React.ChangeEvent<HTMLInputElement>,
  ): void => {
    const file = e.target.files?.[0];
    if (file) void acceptFile(file);
    // Reset so picking the same file twice in a row still re-fires onChange.
    e.target.value = '';
  };

  // Paste handler — picks up images from the system clipboard
  // (Windows screenshot tool, macOS Cmd+Ctrl+Shift+4, etc.). The
  // event fires on the textarea; if an image item is present we
  // intercept and treat it as an attach instead of pasting text.
  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          void acceptFile(file);
          return;
        }
      }
    }
  };

  // Drag-and-drop handlers on the input row. Only react to drags that
  // actually carry a file (ignore text drags, link drags, etc.).
  const handleDragOver = (e: DragEvent<HTMLDivElement>): void => {
    if (Array.from(e.dataTransfer.types).includes('Files')) {
      e.preventDefault();
      setIsDraggingImage(true);
    }
  };
  const handleDragLeave = (e: DragEvent<HTMLDivElement>): void => {
    // Only clear when leaving the outer wrapper, not on child boundaries.
    if (e.currentTarget === e.target) setIsDraggingImage(false);
  };
  const handleDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setIsDraggingImage(false);
    const file = Array.from(e.dataTransfer.files).find((f) =>
      ACCEPTED_IMAGE_TYPES.has(f.type),
    );
    if (file) void acceptFile(file);
  };

  const submit = () => {
    // Hard block while the AI is working — Enter and the send button
    // both route here, so this one guard covers every submit path.
    if (busy) return;
    const trimmed = value.trim();
    if (trimmed.length === 0 && !attachment) return;
    onSubmit(
      trimmed,
      attachment
        ? { mediaType: attachment.mediaType, base64Data: attachment.base64Data }
        : null,
    );
    setValue('');
    setAttachment(null);
    setAttachmentError(null);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  // Now you can also send an image-only message (e.g. "what's this?")
  // — text is no longer strictly required when an image is attached.
  // Never sendable while busy.
  const canSend = !busy && (value.trim().length > 0 || attachment !== null);

  const handlePick = (selection: PathSelection) => {
    onPickPath(selection);
    setPickerOpen(false);
    textareaRef.current?.focus();
  };

  return (
    <div
      className="shrink-0 p-4"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Attachment preview — a compact rounded thumbnail with a
          remove (X) overlaid in the top-right corner. Sits above the
          input row when an image is staged so the user always sees
          what's about to be sent. The thumbnail uses object-cover so
          non-square screenshots crop cleanly instead of distorting. */}
      {attachment && (
        <div className="mb-2 flex items-start">
          <div className="group relative">
            <img
              src={attachment.dataUrl}
              alt={attachment.name}
              className="h-16 w-16 rounded-xl border border-subtle-border object-cover shadow-sm"
            />
            <button
              type="button"
              onClick={() => {
                setAttachment(null);
                setAttachmentError(null);
              }}
              aria-label="Remove attached image"
              title="Remove attached image"
              className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-subtle-border bg-card text-ink-label shadow-sm transition-colors hover:bg-surface-subtle hover:text-ink focus:outline-none"
            >
              <XIcon />
            </button>
          </div>
        </div>
      )}
      {/* Attach-error chip — surfaces type / size validation failures
          inline so the user doesn't wonder why nothing happened. */}
      {attachmentError && !attachment && (
        <div className="mb-2 flex items-center justify-between gap-3 rounded-xl border border-step-failed/30 bg-step-failed-tint px-3 py-2 text-[12px] text-step-failed">
          <span>{attachmentError}</span>
          <button
            type="button"
            onClick={() => setAttachmentError(null)}
            aria-label="Dismiss"
            className="text-step-failed hover:text-step-failed/80 focus:outline-none"
          >
            <XIcon />
          </button>
        </div>
      )}
      <div className="flex items-end gap-2">
        {/* Folder-icon button — opens the lock-to-folder/file picker. */}
        <div ref={pickerWrapRef} className="relative shrink-0">
          {pickerOpen && (
            <PathPicker initialPath={pickerInitialPath} onPick={handlePick} />
          )}
          <button
            type="button"
            onClick={() => setPickerOpen((o) => !o)}
            disabled={busy}
            aria-label="Lock to a folder or file"
            title={
              locked
                ? 'Locked — change the folder or file'
                : 'Lock to a folder or file'
            }
            aria-pressed={locked}
            className={`flex h-12 w-12 items-center justify-center rounded-xl border-[0.5px] transition-colors focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 ${
              locked
                ? 'border-amber/50 bg-amber/[0.08] text-amber'
                : pickerOpen
                  ? 'border-input-border bg-surface-subtle text-ink'
                  : 'border-subtle-border bg-surface-subtle text-ink-label hover:text-ink'
            }`}
          >
            <FolderIcon />
          </button>
        </div>
        {/* Image-attach button — opens the hidden native file picker. */}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
          aria-label="Attach a screenshot or image"
          title="Attach a screenshot or image (or paste / drop one)"
          className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border-[0.5px] transition-colors focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 ${
            attachment
              ? 'border-ink/30 bg-ink/[0.06] text-ink'
              : 'border-subtle-border bg-surface-subtle text-ink-label hover:text-ink'
          }`}
        >
          <PaperclipIcon />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          onChange={handleFileInputChange}
        />
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          disabled={busy}
          placeholder={
            busy
              ? 'Verlox is working…'
              : attachment
                ? 'Add a note about the image…'
                : 'Ask Verlox…'
          }
          rows={1}
          className={`block w-full flex-1 resize-none rounded-2xl border-[0.5px] bg-surface-subtle px-4 py-3 text-[14px] leading-6 text-ink placeholder:text-ink-hint focus:outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
            isDraggingImage
              ? 'border-ink/40 ring-2 ring-ink/10'
              : 'border-subtle-border focus:border-input-border'
          }`}
        />
        {/* Send button — a dark circle. Disabled (and the whole row
            locked) while the AI is working; the user stops via the
            existing stop control on the in-flight turn. */}
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

// Helpers + glyphs ----------------------------------------------------

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error('Unexpected reader result'));
    reader.onerror = () => reject(reader.error ?? new Error('Read failed'));
    reader.readAsDataURL(file);
  });
}


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

function PaperclipIcon() {
  // Classic paperclip — the universally-read "attach" affordance.
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
      <path d="M14.5 8.5l-6.2 6.2a3 3 0 1 1-4.3-4.3L9.7 4.7a2 2 0 1 1 2.8 2.8L7 13" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg
      viewBox="0 0 12 12"
      className="h-3 w-3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <line x1="2" y1="2" x2="10" y2="10" />
      <line x1="10" y1="2" x2="2" y2="10" />
    </svg>
  );
}
