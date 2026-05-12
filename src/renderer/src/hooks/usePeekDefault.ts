import { useCallback, useEffect, useState } from 'react';

// Session-wide "always show raw commands" preference. Persisted to
// localStorage so it survives reload. Per-turn peek state is ephemeral
// and lives on the CommandMessage; this hook is just the seed value
// every new turn copies at submit time.
//
// Single boolean — Context would be overkill. Components that read this
// either subscribe via the hook (re-renders on change) or, in the case
// of submitInput which fires once per turn, just reads the latest value
// off a ref/closure when needed.

const STORAGE_KEY = 'vorlox.peekDefault';

function readInitial(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function usePeekDefault(): {
  peekDefault: boolean;
  setPeekDefault: (value: boolean) => void;
} {
  const [peekDefault, setState] = useState<boolean>(readInitial);

  // Cross-tab sync: if another window flips the flag, mirror it here.
  // Electron's renderer is single-window today, so this is mostly
  // defensive — but it's free and keeps behaviour predictable if a
  // future build opens multiple windows.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== STORAGE_KEY) return;
      setState(e.newValue === 'true');
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setPeekDefault = useCallback((value: boolean) => {
    setState(value);
    try {
      window.localStorage.setItem(STORAGE_KEY, value ? 'true' : 'false');
    } catch {
      // localStorage unavailable (quota, sandboxed iframe, etc.) — the
      // in-memory state still works for the rest of this session.
    }
  }, []);

  return { peekDefault, setPeekDefault };
}
