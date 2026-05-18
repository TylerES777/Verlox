import { app, BrowserWindow, ipcMain, Menu, shell } from 'electron';
import { join } from 'node:path';
import { IpcChannels } from '@shared/ipc-channels';
import type {
  AuthCredentials,
  CommandStartPayload,
  SynthesizeEvent,
  SynthesizeRequest,
  TurnInput,
} from '@shared/types';
import { getCwd, initCwd, setCwd } from './store';
import { listDirectory } from './directory';
import { killAllSync, startCommand, stopCommand } from './command-runner';
import * as backend from './backend-client';
import { getEnvironment } from './detect-environment';

Menu.setApplicationMenu(null);

function createWindow(): void {
  const win = new BrowserWindow({
    // Default size used if the window can't maximize (rare) and as the
    // size the user can shrink to via "restore". Min dimensions enforce
    // a usable layout floor — below 800×600 the card-in-window aesthetic
    // and 580px reading column would crowd against each other.
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Vorlox',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.setMenu(null);

  // Open maximized to match native desktop-app behavior. Users can
  // unmaximize / resize freely (resizable defaults to true on Electron).
  win.maximize();

  // DEV-ONLY: auto-open DevTools detached. We strip our app menu (calm
  // aesthetic), which removes the default View > Toggle DevTools entry
  // and the implicit Ctrl+Shift+I shortcut. Conditional on import.meta.env.DEV
  // so packaged builds never get DevTools.
  if (import.meta.env.DEV) {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  win.on('ready-to-show', () => {
    win.show();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    const target = new URL(url);
    const isDevServer =
      !!process.env.ELECTRON_RENDERER_URL &&
      url.startsWith(process.env.ELECTRON_RENDERER_URL);
    if (!isDevServer && target.origin !== 'null') {
      event.preventDefault();
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

ipcMain.handle(IpcChannels.Ping, (): 'pong' => 'pong');
ipcMain.handle(IpcChannels.CwdGet, () => getCwd());
ipcMain.handle(IpcChannels.CwdSet, (_e, path: string) => setCwd(path));
ipcMain.handle(IpcChannels.DirList, (_e, path: string) => listDirectory(path));

ipcMain.on(IpcChannels.CommandStart, (event, payload: CommandStartPayload) => {
  startCommand(event.sender, payload.id, payload.command, payload.cwd);
});

ipcMain.on(IpcChannels.CommandStop, (_event, id: string) => {
  stopCommand(id);
});

// --- Auth handlers --------------------------------------------------------
// All HTTP calls happen here in the main process. Token is stored in main
// only (encrypted via safeStorage) — never crosses the IPC boundary.

ipcMain.handle(IpcChannels.AuthSignUp, (_e, credentials: AuthCredentials) =>
  backend.signUp(credentials),
);
ipcMain.handle(IpcChannels.AuthSignIn, (_e, credentials: AuthCredentials) =>
  backend.signIn(credentials),
);
ipcMain.handle(IpcChannels.AuthSignOut, () => backend.signOut());
ipcMain.handle(IpcChannels.AuthGetCurrentUser, () => backend.getCurrentUser());

ipcMain.handle(IpcChannels.EnvGet, () => getEnvironment());

// --- AI handlers ----------------------------------------------------------

ipcMain.handle(IpcChannels.BackendPlanTurn, (_e, input: TurnInput) =>
  backend.planTurn(input),
);

// One AbortController per in-flight synthesize stream, keyed by message id.
// Cleaned up when the stream completes or is cancelled.
const synthesizeAborts = new Map<string, AbortController>();

ipcMain.on(IpcChannels.BackendSynthesizeStart, async (event, request: SynthesizeRequest) => {
  const { messageId } = request;

  // If a stream for this message id is already running (rapid retry?),
  // abort the old one before starting fresh.
  synthesizeAborts.get(messageId)?.abort();

  const controller = new AbortController();
  synthesizeAborts.set(messageId, controller);

  try {
    for await (const ev of backend.synthesize(
      {
        planId: request.planId,
        intent: request.intent,
        plan: request.plan,
        executionLog: request.executionLog,
      },
      controller.signal,
    )) {
      if (event.sender.isDestroyed()) break;
      const wire: SynthesizeEvent =
        ev.type === 'delta'
          ? { messageId, type: 'delta', text: ev.text }
          : ev.type === 'done'
            ? { messageId, type: 'done' }
            : { messageId, type: 'error', code: ev.code };
      event.sender.send(IpcChannels.BackendSynthesizeEvent, wire);
      if (ev.type === 'done' || ev.type === 'error') break;
    }
  } finally {
    synthesizeAborts.delete(messageId);
  }
});

ipcMain.on(IpcChannels.BackendSynthesizeCancel, (_event, messageId: string) => {
  synthesizeAborts.get(messageId)?.abort();
});

app.whenReady().then(() => {
  initCwd();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  killAllSync();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
