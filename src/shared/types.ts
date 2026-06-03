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

// Real terminal (PTY) ------------------------------------------------------
// Backs the interactive terminal tab. A PTY is a live pseudo-terminal the
// user types into directly — distinct from the discrete CommandStart spawns
// that power the plan-execution flow. The renderer renders an xterm.js
// surface and relays raw bytes both ways; the main process owns the
// node-pty child. Each terminal tab owns one PTY, keyed by `id`.

export interface PtyStartPayload {
  // Stable id chosen by the renderer (the terminal tab's id). All later
  // input/resize/kill/data/exit messages carry this so main and renderer
  // can route to the right PTY when several terminals are open at once.
  id: string;
  // Absolute directory to start the shell in. Omit to use the user's home.
  cwd?: string;
  // Initial terminal size, from the xterm fit addon's first measurement.
  cols: number;
  rows: number;
}

export interface PtyInputPayload {
  id: string;
  // Raw bytes the user typed (already UTF-8 string), forwarded verbatim
  // to the PTY — no parsing, so interactive programs see real keystrokes.
  data: string;
}

export interface PtyResizePayload {
  id: string;
  cols: number;
  rows: number;
}

export interface PtyDataEvent {
  id: string;
  // Raw PTY output (includes ANSI / control sequences — xterm renders them).
  data: string;
}

export interface PtyExitEvent {
  id: string;
  exitCode: number;
}

// Restore points (recovery safety net) -------------------------------------
// Verlox keeps a running history of a chosen "guarded folder" so files that
// get deleted or mangled (by the user or an AI agent) can be rewound. Each
// record is one point in that history; the id is an opaque handle the
// renderer passes back to restore. See main/snapshot-manager.ts.

// One file that changed at a restore point, with how it changed. Lets the
// timeline say plainly "New PY File.py removed" so the user can spot the
// moment a file vanished and rewind to just before it.
export interface SnapshotChange {
  // Path relative to the guarded folder.
  path: string;
  // 'added' — file first appeared; 'removed' — file was deleted;
  // 'modified' — contents changed; 'other' — rename/copy/type-change.
  kind: 'added' | 'removed' | 'modified' | 'other';
}

export interface SnapshotRecord {
  // Opaque handle (a git commit hash) used to rewind to this point.
  id: string;
  // Human label ("Checkpoint", "Before rewinding…", "Started protecting…").
  label: string;
  // Epoch milliseconds when the point was taken.
  timestamp: number;
  // Best-effort count of files that changed at this point; null when unknown.
  filesChanged: number | null;
  // True for points Verlox created as part of a rewind, so the UI can mark
  // them differently from ordinary checkpoints.
  isRestore: boolean;
  // The files that changed at this point (capped per point to keep the
  // payload small). Empty for baseline / empty checkpoints. Drives the
  // "what changed here" detail so deletions are visible at a glance.
  changes: SnapshotChange[];
}

export interface SnapshotStatus {
  // Absolute path of the folder currently protected, or null if none chosen.
  guardedFolder: string | null;
  // Whether git (the engine behind restore points) is available. When
  // false, the UI explains how to enable the feature instead of failing.
  gitAvailable: boolean;
  // Whether automatic snapshots (file-watcher + before-command) are on.
  autoEnabled: boolean;
  // --- Undo / Redo (cursor over the snapshot history) --------------------
  // Whether there's an older / newer state to move to. Drive the two buttons.
  canUndo: boolean;
  canRedo: boolean;
  // Short, human description of the change each action affects, for the hover
  // tooltips (e.g. "Removed deleteme.txt", "2 files changed"). Null when that
  // direction isn't available.
  undoSummary: string | null;
  redoSummary: string | null;
}

export interface SnapshotActionResult {
  ok: boolean;
  // Plain-language failure reason, shown to the user when ok is false.
  error?: string;
  // For checkpoint: whether a new point was actually created (false when
  // nothing changed since the last one — a calm no-op, not an error).
  created?: boolean;
}

// --- SQL console -----------------------------------------------------------

// How to reach a database. Postgres only for v1. The password crosses IPC
// once (renderer → main) on connect; main holds the live connection from then
// on, so the renderer never keeps the credential around.
export interface SqlConnectConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  // Require TLS (managed Postgres like Railway/Supabase/RDS usually needs it).
  ssl: boolean;
}

export interface SqlConnectResult {
  ok: boolean;
  // Reported on success — the server version banner, for the connected header.
  serverVersion?: string;
  // Plain-language failure reason when ok is false.
  error?: string;
}

