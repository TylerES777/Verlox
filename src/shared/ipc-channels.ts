export const IpcChannels = {
  Ping: 'ping',
} as const;

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels];
