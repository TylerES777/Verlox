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

// Directory browsing -------------------------------------------------------
// Backs the path picker (the folder-icon button in the input). The
// renderer has no filesystem access of its own, so the main process
// lists directory contents on request.

export interface DirEntry {
  name: string;
  // Absolute path of this entry. The picker drills / selects using this
  // directly so the renderer never has to do path math.
  path: string;
  isDirectory: boolean;
}

export interface DirListing {
  // Absolute path that was listed. For a request with an empty/'~' path
  // this resolves to the user's home directory.
  path: string;
  // Absolute parent path, or null when `path` is a filesystem root.
  parent: string | null;
  // Folders first, then files; each group alphabetical, case-insensitive.
  entries: DirEntry[];
  // Non-null when the listing failed (path missing, permission denied).
  // On error `entries` is empty and `path` echoes the requested path.
  error: string | null;
}

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
  // Absolute path of the file the conversation is locked to, or null.
  // When set, the backend reads the user's requests as being about this
  // file. null when locked to a folder (or nothing).
  focusedFile: string | null;
}

// One earlier turn in the conversation, compacted for the backend.
// Phase 5 Chunk 1 (Memory): the renderer builds these from the tab's
// prior messages so the AI sees the thread — what was asked and what
// happened — instead of treating every turn as amnesiac.
export interface TurnHistoryEntry {
  userInput: string;
  // Compact description of the outcome: commands run + (truncated)
  // output, or the AI's reply, or a cd / error / cancellation note.
  outcome: string;
}

export interface TurnInput {
  userInput: string;
  context: TurnContext;
  planMode: boolean;
  // Earlier turns in this conversation tab, oldest first. Empty for the
  // first turn of a conversation.
  history: TurnHistoryEntry[];
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
  // Built-in file-listing intent. When true, Vorlox renders the folder
  // contents using its own directory API — no shell command runs. steps
  // is empty in this case (like a cd turn).
  isListCommand: boolean;
  // Absolute or "~/"-prefixed path to list, or null for the current
  // working directory. Only meaningful when isListCommand is true.
  listTarget: string | null;
  // Dedicated structured renderer for the planned command's output.
  // When set, the desktop client parses the step's live output and
  // renders a purpose-built panel instead of the monospace block.
  outputUi:
    | 'ping'
    | 'git-status'
    | 'single-value'
    | 'top-processes'
    | 'git-log'
    | 'git-diff'
    | 'env'
    | 'network'
    | 'listening-ports'
    | null;
  footgunDetected: false | { reason: string };
}

export interface TurnSuccessWire {
  ok: true;
  data: PlanResponse;
}

export type TurnResultWire = TurnSuccessWire | BackendErrorWire;

// /api/diagram — visual diagram generation ---------------------------------

export type DiagramColor = 'green' | 'blue' | 'amber' | 'red' | 'neutral';

export interface DiagramNode {
  label: string;
  // Backend returns null for absent values (JSON Schema struggles with
  // undefined). Renderer treats null and absent the same.
  sub: string | null;
  color: DiagramColor | null;
}

export interface DiagramGroup {
  title: string | null;
  subtitle: string | null;
  layout: 'row' | 'column';
  nodes: DiagramNode[];
  arrows: boolean | null;
  caption: string | null;
}

export interface DiagramSchema {
  groups: DiagramGroup[];
}

export interface DiagramRequest {
  // The user's original prompt (the message intent / question).
  userInput: string;
  // The AI's full prose answer that should be re-shaped into a diagram.
  proseResponse: string;
}

export interface DiagramSuccessWire {
  ok: true;
  data: DiagramSchema;
}

export type DiagramResultWire = DiagramSuccessWire | BackendErrorWire;

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
  // Lists a directory for the path picker. Pass an empty string or '~'
  // to list the user's home directory. Always resolves (never rejects) —
  // failures come back as a DirListing with a non-null `error`.
  listDir: (path: string) => Promise<DirListing>;
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

  // Convert a prose answer into a visual Diagram schema. Synchronous —
  // the toggle is per-response and the result is cached on the message
  // after the first call, so streaming isn't needed.
  generateDiagram: (request: DiagramRequest) => Promise<DiagramResultWire>;
}

declare global {
  interface Window {
    api: IpcApi;
  }
}