// One column in a result set, in select order.
export interface SqlColumn {
  name: string;
}

export interface SqlQueryResult {
  ok: boolean;
  // Result columns + rows (rows as arrays aligned to columns). Capped in main
  // so a huge SELECT can't flood the renderer; `truncated` flags when it hit
  // the cap.
  columns: SqlColumn[];
  rows: Array<Array<string | null>>;
  // Rows actually affected/returned as reported by the driver.
  rowCount: number | null;
  // The SQL command tag ("SELECT", "UPDATE", "CREATE", …).
  command: string | null;
  // True when rows were cut to the render cap.
  truncated: boolean;
  // Milliseconds the query took (round-trip in main).
  durationMs: number;
  // Plain-language failure reason when ok is false (e.g. a syntax error).
  error?: string;
}

// Agent Mode ----------------------------------------------------------------
// One step the agent proposes toward a goal. Produced by either the Verlox
// backend planner (when using your Verlox account) or by a direct call to the
// AI service with your own key (set in settings). The renderer drives the
// loop: show/approve the step, run it, feed the result back, ask for the next.

export interface AgentStep {
  // True when the goal is complete (or there's nothing to run) — the loop
  // ends and `message` is the closing words.
  done: boolean;
  // Plain-English text to show the user (what the AI is doing / saying).
  message: string;
  // The single command to run next, or null when there's nothing to run.
  command: string | null;
  // One-line reason for this command.
  reason: string;
  // Whether the command only reads (so it can auto-run when that setting is
  // on) versus changes things (which always needs approval).
  readOnly: boolean;
  // A footgun-style warning to surface prominently, or null.
  risk: string | null;
}

// One already-executed step, fed back so the AI can decide the next move.
export interface AgentStepHistory {
  command: string;
  exitCode: number | null;
  output: string;
}

// Which brain runs a step: the Verlox account, or one of the user's own
// custom providers (called directly from the user's machine).
export type AgentEngine = 'verlox' | 'custom';

// The wire format a custom provider speaks. Most services (OpenAI,
// OpenRouter, Groq, Together, Google's compat endpoint, local Ollama /
// LM Studio) speak the OpenAI chat-completions format; Anthropic has its own.
export type ProviderFormat = 'openai' | 'anthropic';

// A user-added AI provider. The key is stored separately (encrypted) and
// never travels over IPC; this metadata is safe to show in the UI.
export interface AgentProviderMeta {
  id: string;
  // Friendly label shown in the model switcher (e.g. "GPT-4o", "Groq Llama").
  name: string;
  format: ProviderFormat;
  // Base URL of the API (e.g. https://api.openai.com/v1).
  baseUrl: string;
  // The model id to request from this provider.
  model: string;
}

export interface AgentPlanInput {
  goal: string;
  priorSteps: AgentStepHistory[];
  cwd: string;
  platform: Platform;
  shell: Shell;
  // 'verlox' uses the Verlox account with `model` as a ModelChoice; 'custom'
  // uses the saved provider identified by providerId, called directly from
  // this machine.
  engine: AgentEngine;
  model: string;
  providerId?: string;
  // An optional image attached to the goal (first step only). Threaded to the
  // AI so it can act on a screenshot. Supported by the Verlox backend and by
  // OpenAI / Anthropic provider calls.
  image?: AttachedImage | null;
  // A snapshot of what's on the user's terminal screen(s), so the agent is
  // always aware of the live terminal context (including other tabs).
  terminalContext?: string;
}

export type AgentStepResult =
  | { ok: true; step: AgentStep }
  // Plain-language failure reason shown in the panel.
  | { ok: false; error: string };

// Settings the user controls for Agent Mode. Only provider metadata crosses
// IPC, never the keys.
export interface SettingsInfo {
  providers: AgentProviderMeta[];
  autoApproveReadonly: boolean;
}

// Fields for adding a provider. The key is verified before being saved, so a
// bad key/URL/model reports an error and nothing is stored.
export interface AddProviderInput {
  name: string;
  format: ProviderFormat;
  baseUrl: string;
  model: string;
  key: string;
}

export interface AddProviderResult {
  ok: boolean;
  error?: string;
  settings: SettingsInfo;
}

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

export type BackendErrorCode =
  | 'unauthorized'
  | 'network'
  | 'rate_limit'
  | 'server'
  // The user ran out of credits for the current period (HTTP 402).
  | 'limit_reached'
  // The user hit a free-tier feature cap (HTTP 403) — daily images or
  // monthly Plan Mode uses. Distinct from running out of credits.
  | 'feature_capped';

