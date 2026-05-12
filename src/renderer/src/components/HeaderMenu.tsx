import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';

interface HeaderMenuProps {
  // Chunk 3 session-wide peek preference. Owned by ConversationScreen
  // (single source of truth, mirrored into useCommands as the seed for
  // new turns). HeaderMenu just renders the checkbox and reports back
  // when the user flips it.
  peekDefault: boolean;
  onPeekDefaultChange: (value: boolean) => void;
}

export function HeaderMenu({ peekDefault, onPeekDefaultChange }: HeaderMenuProps) {
  const { user, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  if (!user) return null;

  const initial = (user.email[0] ?? '?').toUpperCase();

  async function handleSignOut() {
    setOpen(false);
    await signOut();
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Account menu"
        aria-expanded={open}
        className="flex h-7 w-7 items-center justify-center rounded-full bg-[#F4F4F5] text-[12px] font-medium text-ink-label hover:bg-subtle-border focus:outline-none"
      >
        {initial}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-10 mt-2 w-[240px] overflow-hidden rounded-xl border-[0.5px] border-[rgba(0,0,0,0.08)] bg-card shadow-popover">
          <div className="break-all px-3 pb-2 pt-3 text-[13px] text-ink-label">
            {user.email}
          </div>
          <div className="border-t-[0.5px] border-hairline" />
          {/* Preferences row — Chunk 3 session-wide peek default. The
              entire row is the click target so users don't have to hit
              the small native checkbox. The checkbox is decorative
              (driven by peekDefault) and uses accent-amber to colour
              the check glyph in line with our amber accent. */}
          <label className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-[13px] text-ink hover:bg-surface-subtle">
            <input
              type="checkbox"
              checked={peekDefault}
              onChange={(e) => onPeekDefaultChange(e.target.checked)}
              className="h-3.5 w-3.5 cursor-pointer accent-amber"
            />
            <span>Always show commands</span>
          </label>
          <div className="border-t-[0.5px] border-hairline" />
          <button
            type="button"
            onClick={handleSignOut}
            className="block w-full px-3 py-2 text-left text-[14px] text-ink hover:bg-surface-subtle focus:outline-none"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
