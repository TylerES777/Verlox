export const IpcChannels = {
  Ping: 'ping',
  CwdGet: 'cwd:get',
  CwdSet: 'cwd:set',
  // Directory browsing for the path picker (lock-to-folder/file UI).
  DirList: 'dir:list',
  CommandStart: 'command:start',
  CommandStop: 'command:stop',
  CommandOutput: 'command:output',
  CommandExit: 'command:exit',

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
