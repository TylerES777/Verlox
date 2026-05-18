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

  // Backend AI
  BackendPlanTurn: 'backend:plan-turn',
  BackendSynthesizeStart: 'backend:synthesize:start',
  BackendSynthesizeCancel: 'backend:synthesize:cancel',
  BackendSynthesizeEvent: 'backend:synthesize:event',
} as const;

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels];
