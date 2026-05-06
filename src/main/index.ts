import { app, BrowserWindow, ipcMain, Menu, shell } from 'electron';
import { join } from 'node:path';
import { IpcChannels } from '@shared/ipc-channels';
import type { AuthCredentials, CommandStartPayload } from '@shared/types';
import { getCwd, initCwd, setCwd } from './store';
import { killAllSync, startCommand, stopCommand } from './command-runner';
import * as backend from './backend-client';

Menu.setApplicationMenu(null);

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    center: true,
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

ipcMain.on(IpcChannels.CommandStart, (event, payload: CommandStartPayload) => {
  startCommand(event.sender, payload.id, payload.command);
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
