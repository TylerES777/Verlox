import { useCallback, useEffect, useState } from 'react';
import type { ModelChoice } from '@shared/types';

// Session-wide model selection (Haiku / Sonnet / Opus). Persisted to
// localStorage so it survives reload, mirroring usePlanMode. Read by
// useCommands as the model sent on each turn's /api/turn + /api/synthesize.
//
// The backend is the source of truth for what a tier is ALLOWED: free
// users are pinned to Haiku server-side regardless of this value, and the
// UI surfaces Sonnet/Opus as locked-until-Pro. So a stale 'opus' stored
// by a since-downgraded user simply gets served Haiku — no client guard
// needed for correctness, only for the visible selection.

const STORAGE_KEY = 'vorlox.modelChoice';

const VALID: ModelChoice[] = ['haiku', 'sonnet', 'opus'];

function isModelChoice(value: string | null): value is ModelChoice {
  return value != null && (VALID as string[]).includes(value);
}

function readInitial(): ModelChoice {
  if (typeof window === 'undefined') return 'sonnet';
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isModelChoice(stored)) return stored;
  } catch {
    // localStorage unavailable — fall through to default.
  }
  // Default to Sonnet: it's the Pro default, and a free user's choice is
  // ignored server-side anyway (always Haiku), so this is a safe seed.
  return 'sonnet';
}

export function useModelChoice(): {
  modelChoice: ModelChoice;
  setModelChoice: (value: ModelChoice) => void;
} {
  const [modelChoice, setState] = useState<ModelChoice>(readInitial);

  // Cross-tab sync — defensive against future multi-window builds.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== STORAGE_KEY) return;
      if (isModelChoice(e.newValue)) setState(e.newValue);
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setModelChoice = useCallback((value: ModelChoice) => {
    setState(value);
    try {
      window.localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // localStorage unavailable — in-memory state still works.
    }
  }, []);

  return { modelChoice, setModelChoice };
}
