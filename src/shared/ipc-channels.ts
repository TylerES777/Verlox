export const IpcChannels = {
  Ping: 'ping',
  CwdGet: 'cwd:get',
  CwdSet: 'cwd:set',
  CommandStart: 'command:start',
  CommandStop: 'command:stop',
  CommandOutput: 'command:output',
  CommandExit: 'command:exit',
} as const;

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels];
