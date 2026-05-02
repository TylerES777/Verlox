export interface IpcApi {
  ping: () => Promise<'pong'>;
}

declare global {
  interface Window {
    api: IpcApi;
  }
}
