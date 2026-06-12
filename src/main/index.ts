import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { isAbsolute, join, resolve } from 'node:path';
import { promises as nodeFs } from 'node:fs';
import { IpcChannels } from '@shared/ipc-channels';
import type {
  AddProviderInput,
  AddProviderResult,
  AgentPlanInput,
  AuthCredentials,
  BillingActionResult,
  CommandStartPayload,
  DiagramRequest,
  PtyInputPayload,
  PreviewFileResult,
  TimelineRecordInput,
  PtyResizePayload,
  PtyStartPayload,
  SettingsInfo,
  SqlConnectConfig,
  SynthesizeEvent,
  SynthesizeRequest,
  TurnInput,
  VaultCaptureInput,
  VaultRetention,
} from '@shared/types';
import { getCwd, initCwd, setCwd } from './store';
import { listDirectory } from './directory';
import { killAllSync, startCommand, stopCommand } from './command-runner';
import {
  killAllPtys,
  ptyInput,
  ptyKill,
  ptyResize,
  ptyStart,
} from './pty-manager';
import {
  checkpoint as snapshotCheckpoint,
  ensureProtected,
  getStatus as snapshotStatus,
  listSnapshots,
  pickFolder as snapshotPickFolder,
  redo as snapshotRedo,
  restore as snapshotRestore,
  setAuto as snapshotSetAuto,
  setGuardedFolder,
  undo as snapshotUndo,
} from './snapshot-manager';
import {
  sqlConnect,
  sqlDisconnect,
  sqlDisconnectAll,
  sqlQuery,
} from './sql-manager';
import { planAll, planStep, verifyProvider } from './agent';
import { probeOllama } from './ollama';
import {
  ensureReady as ensureLocalModelReady,
  getStatus as getLocalModelStatus,
  subscribe as subscribeLocalModel,
  shutdown as shutdownLocalModel,
  cancel as cancelLocalModel,
} from './local-model';
import {
  captureDeletions,
  forgetVault,
  listVault,
  restoreVault,
  setVaultRetention,
} from './vault-manager';
import { clearTimeline, listTimeline, recordTimeline } from './timeline-manager';
import {
  addProvider,
  getAutoApprove,
  getPermissions,
  listProviders,
  removeProvider,
  setAutoApprove,
  setPermission,
} from './settings-store';
import type { Capability, PermissionRule } from '@shared/risk';
import * as backend from './backend-client';
import { getEnvironment } from './detect-environment';
import {
  checkForUpdatesNow,
  initUpdater,
  installUpdate,
  subscribeToUpdates,
} from './updater';

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
    title: 'Verlox',
    // Window icon. In dev (running the raw Electron binary) this replaces
    // the default Electron atom with the Verlox mark. In a packaged build
    // the executable's own icon (baked in by electron-builder from
    // build/icon.ico) drives the taskbar, so this is only needed for dev;
    // the file lives outside the asar, hence the dev-only guard.
    icon: process.env.ELECTRON_RENDERER_URL
      ? join(__dirname, '../../build/icon.png')
      : undefined,
    // Hide the OS title bar (the black strip) but keep the native
    // minimize/maximize/close controls as an overlay coloured to match
    // the white app surface. The renderer provides a draggable strip
    // where this bar used to be (see ConversationsShell).
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      // The app surface is pure white now (the chat panel sits under this
      // corner), so the native controls blend into it instead of floating
      // on a grey block.
      color: '#FFFFFF',
      symbolColor: '#3A3A3A',
      height: 40,
    },
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

  // Subscribe this window to auto-update status broadcasts so the
  // Update button reflects the current state (and the latest on mount).
  subscribeToUpdates(win.webContents);

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
ipcMain.handle(IpcChannels.DialogPickDirectory, async (): Promise<string | null> => {
  const parent = BrowserWindow.getFocusedWindow() ?? undefined;
  const opts = {
    title: 'Choose a folder for the agent to work in',
    properties: ['openDirectory' as const],
  };
  const result = parent
    ? await dialog.showOpenDialog(parent, opts)
    : await dialog.showOpenDialog(opts);
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.on(IpcChannels.CommandStart, (event, payload: CommandStartPayload) => {
  // Auto-protect the folder the app is about to change, so restore points
  // happen on their own — the user never picks a folder to protect.
  // Fire-and-forget and idempotent: a no-op once this folder is guarded.
  void ensureProtected(payload.cwd);
  startCommand(
    event.sender,
    payload.id,
    payload.command,
    payload.cwd,
    payload.shell,
  );
});

ipcMain.on(IpcChannels.CommandStop, (_event, id: string) => {
  stopCommand(id);
});

// --- Real terminal (PTY) --------------------------------------------------
// Back the interactive terminal tab. The renderer sends raw keystrokes and
// viewport sizes; main owns the node-pty child and streams its output back.

ipcMain.on(IpcChannels.PtyStart, (event, payload: PtyStartPayload) => {
  ptyStart(event.sender, payload.id, payload.cwd, payload.cols, payload.rows);
});

ipcMain.on(IpcChannels.PtyInput, (_event, payload: PtyInputPayload) => {
  ptyInput(payload.id, payload.data);
});

ipcMain.on(IpcChannels.PtyResize, (_event, payload: PtyResizePayload) => {
  ptyResize(payload.id, payload.cols, payload.rows);
});

ipcMain.on(IpcChannels.PtyKill, (_event, id: string) => {
  ptyKill(id);
});

// --- Restore points (recovery safety net) ---------------------------------
// Main owns a hidden per-folder git vault that records the guarded folder's
// history; the renderer drives a manual timeline (Phase 1) over these.

ipcMain.handle(IpcChannels.SnapshotStatus, () => snapshotStatus());
ipcMain.handle(IpcChannels.SnapshotPickFolder, () => snapshotPickFolder());
ipcMain.handle(IpcChannels.SnapshotSetFolder, (_e, folder: string) =>
  setGuardedFolder(folder),
);
ipcMain.handle(IpcChannels.SnapshotCheckpoint, (_e, label?: string) =>
  snapshotCheckpoint(label),
);
ipcMain.handle(IpcChannels.SnapshotList, () => listSnapshots());
ipcMain.handle(IpcChannels.SnapshotRestore, (_e, id: string) =>
  snapshotRestore(id),
);
ipcMain.handle(IpcChannels.SnapshotSetAuto, (_e, enabled: boolean) =>
  snapshotSetAuto(enabled),
);
ipcMain.handle(IpcChannels.SnapshotUndo, () => snapshotUndo());
ipcMain.handle(IpcChannels.SnapshotRedo, () => snapshotRedo());

// --- SQL console ----------------------------------------------------------
// Main owns the database connection (node-postgres), keyed by tab id, so the
// renderer never holds the credential past the connect call.

ipcMain.handle(IpcChannels.SqlConnect, (_e, id: string, config: SqlConnectConfig) =>
  sqlConnect(id, config),
);
ipcMain.handle(IpcChannels.SqlQuery, (_e, id: string, sql: string) =>
  sqlQuery(id, sql),
);
ipcMain.handle(IpcChannels.SqlDisconnect, (_e, id: string) => sqlDisconnect(id));

// Close any open database connections when the app is quitting.
app.on('before-quit', () => {
  void sqlDisconnectAll();
});

// --- Agent Mode -----------------------------------------------------------
// Plan the next step toward a goal (routed to the user's own key when set,
// else the Verlox backend), and manage the agent settings. The AI key is
// stored encrypted in main and never returned over IPC.

function settingsInfo(): SettingsInfo {
  return {
    providers: listProviders(),
    autoApproveReadonly: getAutoApprove(),
    permissions: getPermissions(),
  };
}

ipcMain.handle(IpcChannels.AgentPlanStep, (_e, input: AgentPlanInput) =>
  planStep(input),
);
ipcMain.handle(IpcChannels.AgentPlanAll, (_e, input: AgentPlanInput) =>
  planAll(input),
);
// Probe the local Ollama runtime so the renderer can list pulled models.
ipcMain.handle(IpcChannels.OllamaList, () => probeOllama());

// Bundled local model lifecycle (llama.cpp 3B).
ipcMain.handle(IpcChannels.LocalModelStatus, () => getLocalModelStatus());
ipcMain.handle(IpcChannels.LocalModelEnsure, async () => {
  // Fire and forget — the renderer learns of progress via the status stream.
  // Swallow rejections here so an IPC call doesn't surface an unhandled
  // promise; the error already flows through setState({kind:'error'}).
  try {
    await ensureLocalModelReady();
  } catch {
    /* status broadcast already carries the error */
  }
});
ipcMain.handle(IpcChannels.LocalModelCancel, () => cancelLocalModel());
// Each window subscribes once at mount; main forwards every state change.
app.on('browser-window-created', (_e, win) => {
  const unsub = subscribeLocalModel((s) => {
    if (!win.isDestroyed()) win.webContents.send(IpcChannels.LocalModelStatusChanged, s);
  });
  win.on('closed', unsub);
});
ipcMain.handle(IpcChannels.SettingsGet, (): SettingsInfo => settingsInfo());
ipcMain.handle(
  IpcChannels.SettingsAddProvider,
  async (_e, input: AddProviderInput): Promise<AddProviderResult> => {
    const name = (input.name || '').trim();
    const baseUrl = (input.baseUrl || '').trim();
    const model = (input.model || '').trim();
    const key = (input.key || '').trim();
    if (!name || !baseUrl || !model || !key) {
      return {
        ok: false,
        error: 'Fill in name, endpoint URL, model, and key.',
        settings: settingsInfo(),
      };
    }
    try {
      // Verify (a tiny test call) before saving, so a bad setup is never stored.
      await verifyProvider({ ...input, name, baseUrl, model, key });
      addProvider({ name, format: input.format, baseUrl, model }, key);
      return { ok: true, settings: settingsInfo() };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        settings: settingsInfo(),
      };
    }
  },
);
ipcMain.handle(
  IpcChannels.SettingsRemoveProvider,
  (_e, id: string): SettingsInfo => {
    removeProvider(id);
    return settingsInfo();
  },
);
ipcMain.handle(
  IpcChannels.SettingsSetAutoApprove,
  (_e, enabled: boolean): SettingsInfo => {
    setAutoApprove(!!enabled);
    return settingsInfo();
  },
);
ipcMain.handle(
  IpcChannels.SettingsSetPermission,
  (_e, capability: Capability, rule: PermissionRule): SettingsInfo => {
    setPermission(capability, rule);
    return settingsInfo();
  },
);

// Recovery Vault.
ipcMain.handle(IpcChannels.VaultCapture, (_e, input: VaultCaptureInput) =>
  captureDeletions(input),
);
ipcMain.handle(IpcChannels.VaultList, () => listVault());
ipcMain.handle(IpcChannels.VaultRestore, (_e, id: string) => restoreVault(id));
ipcMain.handle(IpcChannels.VaultForget, (_e, id: string) => forgetVault(id));
ipcMain.handle(
  IpcChannels.VaultSetRetention,
  (_e, id: string, retention: VaultRetention) => setVaultRetention(id, retention),
);

// Read a file's current contents for the AI-diff "before" side.
const PREVIEW_CAP = 60_000; // chars
ipcMain.handle(
  IpcChannels.PreviewFile,
  async (_e, p: string, cwd: string): Promise<PreviewFileResult> => {
    try {
      const abs = isAbsolute(p) ? p : resolve(cwd || '.', p);
      const stat = await nodeFs.stat(abs);
      if (!stat.isFile()) return { exists: false, content: '', tooLarge: false };
      const buf = await nodeFs.readFile(abs, 'utf8');
      return {
        exists: true,
        content: buf.length > PREVIEW_CAP ? buf.slice(0, PREVIEW_CAP) : buf,
        tooLarge: buf.length > PREVIEW_CAP,
      };
    } catch {
      // Missing file → a brand-new file (no "before").
      return { exists: false, content: '', tooLarge: false };
    }
  },
);

// Timeline replay.
ipcMain.handle(IpcChannels.TimelineRecord, (_e, input: TimelineRecordInput) =>
  recordTimeline(input),
);
ipcMain.handle(IpcChannels.TimelineList, () => listTimeline());
ipcMain.handle(IpcChannels.TimelineClear, () => clearTimeline());

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
ipcMain.handle(IpcChannels.AppGetVersion, () => app.getVersion());

ipcMain.on(IpcChannels.ShellOpenExternal, (_event, url: string) => {
  // Only http(s) — refuse file://, javascript:, etc. Defensive guard
  // because the URL comes from parsed stdout of arbitrary processes.
  if (typeof url !== 'string') return;
  if (!/^https?:\/\//.test(url)) return;
  void shell.openExternal(url);
});

// --- Billing (Stripe) -----------------------------------------------------
// Fetch a checkout / portal URL from the backend (token lives in main),
// then open it in the user's default browser. The renderer only learns
// ok/error — the URL never crosses into it.

ipcMain.handle(IpcChannels.BillingCheckout, async (): Promise<BillingActionResult> => {
  const res = await backend.createCheckoutSession();
  if (res.ok && res.url) {
    void shell.openExternal(res.url);
    return { ok: true, alreadySubscribed: res.alreadySubscribed };
  }
  return { ok: false, error: res.error };
});

ipcMain.handle(IpcChannels.BillingPortal, async (): Promise<BillingActionResult> => {
  const res = await backend.createPortalSession();
  if (res.ok && res.url) {
    void shell.openExternal(res.url);
    return { ok: true };
  }
  return { ok: false, error: res.error };
});

ipcMain.handle(IpcChannels.BillingStatus, () => backend.getBillingStatus());

// --- Auto-update ----------------------------------------------------------
ipcMain.on(IpcChannels.UpdateInstall, () => installUpdate());
ipcMain.on(IpcChannels.UpdateCheck, () => checkForUpdatesNow());

// --- AI handlers ----------------------------------------------------------

ipcMain.handle(IpcChannels.BackendPlanTurn, (_e, input: TurnInput) =>
  backend.planTurn(input),
);

ipcMain.handle(IpcChannels.BackendGetUsage, () => backend.getUsage());

ipcMain.handle(IpcChannels.BackendGenerateDiagram, (_e, request: DiagramRequest) =>
  backend.generateDiagram(request),
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
        model: request.model,
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
  // Kick off the auto-update check (no-op in dev / unpackaged). The
  // window is already subscribed to status broadcasts via createWindow.
  initUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  killAllSync();
  killAllPtys();
  // Tear down the bundled llama.cpp server so it doesn't linger in Task Manager.
  shutdownLocalModel();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