// Which free-tier feature cap was hit. Threaded on a 'feature_capped'
// error so the UI can name the limit precisely.
export type FeatureCap = 'images' | 'thinkMode';

// One free-tier feature cap (images/day, Plan Mode/month). `limit` is
// null for Pro, meaning unlimited.
export interface UsageCap {
  used: number;
  limit: number | null;
  // The window the cap counts over.
  window: 'day' | 'month';
}

// One row of the credit ledger, mirrored from the backend. Powers the
// usage dashboard's recent-activity list.
export interface UsageEvent {
  // 'turn' | 'diagram'.
  action: string;
  model: string;
  planMode: boolean;
  hadImage: boolean;
  credits: number;
  // ISO timestamp.
  createdAt: string;
}

// Credit-balance snapshot for the current period, mirrored from the
// backend's /api/usage. Drives the balance readout, the run-out popup,
// and the usage dashboard. Free tier refills daily; Pro refills weekly.
export interface UsageInfo {
  // Credits spent this period.
  used: number;
  // Credit grant for the period.
  limit: number;
  // The period key this snapshot counts against.
  period: string;
  // Credits left this period.
  remaining: number;
  // 'free' | 'pro' — which billing tier the grant/model reflect.
  tier: string;
  // ISO timestamp when the current period ends and credits refill.
  resetsAt?: string;
  // Free-tier feature caps (images/day, Plan Mode/month). Present only
  // on the full /api/usage payload, not on lightweight tier reads.
  caps?: {
    images: UsageCap;
    thinkMode: UsageCap;
  };
  // Recent credit-ledger rows, newest first.
  events?: UsageEvent[];
}

export interface BackendErrorWire {
  ok: false;
  code: BackendErrorCode;
  // Present only when code is 'feature_capped' — which cap was hit.
  cap?: FeatureCap;
}

// Result of a billing action (start checkout / open portal). On success the
// main process has already opened the URL in the browser; on failure the
// renderer shows a calm message keyed off `error`.
export type BillingErrorCode =
  | 'unauthorized'
  | 'network'
  | 'not_configured' // Stripe isn't set up on the backend yet (503)
  | 'no_account' // no Stripe customer yet (portal before any checkout)
  | 'server';

export interface BillingActionResult {
  ok: boolean;
  error?: BillingErrorCode;
  // True when "start checkout" actually opened the manage portal because
  // the user already has a live subscription (duplicate-purchase guard).
  // Lets the UI show "opened your billing portal" instead of "checkout".
  alreadySubscribed?: boolean;
}

// Live subscription snapshot for the account menu, mirrored from the
// backend's /api/billing/status. Lets the app show exactly which plan
// you're on and when it renews or ends.
export interface BillingStatus {
  // 'free' | 'pro' — the stored tier.
  tier: string;
  // True when there's a live (active/trialing) subscription at Stripe.
  active: boolean;
  // True when the subscription is set to cancel at the period end (the
  // user canceled but still has access until currentPeriodEnd).
  cancelAtPeriodEnd: boolean;
  // Unix seconds when the current paid period ends — the renewal date,
  // or the date access ends if cancelAtPeriodEnd. null when no sub.
  currentPeriodEnd: number | null;
  // Raw Stripe subscription status (active, canceled, past_due…), or null.
  status: string | null;
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

// Which Anthropic model serves a turn. Free users are pinned to 'haiku'
// server-side regardless of selection; only Pro can pick 'sonnet' (the
// default) or 'opus'. Kept in sync with the backend ModelChoice.
export type ModelChoice = 'haiku' | 'sonnet' | 'opus';

export interface TurnInput {
  userInput: string;
  context: TurnContext;
  planMode: boolean;
  // The model the user selected for this turn. Optional — when omitted
  // the backend serves the tier default (free→Haiku, pro→Sonnet). Free
  // selections are ignored server-side (always Haiku).
  model?: ModelChoice;
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
  // Same model the plan used, so the synthesized prose keeps a consistent
  // voice. Optional; free selections ignored server-side.
  model?: ModelChoice;
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
  // Open a native folder chooser (agent working folder). Resolves to the
  // chosen absolute path, or null if cancelled.
  pickDirectory: () => Promise<string | null>;
  startCommand: (payload: CommandStartPayload) => void;
  stopCommand: (id: string) => void;
  onCommandOutput: (cb: (event: CommandOutputEvent) => void) => Unsubscribe;
  onCommandExit: (cb: (event: CommandExitEvent) => void) => Unsubscribe;

