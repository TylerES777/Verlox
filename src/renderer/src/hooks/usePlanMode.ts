import { useCallback, useEffect, useState } from 'react';

// Session-wide "always review the plan before running" preference.
// Persisted to localStorage so it survives reload. Read by useCommands
// as the seed for each new turn: when true, the orchestrator pauses
// after /api/turn and renders the Plan Card instead of executing
// immediately.
//
// Per-turn state lives on the CommandMessage (status flips to
// 'awaiting-confirmation'); this hook is just the seed that decides
// whether to take that branch at all.

const STORAGE_KEY = 'vorlox.planMode';

function readInitial(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function usePlanMode(): {
  planMode: boolean;
  setPlanMode: (value: boolean) => void;
} {
  const [planMode, setState] = useState<boolean>(readInitial);

  // Cross-tab sync — defensive against future multi-window builds.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== STORAGE_KEY) return;
      setState(e.newValue === 'true');
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setPlanMode = useCallback((value: boolean) => {
    setState(value);
    try {
      window.localStorage.setItem(STORAGE_KEY, value ? 'true' : 'false');
    } catch {
      // localStorage unavailable — in-memory state still works.
    }
  }, []);

  return { planMode, setPlanMode };
}
