export interface CwdInfo {
  absolute: string;
  display: string;
}

export type CommandStream = 'stdout' | 'stderr';

export interface CommandStartPayload {
  id: string;
  command: string;
}

export interface CommandOutputEvent {
  id: string;
  stream: CommandStream;
  data: string;
}

export interface CommandExitEvent {
  id: string;
  code: number | null;
  signal: string | null;
}

export type Unsubscribe = () => void;

// Auth ----------------------------------------------------------------------

export interface AuthUser {
  id: string;
  email: string;
}

export interface AuthCredentials {
  email: string;
  password: string;
}

export type AuthErrorCode =
  | 'invalid_credentials'
  | 'email_exists'
  | 'invalid_input'
  | 'network'
  | 'rate_limit'
  | 'server';

export interface AuthErrorWire {
  ok: false;
  code: AuthErrorCode;
  message?: string;
}

export interface AuthSuccessWire {
  ok: true;
  user: AuthUser;
}

export type AuthResult = AuthSuccessWire | AuthErrorWire;

// Environment ---------------------------------------------------------------

export type Platform = 'win32' | 'darwin' | 'linux';
export type Shell = 'powershell' | 'bash' | 'zsh' | 'fish' | 'cmd';

export interface EnvironmentInfo {
  platform: Platform;
  shell: Shell;
}

// AI / backend --------------------------------------------------------------

export interface TranslateContext {
  cwd: string;
  platform: Platform;
  shell: Shell;
}

export interface TranslateRequest {
  userInput: string;
  context: TranslateContext;
}

export interface TranslateResponse {
  intent: string;
  command: string;
  explanation: string;
  requiresConfirmation: boolean;
  confidence: 'high' | 'medium' | 'low';
  isCdCommand: boolean;
  cdTarget: string | null;
}

// Backend errors share the same code shape as auth errors so callers can
// branch with consistent semantics.
export type BackendErrorCode = 'unauthorized' | 'network' | 'rate_limit' | 'server';

export interface BackendErrorWire {
  ok: false;
  code: BackendErrorCode;
}

export interface TranslateSuccessWire {
  ok: true;
  data: TranslateResponse;
}

export type TranslateResultWire = TranslateSuccessWire | BackendErrorWire;

// Explain --------------------------------------------------------------------

export interface ExplainRequest {
  messageId: string;
  command: string;
  output: string;
  exitCode: number;
}

export interface ExplainDeltaEvent {
  messageId: string;
  type: 'delta';
  text: string;
}

export interface ExplainDoneEvent {
  messageId: string;
  type: 'done';
}

export interface ExplainErrorEvent {
  messageId: string;
  type: 'error';
  code: BackendErrorCode;
}

export type ExplainEvent = ExplainDeltaEvent | ExplainDoneEvent | ExplainErrorEvent;

// IPC API -------------------------------------------------------------------

export interface IpcApi {
  ping: () => Promise<'pong'>;
  getCwd: () => Promise<CwdInfo>;
  setCwd: (path: string) => Promise<CwdInfo>;
  startCommand: (payload: CommandStartPayload) => void;
  stopCommand: (id: string) => void;
  onCommandOutput: (cb: (event: CommandOutputEvent) => void) => Unsubscribe;
  onCommandExit: (cb: (event: CommandExitEvent) => void) => Unsubscribe;

  // Auth (token never crosses IPC).
  signUp: (credentials: AuthCredentials) => Promise<AuthResult>;
  signIn: (credentials: AuthCredentials) => Promise<AuthResult>;
  signOut: () => Promise<void>;
  getCurrentUser: () => Promise<AuthUser | null>;

  // Environment (platform + shell). Static for the app's lifetime.
  getEnvironment: () => Promise<EnvironmentInfo>;

  // AI endpoints.
  translate: (request: TranslateRequest) => Promise<TranslateResultWire>;
  explainStart: (request: ExplainRequest) => void;
  explainCancel: (messageId: string) => void;
  onExplainEvent: (cb: (event: ExplainEvent) => void) => Unsubscribe;
}

declare global {
  interface Window {
    api: IpcApi;
  }
}
