import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IpcChannels } from '@shared/ipc-channels';
import type {
  CommandExitEvent,
  CommandOutputEvent,
  CommandStartPayload,
  IpcApi,
  SynthesizeEvent,
  SynthesizeRequest,
  TurnInput,
} from '@shared/types';

const api: IpcApi = {
  ping: () => ipcRenderer.invoke(IpcChannels.Ping),
  getCwd: () => ipcRenderer.invoke(IpcChannels.CwdGet),
  setCwd: (path) => ipcRenderer.invoke(IpcChannels.CwdSet, path),

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

  planTurn: (input: TurnInput) =>
    ipcRenderer.invoke(IpcChannels.BackendPlanTurn, input),

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
};

contextBridge.exposeInMainWorld('api', api);
