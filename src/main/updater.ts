import { app, type WebContents } from 'electron';
import electronUpdater from 'electron-updater';
import { IpcChannels } from '@shared/ipc-channels';
import type { UpdateStatus } from '@shared/types';

// Auto-update wiring (electron-updater + GitHub Releases feed). The main
// process owns the update lifecycle and broadcasts a single UpdateStatus
// to every subscribed renderer, which drives the Update button. The
// flow is: check on launch (and every few hours) → if a newer version
// exists, download it automatically → when downloaded, the renderer's
// button appears and stays until the user clicks it, which quits and
// installs.
//
// electron-updater is a CommonJS module; pulling `autoUpdater` off the
// default export keeps the ESM import happy.
const { autoUpdater } = electronUpdater;

// How often to re-check the feed while the app stays open. Six hours is
// gentle — most updates get picked up on the next launch anyway.
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let currentStatus: UpdateStatus = { state: 'idle', version: null, percent: null };
// download-progress events don't carry the version, so remember the last
// version we learned from update-available to keep the status complete.
let pendingVersion: string | null = null;

const subscribers = new Set<WebContents>();

function broadcast(): void {
  for (const wc of subscribers) {
    if (!wc.isDestroyed()) wc.send(IpcChannels.UpdateStatusChanged, currentStatus);
  }
}

function setStatus(next: UpdateStatus): void {
  currentStatus = next;
  broadcast();
}

// Subscribe a renderer to update-status broadcasts. Emits the current
// status immediately so a freshly-mounted renderer reflects reality
// without waiting for the next transition.
export function subscribeToUpdates(wc: WebContents): void {
  subscribers.add(wc);
  wc.on('destroyed', () => subscribers.delete(wc));
  if (!wc.isDestroyed()) wc.send(IpcChannels.UpdateStatusChanged, currentStatus);
}

export function initUpdater(): void {
  // electron-updater only functions in a packaged build with a real
  // release feed. In dev (unpackaged) it throws "dev-app-update.yml not
  // found"; bail so the dev run stays clean. The button simply never
  // appears in dev, which is correct.
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    setStatus({ state: 'checking', version: null, percent: null });
  });
  autoUpdater.on('update-available', (info) => {
    pendingVersion = info.version ?? null;
    setStatus({ state: 'downloading', version: pendingVersion, percent: 0 });
  });
  autoUpdater.on('update-not-available', () => {
    pendingVersion = null;
    setStatus({ state: 'idle', version: null, percent: null });
  });
  autoUpdater.on('download-progress', (p) => {
    setStatus({
      state: 'downloading',
      version: pendingVersion,
      percent: Math.round(p.percent),
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    setStatus({
      state: 'downloaded',
      version: info.version ?? pendingVersion,
      percent: 100,
    });
  });
  autoUpdater.on('error', () => {
    // Keep update failures quiet in the UI — a broken check shouldn't
    // nag the user. Reset to idle so a later successful check can show
    // the button cleanly.
    setStatus({ state: 'error', version: null, percent: null });
  });

  void autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => {
    void autoUpdater.checkForUpdates().catch(() => {});
  }, CHECK_INTERVAL_MS).unref();
}

// Renderer asked to install the downloaded update. Only meaningful once
// state is 'downloaded'; quitAndInstall closes the app, runs the
// installer, and relaunches the new version.
export function installUpdate(): void {
  if (!app.isPackaged) return;
  if (currentStatus.state !== 'downloaded') return;
  autoUpdater.quitAndInstall();
}

// Manual re-check (e.g. a future "check for updates" menu item).
export function checkForUpdatesNow(): void {
  if (!app.isPackaged) return;
  void autoUpdater.checkForUpdates().catch(() => {});
}
