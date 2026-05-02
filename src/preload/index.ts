import { contextBridge, ipcRenderer } from 'electron';
import { IpcChannels } from '@shared/ipc-channels';
import type { IpcApi } from '@shared/types';

const api: IpcApi = {
  ping: () => ipcRenderer.invoke(IpcChannels.Ping),
  getCwd: () => ipcRenderer.invoke(IpcChannels.CwdGet),
  setCwd: (path) => ipcRenderer.invoke(IpcChannels.CwdSet, path),
};

contextBridge.exposeInMainWorld('api', api);
