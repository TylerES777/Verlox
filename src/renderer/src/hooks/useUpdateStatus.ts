import { useEffect, useState } from 'react';
import type { UpdateStatus } from '@shared/types';

// Subscribes to main-process auto-update status broadcasts. The main
// process is the source of truth (it owns electron-updater); the
// renderer just reflects the latest status to drive the Update button.
// Emits the current status immediately on subscribe, so the button is
// correct on first render.
export function useUpdateStatus(): UpdateStatus {
  const [status, setStatus] = useState<UpdateStatus>({
    state: 'idle',
    version: null,
    percent: null,
  });
  useEffect(() => {
    const off = window.api.onUpdateStatus(setStatus);
    return off;
  }, []);
  return status;
}
