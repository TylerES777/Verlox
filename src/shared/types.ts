export interface CwdInfo {
  absolute: string;
  display: string;
}

export interface IpcApi {
  ping: () => Promise<'pong'>;
  getCwd: () => Promise<CwdInfo>;
  setCwd: (path: string) => Promise<CwdInfo>;
}

declare global {
  interface Window {
    api: IpcApi;
  }
}
