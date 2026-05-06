export const IpcChannels = {
  Ping: 'ping',
  CwdGet: 'cwd:get',
  CwdSet: 'cwd:set',
  CommandStart: 'command:start',
  CommandStop: 'command:stop',
  CommandOutput: 'command:output',
  CommandExit: 'command:exit',

  // Auth
  AuthSignUp: 'auth:sign-up',
  AuthSignIn: 'auth:sign-in',
  AuthSignOut: 'auth:sign-out',
  AuthGetCurrentUser: 'auth:get-current-user',
} as const;

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels];
