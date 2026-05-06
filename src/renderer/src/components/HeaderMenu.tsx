import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';

export function HeaderMenu() {
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
        className="flex h-[22px] w-[22px] items-center justify-center rounded-full bg-gray-200 text-[11px] font-medium text-gray-500 hover:bg-gray-300 focus:outline-none"
      >
        {initial}
      </button>
      {open && (
        <div className="absolute right-0 top-[28px] z-10 w-56 rounded-lg border border-gray-200 bg-white py-2 shadow-sm">
          <div className="px-3 pb-2 text-[12px] text-gray-500">{user.email}</div>
          <button
            type="button"
            onClick={handleSignOut}
            className="block w-full px-3 py-1.5 text-left text-[13px] text-gray-700 hover:bg-gray-100 focus:outline-none"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
