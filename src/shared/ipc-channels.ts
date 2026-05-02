export const IpcChannels = {
  Ping: 'ping',
  CwdGet: 'cwd:get',
  CwdSet: 'cwd:set',
} as const;

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels];
