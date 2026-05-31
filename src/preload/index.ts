import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IpcChannels } from '@shared/ipc-channels';
import type {
  CommandExitEvent,
  CommandOutputEvent,
  CommandStartPayload,
  DiagramRequest,
  IpcApi,
  SynthesizeEvent,
  SynthesizeRequest,
  TurnInput,
  UpdateStatus,
} from '@shared/types';

const api: IpcApi = {
  ping: () => ipcRenderer.invoke(IpcChannels.Ping),
  getCwd: () => ipcRenderer.invoke(IpcChannels.CwdGet),
  setCwd: (path) => ipcRenderer.invoke(IpcChannels.CwdSet, path),
  listDir: (path: string) => ipcRenderer.invoke(IpcChannels.DirList, path),

  startCommand: (payload: CommandStartPayload) =>
    ipcRenderer.send(IpcChannels.CommandStart, payload),

  stopCommand: (id: string) => ipcRenderer.send(IpcChannels.CommandStop, id),

  onCommandOutput: (cb) => {
    const listener = (_e: IpcRendererEvent, payload: CommandOutputEvent) => cb(payload);
    ipcRenderer.on(IpcChannels.CommandOutput, listener);
    return () => ipcRenderer.removeListener(IpcChannels.CommandOutput, listener);
  },

  onCommandExit: (cb) => {
    const listener = (_e: IpcRendererEvent, payload: CommandExitEvent) => cb(payload);
    ipcRenderer.on(IpcChannels.CommandExit, listener);
    return () => ipcRenderer.removeListener(IpcChannels.CommandExit, listener);
  },

  signUp: (credentials) => ipcRenderer.invoke(IpcChannels.AuthSignUp, credentials),
  signIn: (credentials) => ipcRenderer.invoke(IpcChannels.AuthSignIn, credentials),
  signOut: () => ipcRenderer.invoke(IpcChannels.AuthSignOut),
  getCurrentUser: () => ipcRenderer.invoke(IpcChannels.AuthGetCurrentUser),

  getEnvironment: () => ipcRenderer.invoke(IpcChannels.EnvGet),

  getAppVersion: () => ipcRenderer.invoke(IpcChannels.AppGetVersion),

  openExternal: (url: string) =>
    ipcRenderer.send(IpcChannels.ShellOpenExternal, url),

  onUpdateStatus: (cb) => {
    const listener = (_e: IpcRendererEvent, status: UpdateStatus) => cb(status);
    ipcRenderer.on(IpcChannels.UpdateStatusChanged, listener);
    return () =>
      ipcRenderer.removeListener(IpcChannels.UpdateStatusChanged, listener);
  },
  installUpdate: () => ipcRenderer.send(IpcChannels.UpdateInstall),
  checkForUpdates: () => ipcRenderer.send(IpcChannels.UpdateCheck),

  planTurn: (input: TurnInput) =>
    ipcRenderer.invoke(IpcChannels.BackendPlanTurn, input),

  getUsage: () => ipcRenderer.invoke(IpcChannels.BackendGetUsage),

  startCheckout: () => ipcRenderer.invoke(IpcChannels.BillingCheckout),
  openBillingPortal: () => ipcRenderer.invoke(IpcChannels.BillingPortal),
  getBillingStatus: () => ipcRenderer.invoke(IpcChannels.BillingStatus),

  synthesizeStart: (request: SynthesizeRequest) =>
    ipcRenderer.send(IpcChannels.BackendSynthesizeStart, request),

  synthesizeCancel: (messageId: string) =>
    ipcRenderer.send(IpcChannels.BackendSynthesizeCancel, messageId),

  onSynthesizeEvent: (cb) => {
    const listener = (_e: IpcRendererEvent, event: SynthesizeEvent) => cb(event);
    ipcRenderer.on(IpcChannels.BackendSynthesizeEvent, listener);
    return () =>
      ipcRenderer.removeListener(IpcChannels.BackendSynthesizeEvent, listener);
  },

  generateDiagram: (request: DiagramRequest) =>
    ipcRenderer.invoke(IpcChannels.BackendGenerateDiagram, request),
};

contextBridge.exposeInMainWorld('api', api);
