export const IpcChannels = {
  Ping: 'ping',
  CwdGet: 'cwd:get',
  CwdSet: 'cwd:set',
  // Directory browsing for the path picker (lock-to-folder/file UI).
  DirList: 'dir:list',
  // Native OS folder chooser (used by the agent panel to set its working
  // folder). Returns the chosen absolute path, or null if cancelled.
  DialogPickDirectory: 'dialog:pick-directory',
  CommandStart: 'command:start',
  CommandStop: 'command:stop',
  CommandOutput: 'command:output',
  CommandExit: 'command:exit',

  // Real terminal (PTY). Unlike Command* (discrete one-shot spawns with
  // ANSI stripped), these back a full interactive terminal tab: a live
  // pseudo-terminal the user types into directly and that can host
  // interactive CLIs (Claude Code, vim, REPLs). Renderer drives an
  // xterm.js front-end; main owns the node-pty process.
  PtyStart: 'pty:start',
  PtyInput: 'pty:input',
  PtyResize: 'pty:resize',
  PtyKill: 'pty:kill',
  PtyData: 'pty:data',
  PtyExit: 'pty:exit',

  // Restore points (the recovery safety net). The renderer drives a manual
  // timeline: choose a folder to protect, checkpoint on demand, and rewind
  // the whole folder back to an earlier point. Main owns a hidden per-folder
  // git vault (see snapshot-manager.ts) so the project itself is untouched.
  SnapshotStatus: 'snapshot:status',
  SnapshotPickFolder: 'snapshot:pick-folder',
  SnapshotSetFolder: 'snapshot:set-folder',
  SnapshotCheckpoint: 'snapshot:checkpoint',
  SnapshotList: 'snapshot:list',
  SnapshotRestore: 'snapshot:restore',
  SnapshotSetAuto: 'snapshot:set-auto',

  // Agent Mode. Plan the next step toward a goal, and manage the optional
  // own-key + auto-approve settings. The AI key never crosses back over IPC
  // (only whether one is saved).
  AgentPlanStep: 'agent:plan-step',
  SettingsGet: 'settings:get',
  SettingsAddProvider: 'settings:add-provider',
  SettingsRemoveProvider: 'settings:remove-provider',
  SettingsSetAutoApprove: 'settings:set-auto-approve',

  // Auth
  AuthSignUp: 'auth:sign-up',
  AuthSignIn: 'auth:sign-in',
  AuthSignOut: 'auth:sign-out',
  AuthGetCurrentUser: 'auth:get-current-user',

  // Environment
  EnvGet: 'env:get',
  // App version (from package.json, via app.getVersion()).
  AppGetVersion: 'app:get-version',

  // System shell
  ShellOpenExternal: 'shell:open-external',

  // Auto-update (electron-updater). Main broadcasts status changes;
  // renderer can request a manual check or trigger the install.
  UpdateStatusChanged: 'update:status-changed',
  UpdateCheck: 'update:check',
  UpdateInstall: 'update:install',

  // Billing (Stripe). Renderer asks main to start a checkout / open the
  // customer portal; main fetches the URL from the backend and opens it
  // in the user's default browser.
  BillingCheckout: 'billing:checkout',
  BillingPortal: 'billing:portal',
  BillingStatus: 'billing:status',

  // Backend AI
  BackendPlanTurn: 'backend:plan-turn',
  BackendGetUsage: 'backend:get-usage',
  BackendSynthesizeStart: 'backend:synthesize:start',
  BackendSynthesizeCancel: 'backend:synthesize:cancel',
  BackendSynthesizeEvent: 'backend:synthesize:event',
  BackendGenerateDiagram: 'backend:generate-diagram',
} as const;

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels];
