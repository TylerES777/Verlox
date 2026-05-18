export interface CwdInfo {
  absolute: string;
  display: string;
}

export type CommandStream = 'stdout' | 'stderr';

export interface CommandStartPayload {
  id: string;
  command: string;
  // Absolute directory to spawn the command in. The renderer always
  // resolves this to a real path before sending — for a folderless
  // conversation it passes the user's home directory (the invisible
  // default), so the main process never has to guess.
  cwd: string;
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
  // Absolute path to the user's home directory. Used by the renderer as
  // the invisible working-directory fallback for folderless
  // conversations — the renderer has no os.homedir() of its own.
  homeDir: string;
}

// Backend error code (shared by all backend calls) --------------------------

export type BackendErrorCode = 'unauthorized' | 'network' | 'rate_limit' | 'server';

export interface BackendErrorWire {
  ok: false;
  code: BackendErrorCode;
}

// /api/turn — plan generation -----------------------------------------------

export interface TurnContext {
  cwd: string;
  platform: Platform;
  shell: Shell;
}

export interface TurnInput {
  userInput: string;
  context: TurnContext;
  planMode: boolean;
}

export interface PlanStep {
  title: string;
  command: string;
  description: string;
}

export interface PlanAffects {
  files: string[];
  network: string[];
  permissions: string[];
  readOnly: boolean;
}

export type PlanDisplayMode = 'summary' | 'verbatim';

export interface PlanResponse {
  planId: string;
  intent: string;
  plan: string;
  steps: PlanStep[];
  affects: PlanAffects;
  displayMode: PlanDisplayMode;
  isCdCommand: boolean;
  cdTarget: string | null;
  footgunDetected: false | { reason: string };
}

export interface TurnSuccessWire {
  ok: true;
  data: PlanResponse;
}

export type TurnResultWire = TurnSuccessWire | BackendErrorWire;

// /api/synthesize — response prose stream ------------------------------------

export interface ExecutionLogEntry {
  stepIndex: number;
  command: string;
  output: string;
  exitCode: number | null;
  signal: string | null;
}

export interface SynthesizeRequest {
  messageId: string;       // used to correlate stream events back to this turn
  planId: string;
  intent: string;
  plan: string;
  executionLog: ExecutionLogEntry[];
}

export interface SynthesizeDeltaEvent {
  messageId: string;
  type: 'delta';
  text: string;
}

export interface SynthesizeDoneEvent {
  messageId: string;
  type: 'done';
}

export interface SynthesizeErrorEvent {
  messageId: string;
  type: 'error';
  code: BackendErrorCode;
}

export type SynthesizeEvent =
  | SynthesizeDeltaEvent
  | SynthesizeDoneEvent
  | SynthesizeErrorEvent;

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

  // Plan turn (synchronous JSON; replaces the Phase 3 translate call).
  planTurn: (input: TurnInput) => Promise<TurnResultWire>;

  // Synthesize response prose (SSE stream from backend; replaces explain).
  // Renderer fires synthesizeStart, listens via onSynthesizeEvent. Cancel by
  // messageId if the user navigates away or signs out mid-stream.
  synthesizeStart: (request: SynthesizeRequest) => void;
  synthesizeCancel: (messageId: string) => void;
  onSynthesizeEvent: (cb: (event: SynthesizeEvent) => void) => Unsubscribe;
}

declare global {
  interface Window {
    api: IpcApi;
  }
}
