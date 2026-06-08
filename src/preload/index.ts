import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IpcChannels } from '@shared/ipc-channels';
import type {
  CommandExitEvent,
  CommandOutputEvent,
  CommandStartPayload,
  DiagramRequest,
  IpcApi,
  PtyBlockEvent,
  PtyDataEvent,
  PtyExitEvent,
  PtyInputPayload,
  PtyResizePayload,
  PtyStartPayload,
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
  pickDirectory: () => ipcRenderer.invoke(IpcChannels.DialogPickDirectory),

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

  ptyStart: (payload: PtyStartPayload) =>
    ipcRenderer.send(IpcChannels.PtyStart, payload),

  ptyInput: (payload: PtyInputPayload) =>
    ipcRenderer.send(IpcChannels.PtyInput, payload),

  ptyResize: (payload: PtyResizePayload) =>
    ipcRenderer.send(IpcChannels.PtyResize, payload),

  ptyKill: (id: string) => ipcRenderer.send(IpcChannels.PtyKill, id),

  onPtyData: (cb) => {
    const listener = (_e: IpcRendererEvent, payload: PtyDataEvent) => cb(payload);
    ipcRenderer.on(IpcChannels.PtyData, listener);
    return () => ipcRenderer.removeListener(IpcChannels.PtyData, listener);
  },

  onPtyExit: (cb) => {
    const listener = (_e: IpcRendererEvent, payload: PtyExitEvent) => cb(payload);
    ipcRenderer.on(IpcChannels.PtyExit, listener);
    return () => ipcRenderer.removeListener(IpcChannels.PtyExit, listener);
  },

  onPtyBlock: (cb) => {
    const listener = (_e: IpcRendererEvent, payload: PtyBlockEvent) => cb(payload);
    ipcRenderer.on(IpcChannels.PtyBlock, listener);
    return () => ipcRenderer.removeListener(IpcChannels.PtyBlock, listener);
  },

  snapshotStatus: () => ipcRenderer.invoke(IpcChannels.SnapshotStatus),
  snapshotPickFolder: () => ipcRenderer.invoke(IpcChannels.SnapshotPickFolder),
  snapshotSetFolder: (folder: string) =>
    ipcRenderer.invoke(IpcChannels.SnapshotSetFolder, folder),
  snapshotCheckpoint: (label?: string) =>
    ipcRenderer.invoke(IpcChannels.SnapshotCheckpoint, label),
  snapshotList: () => ipcRenderer.invoke(IpcChannels.SnapshotList),
  snapshotRestore: (id: string) =>
    ipcRenderer.invoke(IpcChannels.SnapshotRestore, id),
  snapshotSetAuto: (enabled: boolean) =>
    ipcRenderer.invoke(IpcChannels.SnapshotSetAuto, enabled),
  snapshotUndo: () => ipcRenderer.invoke(IpcChannels.SnapshotUndo),
  snapshotRedo: () => ipcRenderer.invoke(IpcChannels.SnapshotRedo),

  sqlConnect: (id, config) =>
    ipcRenderer.invoke(IpcChannels.SqlConnect, id, config),
  sqlQuery: (id, sql) => ipcRenderer.invoke(IpcChannels.SqlQuery, id, sql),
  sqlDisconnect: (id) => ipcRenderer.invoke(IpcChannels.SqlDisconnect, id),

  agentPlanStep: (input) =>
    ipcRenderer.invoke(IpcChannels.AgentPlanStep, input),
  agentPlanAll: (input) =>
    ipcRenderer.invoke(IpcChannels.AgentPlanAll, input),
  listOllama: () => ipcRenderer.invoke(IpcChannels.OllamaList),
  getLocalModelStatus: () => ipcRenderer.invoke(IpcChannels.LocalModelStatus),
  ensureLocalModel: () => ipcRenderer.invoke(IpcChannels.LocalModelEnsure),
  cancelLocalModel: () => ipcRenderer.invoke(IpcChannels.LocalModelCancel),
  onLocalModelStatus: (cb) => {
    const handler = (_e: unknown, s: unknown) => cb(s as never);
    ipcRenderer.on(IpcChannels.LocalModelStatusChanged, handler);
    return () => ipcRenderer.removeListener(IpcChannels.LocalModelStatusChanged, handler);
  },
  settingsGet: () => ipcRenderer.invoke(IpcChannels.SettingsGet),
  settingsAddProvider: (input) =>
    ipcRenderer.invoke(IpcChannels.SettingsAddProvider, input),
  settingsRemoveProvider: (id) =>
    ipcRenderer.invoke(IpcChannels.SettingsRemoveProvider, id),
  settingsSetAutoApprove: (enabled) =>
    ipcRenderer.invoke(IpcChannels.SettingsSetAutoApprove, enabled),
  settingsSetPermission: (capability, rule) =>
    ipcRenderer.invoke(IpcChannels.SettingsSetPermission, capability, rule),
  vaultCapture: (input) => ipcRenderer.invoke(IpcChannels.VaultCapture, input),
  vaultList: () => ipcRenderer.invoke(IpcChannels.VaultList),
  vaultRestore: (id) => ipcRenderer.invoke(IpcChannels.VaultRestore, id),
  vaultForget: (id) => ipcRenderer.invoke(IpcChannels.VaultForget, id),
  vaultSetRetention: (id, retention) =>
    ipcRenderer.invoke(IpcChannels.VaultSetRetention, id, retention),
  previewFile: (path, cwd) => ipcRenderer.invoke(IpcChannels.PreviewFile, path, cwd),
  timelineRecord: (input) => ipcRenderer.invoke(IpcChannels.TimelineRecord, input),
  timelineList: () => ipcRenderer.invoke(IpcChannels.TimelineList),
  timelineClear: () => ipcRenderer.invoke(IpcChannels.TimelineClear),

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
