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
  // The user's actual shell, threaded through so the runner can pick
  // the right shell binary (PowerShell vs cmd on Windows; bash vs
  // zsh vs fish on POSIX). Without this, every Windows turn lands in
  // cmd.exe and any PowerShell cmdlet (Get-*, ConvertTo-Csv, etc.)
  // fails on launch.
  shell: Shell;
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

// Compact view of one process the user currently has alive in the
// Running pane. Threaded into every /api/turn so the planner knows
// what's actually running NOW — the conversation history is frozen at
// the moment each turn ran, so it can't tell the AI that the dev server
// it started two turns ago has since been stopped from the Running pane.
export interface RunningProcessSummary {
  command: string;
  // 'running' | 'done' | 'failed' | 'cancelled'. Recently-exited
  // entries linger ~60s before the registry drops them, so the AI sees
  // "just exited" too.
  status: string;
  // ms elapsed since the process started, rounded to nearest second.
  uptimeSeconds: number;
  // The localhost URL the process advertised on stdout, if any.
  detectedUrl: string | null;
}

// Image attached to a single user prompt — a screenshot of a code
// error / UI issue the user can't easily describe in words. The
// renderer base64-encodes the file before transport (Anthropic's
// Messages API takes base64 image content blocks). Only present on
// turns where the user attached an image; not replayed in history.
export interface AttachedImage {
  // 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' — the four
  // formats Anthropic accepts on image content blocks.
  mediaType: string;
  // Base64-encoded image bytes (no "data:..." prefix).
  base64Data: string;
}

export interface TurnInput {
  userInput: string;
  context: TurnContext;
  planMode: boolean;
  // Earlier turns in this conversation tab, oldest first. Empty for the
  // first turn of a conversation.
  history: TurnHistoryEntry[];
  // Snapshot of every process currently in the Running pane (running
  // or recently-exited). Empty when nothing is in the pane.
  runningProcesses: RunningProcessSummary[];
  // Optional screenshot / image the user attached to THIS prompt.
  // The backend forwards it to Claude as an image content block in
  // the user message. Not carried in conversation history — the
  // resulting AI response text serves as durable context.
  attachedImage?: AttachedImage | null;
}

export interface PlanStep {
  title: string;
  command: string;
  description: string;
  // True only for processes designed to run indefinitely (dev servers,
  // watchers, daemons, log tails). The Running pane tracks only these —
  // quick one-shot commands, even slow ones, stay out. Set by the
  // planner. Optional so older cached plans / responses still type-check.
  longRunning?: boolean;
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
  // Built-in file-listing intent. When true, Verlox renders the folder
  // contents using its own directory API — no shell command runs. steps
  // is empty in this case (like a cd turn).
  isListCommand: boolean;
  // Absolute or "~/"-prefixed path to list, or null for the current
  // working directory. Only meaningful when isListCommand is true.
  listTarget: string | null;
  // Built-in prompt-history intent. When true, Verlox renders the
  // user's own prompt log directly — no shell command runs. steps is
  // empty in this case.
  isHistoryCommand: boolean;
  // How many recent prompts to show, or null for the default. Only
  // meaningful when isHistoryCommand is true.
  historyLimit: number | null;
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
    | 'git-branch'
    | 'disk-usage'
    | 'packages'
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

// One visual treatment per group (one-kind-per-group keeps the look
// consistent inside a group). The kind drives the per-node renderer
// in Diagram.tsx — different padding, scale, glyphs, accents.
export type DiagramGroupKind =
  // Plain card with label + optional sub. The default.
  | 'default'
  // Big stat — primary value huge, sub label below, optional body note.
  // Use for "1 hour learning" / "$N revenue" style cards.
  | 'stat'
  // Numbered cards — auto-indexed 01 / 02 / 03 over the label. Use for
  // sequences of small actions.
  | 'numbered'
  // Full-width callout with a coloured left border. label can be a
  // multi-sentence sentence-cased block (longer than usual node labels).
  // The group's pretitle renders INSIDE the callout, not above.
  | 'callout'
  // Dot-on-track timeline. Each node = small tag above a colored dot,
  // then label + sub underneath. A horizontal line connects the dots.
  | 'milestone';

export interface DiagramNode {
  // Small tracked-uppercase text above the label. Used by 'default'
  // for badges (e.g. "✓ YES + NO REVENUE YET") and by 'milestone' for
  // a marker above the dot ("No 1–2"). Ignored by 'stat' / 'numbered'
  // / 'callout'. null when absent.
  tag: string | null;
  // Primary text. Backend returns null for absent values (JSON Schema
  // struggles with undefined). Renderer treats null and absent the same.
  label: string;
  // Secondary text under the label.
  sub: string | null;
  // Tertiary text under sub. Used by 'stat' as the small note beneath
  // the label and sub. null for other kinds.
  body: string | null;
  color: DiagramColor | null;
}

export interface DiagramGroup {
  // Small tracked-uppercase line above the group (e.g.
  // "EVERY DAY — 2 HOURS MINIMUM"). Acts as a section header in a
  // way that's calmer than a full title. For 'callout' kinds it's
  // rendered INSIDE the callout box instead of above the group.
  pretitle: string | null;
  title: string | null;
  subtitle: string | null;
  // Layout direction for the nodes. Ignored by 'callout' (always
  // column-stacking single block) and 'milestone' (always a row).
  layout: 'row' | 'column';
  // The visual treatment for this group's nodes. null → 'default'.
  kind: DiagramGroupKind | null;
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

// Auto-update -----------------------------------------------------------------

// Lifecycle of an app update, surfaced to the renderer so the Update
// button can reflect it. 'downloaded' is the state that shows the
// click-to-install button; it persists until the user installs.
export type UpdateState =
  | 'idle' // up to date / nothing happening
  | 'checking' // querying the release feed
  | 'downloading' // a newer version is being pulled down
  | 'downloaded' // ready to install — the Update button shows
  | 'error'; // check or download failed (stays quiet in the UI)

export interface UpdateStatus {
  state: UpdateState;
  // The newer version string once known (e.g. "0.2.0"), else null.
  version: string | null;
  // Download progress 0–100 while state is 'downloading', else null.
  percent: number | null;
}

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

  // Open a URL (http/https only) in the user's default browser via
  // Electron's shell.openExternal. Used by the live processes board
  // when a dev server's localhost URL has been detected in output.
  openExternal: (url: string) => void;

  // Auto-update. The renderer subscribes to status changes to drive the
  // Update button; installUpdate quits + installs a downloaded update;
  // checkForUpdates triggers a manual re-check.
  onUpdateStatus: (cb: (status: UpdateStatus) => void) => Unsubscribe;
  installUpdate: () => void;
  checkForUpdates: () => void;

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
