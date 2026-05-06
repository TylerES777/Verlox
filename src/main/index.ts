import { app, BrowserWindow, ipcMain, Menu, shell } from 'electron';
import { join } from 'node:path';
import { IpcChannels } from '@shared/ipc-channels';
import type { CommandStartPayload } from '@shared/types';
import { getCwd, initCwd, setCwd } from './store';
import { killAllSync, startCommand, stopCommand } from './command-runner';

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
