import { useCallback, useEffect, useState } from 'react';
import type { CwdInfo } from '@shared/types';

export function useCwd(): {
  cwd: CwdInfo | null;
  setCwd: (path: string) => Promise<void>;
} {
  const [cwd, setCwdState] = useState<CwdInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.api
      .getCwd()
      .then((info) => {
        if (!cancelled) setCwdState(info);
      })
      .catch((err) => console.error('getCwd failed:', err));
    return () => {
      cancelled = true;
    };
  }, []);

  const setCwd = useCallback(async (path: string) => {
    const next = await window.api.setCwd(path);
    setCwdState(next);
  }, []);

  return { cwd, setCwd };
}