  // Real terminal (PTY) — backs the interactive terminal tab. ptyStart
  // spawns the shell; ptyInput forwards keystrokes; ptyResize tracks the
  // xterm viewport; ptyKill tears the PTY down (on tab close / unmount).
  // onPtyData / onPtyExit stream raw output and the exit notice; both
  // carry the tab id so the renderer routes to the right terminal.
  ptyStart: (payload: PtyStartPayload) => void;
  ptyInput: (payload: PtyInputPayload) => void;
  ptyResize: (payload: PtyResizePayload) => void;
  ptyKill: (id: string) => void;
  onPtyData: (cb: (event: PtyDataEvent) => void) => Unsubscribe;
  onPtyExit: (cb: (event: PtyExitEvent) => void) => Unsubscribe;

  // Restore points (recovery safety net). snapshotStatus reports the
  // protected folder + whether git is available; snapshotPickFolder opens a
  // native folder chooser; snapshotSetFolder begins protecting a folder
  // (creates the vault + a baseline point); snapshotCheckpoint saves a point
  // on demand; snapshotList returns the timeline (newest first);
  // snapshotRestore rewinds the whole folder to a chosen point (and saves the
  // current state first, so the rewind is itself undoable).
  snapshotStatus: () => Promise<SnapshotStatus>;
  snapshotPickFolder: () => Promise<string | null>;
  snapshotSetFolder: (folder: string) => Promise<SnapshotActionResult>;
  snapshotCheckpoint: (label?: string) => Promise<SnapshotActionResult>;
  snapshotList: () => Promise<SnapshotRecord[]>;
  snapshotRestore: (id: string) => Promise<SnapshotActionResult>;
  // Turn automatic snapshots on/off; resolves with the updated status.
  snapshotSetAuto: (enabled: boolean) => Promise<SnapshotStatus>;
  // Step the protected folder back / forward through its snapshot history.
  // Each resolves with the updated status (canUndo/canRedo refreshed).
  snapshotUndo: () => Promise<SnapshotStatus>;
  snapshotRedo: () => Promise<SnapshotStatus>;

  // SQL console. sqlConnect opens (and tests) a connection owned by main,
  // keyed by the tab id; sqlQuery runs SQL on it; sqlDisconnect tears it down.
  sqlConnect: (id: string, config: SqlConnectConfig) => Promise<SqlConnectResult>;
  sqlQuery: (id: string, sql: string) => Promise<SqlQueryResult>;
  sqlDisconnect: (id: string) => Promise<void>;

  // Agent Mode. agentPlanStep asks for the next step toward a goal (routed
  // to the user's own key when set, else the Verlox backend). The settings*
  // calls manage the optional own-key and the auto-approve-read-only switch;
  // the key value never crosses IPC, only whether one is saved.
  agentPlanStep: (input: AgentPlanInput) => Promise<AgentStepResult>;
  settingsGet: () => Promise<SettingsInfo>;
  // Add a custom provider: verified (a tiny test call), then saved only if it
  // works. The key value never comes back over IPC.
  settingsAddProvider: (input: AddProviderInput) => Promise<AddProviderResult>;
  settingsRemoveProvider: (id: string) => Promise<SettingsInfo>;
  settingsSetAutoApprove: (enabled: boolean) => Promise<SettingsInfo>;

  // Auth (token never crosses IPC).
  signUp: (credentials: AuthCredentials) => Promise<AuthResult>;
  signIn: (credentials: AuthCredentials) => Promise<AuthResult>;
  signOut: () => Promise<void>;
  getCurrentUser: () => Promise<AuthUser | null>;

  // Environment (platform + shell). Static for the app's lifetime.
  getEnvironment: () => Promise<EnvironmentInfo>;

  // The running app version (package.json version via app.getVersion()).
  // Shown in the account menu so the user can see what they're on — and
  // confirm an auto-update actually swapped the build.
  getAppVersion: () => Promise<string>;

  // Current month's free-tier usage for the signed-in user, or null if
  // the request failed (network/unauthorized). Shown in the account menu.
  getUsage: () => Promise<UsageInfo | null>;

  // Billing. startCheckout opens a Stripe Checkout for the Pro plan;
  // openBillingPortal opens the Stripe customer portal (manage card /
  // cancel). Both open the URL in the default browser from the main
  // process and resolve once the browser has been launched (the actual
  // plan change arrives via webhook; the app refreshes its tier on focus).
  startCheckout: () => Promise<BillingActionResult>;
  openBillingPortal: () => Promise<BillingActionResult>;

  // Live subscription status (plan + renew/cancel date), or null if the
  // request failed. Shown in the account menu.
  getBillingStatus: () => Promise<BillingStatus | null>;

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
