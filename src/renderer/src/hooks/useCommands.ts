import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BackendErrorCode,
  CwdInfo,
  DirListing,
  EnvironmentInfo,
  ExecutionLogEntry,
  PlanDisplayMode,
  PlanResponse,
  PlanStep,
  Shell,
  TurnHistoryEntry,
} from '@shared/types';
import { useAuth } from '../contexts/AuthContext';
import {
  appendPrompt,
  readPromptHistory,
  updatePromptOutcome,
  type PromptHistoryEntry,
  type PromptHistoryStatus,
} from './usePromptHistory';

// ── State machine ─────────────────────────────────────────────────────────

export type TurnStatus =
  | 'translating'             // /api/turn in flight
  | 'planning-error'          // /api/turn failed (network/server/rate-limit)
  | 'replied'                 // AI answered without running commands — a
                              //   clarifying question, advice, or a decline
  | 'cd-success'              // cd handled
  | 'cd-error'                // cd path invalid
  | 'list-success'            // built-in file listing rendered
  | 'list-error'              // built-in file listing failed
  | 'history-shown'           // built-in prompt-history rendered
  | 'awaiting-confirmation'   // Plan Mode: Plan Card visible, awaiting Run/Cancel
  | 'cancelled-before-run'    // user clicked Cancel on the Plan Card
  | 'executing'               // running steps locally via window.api.startCommand
  | 'synthesizing'            // /api/synthesize connected, no deltas yet
  | 'streaming'               // first delta arrived; response prose flowing
  | 'done'                    // synthesis complete, or verbatim turn finished
  | 'killed'                  // user pressed stop on a running step
  | 'synthesize-error';       // /api/synthesize errored

// The indicator shown under the user input while a turn is in
// motion. A specific `label` describing what the orchestrator is
// doing right now ("Running ping google.com") plus optional `alts`
// that the indicator rotates through every ~2s so a long-running
// step still feels alive. null = nothing to show.
export interface StatusInfo {
  label: string;
  alts: string[];
}

export type StatusIndicatorState = StatusInfo | null;

// Per-step lifecycle. The 6 visual states map directly to the StepRow's
// 14px status circle:
//   queued    → outlined ring, no fill           (not started yet)
//   running   → bg-amber + animate-flicker       (currently executing)
//   done      → bg-step-done + checkmark SVG     (exit 0)
//   failed    → bg-step-failed + "!"             (non-zero exit, command error)
//   cancelled → outlined ring, opacity-50        (was running, user pressed stop)
//   skipped   → outlined ring, opacity-50        (was queued, kill aborted plan)
//
// `failed` is reserved for command errors. User-initiated stops use
// `cancelled` so the visual reads "we paused this," not "this broke."
// Both `cancelled` and `skipped` share the demoted opacity-50 outline
// since neither finished running and neither warrants the red wash.
//
// `output` is appended live while the step is running so the verbatim
// panel and details panel can render real-time output during execution.
export type StepStatus =
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'skipped';

export interface MessageStep {
  index: number;
  title: string;
  command: string;
  description: string;
  status: StepStatus;
  output: string;
  exitCode: number | null;
  signal: string | null;
}

export interface CommandMessage {
  id: string;
  userInput: string;
  cwd: string;                              // display form at submit time
  startedAt: number;
  endedAt: number | null;

  status: TurnStatus;
  statusIndicator: StatusIndicatorState;

  // Filled by /api/turn:
  plan: PlanResponse | null;

  // Display mode for this turn — drives the post-execution branch:
  //   summary  → call /api/synthesize, stream prose into finalResponse.
  //   verbatim → skip synthesize, render per-step raw output blocks.
  // null until the plan arrives.
  displayMode: PlanDisplayMode | null;

  // Per-step state, mirroring plan.steps in order. Initialized via
  // STEPS_INITIALIZED right after PLAN_RECEIVED. Updated incrementally
  // by STEP_START / STEP_OUTPUT / STEP_DONE.
  steps: MessageStep[];

  // Filled during executing (one entry per completed step):
  executionLog: ExecutionLogEntry[];

  // Reveal-smoothing pair (Phase 3.4.1 pattern, preserved):
  // pendingResponse accumulates raw text from synthesize stream OR refusal
  // text. The reveal interval advances finalResponse one char per 20ms tick.
  // Vorlox-generated strings (cd success/error, planning error, killed
  // footer) bypass — they render hard.
  pendingResponse: string;
  finalResponse: string;

  // For cd-success render:
  cdResolvedDisplay: string | null;

  // For list-success render: the resolved DirListing (path + entries).
  // Null for any other status.
  listing: DirListing | null;

  // For history-shown render: the snapshot of prompt history this
  // turn rendered. Null for any other status.
  promptHistory: PromptHistoryEntry[] | null;

  // The id of this turn's entry in the global prompt-history log
  // (usePromptHistory). Set at INPUT_SUBMITTED; used post-settlement
  // to write the commands + outcome + status back to the entry so the
  // Timeline hover card can show context. Empty string when no entry
  // was created (e.g. localStorage unavailable).
  historyEntryId: string;

  // For *-error states + planning-error / synthesize-error:
  errorMessage: string | null;

  // Backstop for the hang-on-prompt hazard. Set true when the running
  // step has produced no output and not exited for a while — it may be
  // a command waiting for input Vorlox can't answer. Non-destructive:
  // the Message just shows a calm notice. Cleared the moment output
  // resumes or the step ends. Only meaningful while status==='executing'.
  stalled: boolean;
}

// ── Reducer actions ───────────────────────────────────────────────────────

type Action =
  | {
      type: 'INPUT_SUBMITTED';
      id: string;
      userInput: string;
      cwd: string;
      historyEntryId: string;
    }
  // PLAN_RECEIVED's pauseForConfirmation flag decides the initial status:
  //   false → 'executing' (orchestrator runs steps immediately)
  //   true  → 'awaiting-confirmation' (Plan Card renders, orchestrator parks
  //           on a promise until confirmPlan/cancelPlan fires)
  // The orchestrator sets this true when either the session-wide Plan Mode
  // is on OR the backend flagged a footgun on the plan. Renamed from
  // 'planMode' in Chunk 5 because footguns also flip it.
  | {
      type: 'PLAN_RECEIVED';
      id: string;
      plan: PlanResponse;
      pauseForConfirmation: boolean;
    }
  // PLAN_CONFIRMED flips a paused turn from 'awaiting-confirmation' →
  // 'executing'. The orchestrator resumes step execution after this.
  | { type: 'PLAN_CONFIRMED'; id: string }
  // PLAN_CANCELLED terminates a paused turn. No steps ever run.
  // The turn stays in conversation history with the "Plan discarded." footer.
  | { type: 'PLAN_CANCELLED'; id: string }
  | { type: 'PLANNING_ERROR'; id: string; message: string }
  // REPLIED: the AI answered without running commands — a clarifying
  // question, advice, or a calm decline. `text` is its message.
  | { type: 'REPLIED'; id: string; text: string }
  | { type: 'CD_SUCCESS'; id: string; displayPath: string }
  | { type: 'CD_ERROR'; id: string; message: string }
  // LIST_SUCCESS: a built-in file listing resolved cleanly. The listing
  // carries the resolved absolute path, entries, and a possible error
  // (entries empty in that case — but we only LIST_SUCCESS if no error).
  | { type: 'LIST_SUCCESS'; id: string; listing: DirListing }
  // LIST_ERROR: the directory couldn't be opened (missing, permission).
  | { type: 'LIST_ERROR'; id: string; message: string }
  // HISTORY_SHOWN: the built-in prompt-history view rendered with a
  // snapshot of the user's prompt log.
  | { type: 'HISTORY_SHOWN'; id: string; entries: PromptHistoryEntry[] }
  | { type: 'STATUS_INDICATOR'; id: string; info: StatusIndicatorState }
  // STEPS_INITIALIZED takes the plan steps and seeds steps[] all queued.
  // Dispatched right after PLAN_RECEIVED, before any step starts.
  | { type: 'STEPS_INITIALIZED'; id: string; steps: PlanStep[] }
  // STEP_START flips a single step from queued → running.
  | { type: 'STEP_START'; id: string; index: number }
  // STEP_OUTPUT appends raw shell output to a running step. Fires on every
  // stdout/stderr chunk so the verbatim/details panels can render live.
  // Also clears the `stalled` flag — output means the command is alive.
  | { type: 'STEP_OUTPUT'; id: string; index: number; data: string }
  // STEP_STALLED marks a turn whose running step has been silent too
  // long — it may be a command waiting for input. Sets the `stalled`
  // flag; the Message renders a calm notice. Non-destructive.
  | { type: 'STEP_STALLED'; id: string }
  // STEP_DONE finalizes a step. status mapping:
  //   'done'      → exit 0
  //   'failed'    → non-zero exit (real command error)
  //   'cancelled' → was running when the user pressed stop
  //   'skipped'   → was still queued when a kill aborted the plan
  // Pushes an ExecutionLogEntry whenever the step actually ran
  // (status !== 'skipped'). Skipped steps stay out of the log because
  // they have no output for the synthesizer to summarize.
  | {
      type: 'STEP_DONE';
      id: string;
      index: number;
      status: 'done' | 'failed' | 'cancelled' | 'skipped';
      output: string;
      exitCode: number | null;
      signal: string | null;
    }
  | { type: 'KILLED'; id: string }
  | { type: 'SYNTHESIZE_DELTA'; id: string; text: string }
  // TURN_DONE marks the turn complete. Fires from the synthesize-stream
  // 'done' event in summary mode, OR directly from the orchestrator after
  // the last step in verbatim mode (no synthesize call).
  | { type: 'TURN_DONE'; id: string }
  | { type: 'SYNTHESIZE_ERROR'; id: string; message: string }
  // FREEZE_REVEAL: snap pendingResponse to whatever finalResponse
  // currently shows. The synthesise stream is already done (status is
  // 'done' or 'replied') but reveal-smoothing is still typing the
  // prose in character-by-character. Used by the public stopCommand
  // when the user pauses during reveal. Keeps the turn's settled
  // status — it's not a kill, just a "stop animating in more text."
  | { type: 'FREEZE_REVEAL'; id: string }
  | { type: 'CLEAR_ALL' };

function newMessage(
  id: string,
  userInput: string,
  cwd: string,
  historyEntryId: string,
): CommandMessage {
  return {
    id,
    userInput,
    cwd,
    historyEntryId,
    startedAt: Date.now(),
    endedAt: null,
    status: 'translating',
    statusIndicator: {
      label: 'Examining your request',
      alts: ['Thinking it through', 'Planning the steps'],
    },
    plan: null,
    displayMode: null,
    steps: [],
    executionLog: [],
    pendingResponse: '',
    finalResponse: '',
    cdResolvedDisplay: null,
    listing: null,
    promptHistory: null,
    errorMessage: null,
    stalled: false,
  };
}

function reduce(state: CommandMessage[], action: Action): CommandMessage[] {
  switch (action.type) {
    case 'INPUT_SUBMITTED':
      return [
        ...state,
        newMessage(action.id, action.userInput, action.cwd, action.historyEntryId),
      ];

    case 'PLAN_RECEIVED':
      return state.map((m) =>
        m.id === action.id
          ? {
              ...m,
              plan: action.plan,
              displayMode: action.plan.displayMode,
              // Pausing parks the turn on the Plan Card with no status
              // indicator (the card itself is the UI). Non-paused turns
              // proceed straight to execution with "Running…" indicator.
              status: action.pauseForConfirmation
                ? 'awaiting-confirmation'
                : 'executing',
              // Briefly "Setting up" between PLAN_RECEIVED and the first
              // STEP_START. STEP_START overwrites with a command-specific
              // label so this only flashes if the orchestrator is slow.
              statusIndicator: action.pauseForConfirmation
                ? null
                : { label: 'Setting up', alts: [] },
            }
          : m,
      );

    case 'PLAN_CONFIRMED':
      return state.map((m) =>
        m.id === action.id
          ? {
              ...m,
              status: 'executing',
              statusIndicator: { label: 'Setting up', alts: [] },
            }
          : m,
      );

    case 'PLAN_CANCELLED':
      return state.map((m) =>
        m.id === action.id
          ? {
              ...m,
              status: 'cancelled-before-run',
              statusIndicator: null,
              endedAt: Date.now(),
            }
          : m,
      );

    case 'STEPS_INITIALIZED':
      return state.map((m) =>
        m.id === action.id
          ? {
              ...m,
              steps: action.steps.map((s, i) => ({
                index: i,
                title: s.title,
                command: s.command,
                description: s.description,
                status: 'queued' as const,
                output: '',
                exitCode: null,
                signal: null,
              })),
            }
          : m,
      );

    case 'STEP_START':
      return state.map((m) => {
        if (m.id !== action.id) return m;
        const step = m.steps.find((s) => s.index === action.index);
        // Show the actual command being run, so the indicator reads
        // as "Running ping google.com" instead of a generic word.
        // For long commands (pipelines etc.) we truncate to keep the
        // line readable.
        const label = step
          ? `Running ${formatCommandForIndicator(step.command)}`
          : 'Running';
        return {
          ...m,
          // Fresh step — clear any stale "stalled" flag from a prior one.
          stalled: false,
          statusIndicator: { label, alts: ['Watching output', 'Still working'] },
          steps: m.steps.map((s) =>
            s.index === action.index ? { ...s, status: 'running' as const } : s,
          ),
        };
      });

    case 'STEP_STALLED':
      return state.map((m) =>
        m.id === action.id ? { ...m, stalled: true } : m,
      );

    case 'STEP_OUTPUT':
      return state.map((m) =>
        m.id === action.id
          ? {
              ...m,
              // Output arrived — the command is alive, not stalled.
              stalled: false,
              steps: m.steps.map((s) =>
                s.index === action.index
                  ? { ...s, output: s.output + action.data }
                  : s,
              ),
            }
          : m,
      );

    case 'PLANNING_ERROR':
      return state.map((m) =>
        m.id === action.id
          ? {
              ...m,
              status: 'planning-error',
              statusIndicator: null,
              errorMessage: action.message,
              endedAt: Date.now(),
            }
          : m,
      );

    case 'REPLIED':
      // The AI's message flows through reveal-smoothing (it's AI prose).
      return state.map((m) =>
        m.id === action.id
          ? {
              ...m,
              status: 'replied',
              statusIndicator: null,
              pendingResponse: action.text,
              endedAt: Date.now(),
            }
          : m,
      );

    case 'CD_SUCCESS':
      // Vorlox-generated string — bypass reveal-smoothing; render hard.
      return state.map((m) =>
        m.id === action.id
          ? {
              ...m,
              status: 'cd-success',
              statusIndicator: null,
              cdResolvedDisplay: action.displayPath,
              endedAt: Date.now(),
            }
          : m,
      );

    case 'CD_ERROR':
      return state.map((m) =>
        m.id === action.id
          ? {
              ...m,
              status: 'cd-error',
              statusIndicator: null,
              errorMessage: action.message,
              endedAt: Date.now(),
            }
          : m,
      );

    case 'LIST_SUCCESS':
      return state.map((m) =>
        m.id === action.id
          ? {
              ...m,
              status: 'list-success',
              statusIndicator: null,
              listing: action.listing,
              endedAt: Date.now(),
            }
          : m,
      );

    case 'LIST_ERROR':
      return state.map((m) =>
        m.id === action.id
          ? {
              ...m,
              status: 'list-error',
              statusIndicator: null,
              errorMessage: action.message,
              endedAt: Date.now(),
            }
          : m,
      );

    case 'HISTORY_SHOWN':
      return state.map((m) =>
        m.id === action.id
          ? {
              ...m,
              status: 'history-shown',
              statusIndicator: null,
              promptHistory: action.entries,
              endedAt: Date.now(),
            }
          : m,
      );

    case 'STATUS_INDICATOR':
      return state.map((m) =>
        m.id === action.id ? { ...m, statusIndicator: action.info } : m,
      );

    case 'STEP_DONE':
      return state.map((m) => {
        if (m.id !== action.id) return m;
        // Update the step's terminal status + captured output/exit/signal.
        const nextSteps = m.steps.map((s) =>
          s.index === action.index
            ? {
                ...s,
                status: action.status,
                // For status='skipped' the step never ran, so output is ''.
                // For done/failed we replace with the final captured output
                // (which already matches what STEP_OUTPUT accumulated).
                output: action.output,
                exitCode: action.exitCode,
                signal: action.signal,
              }
            : s,
        );
        // Skipped steps don't go in executionLog — synthesize only sees
        // what actually ran.
        const nextLog =
          action.status === 'skipped'
            ? m.executionLog
            : [
                ...m.executionLog,
                {
                  stepIndex: action.index,
                  command:
                    m.steps.find((s) => s.index === action.index)?.command ?? '',
                  output: action.output,
                  exitCode: action.exitCode,
                  signal: action.signal,
                },
              ];
        return { ...m, steps: nextSteps, executionLog: nextLog };
      });

    case 'KILLED':
      return state.map((m) =>
        m.id === action.id
          ? {
              ...m,
              status: 'killed',
              statusIndicator: null,
              // Freeze reveal-smoothing at the current visible
              // position. Without this, the smoothing tick keeps
              // walking pendingResponse → finalResponse one char at
              // a time after the user cancelled, which looks like
              // the AI is still typing despite the stop.
              pendingResponse: m.finalResponse,
              endedAt: Date.now(),
            }
          : m,
      );

    case 'SYNTHESIZE_DELTA':
      // First delta hides the status indicator and flips status to streaming.
      return state.map((m) =>
        m.id === action.id
          ? {
              ...m,
              status: 'streaming',
              statusIndicator: null,
              pendingResponse: m.pendingResponse + action.text,
            }
          : m,
      );

    case 'TURN_DONE':
      return state.map((m) =>
        m.id === action.id
          ? { ...m, status: 'done', statusIndicator: null, endedAt: Date.now() }
          : m,
      );

    case 'SYNTHESIZE_ERROR':
      // Catch finalResponse up to pendingResponse so the partial text the
      // user has been reading is fully visible alongside the error footer.
      return state.map((m) =>
        m.id === action.id
          ? {
              ...m,
              status: 'synthesize-error',
              statusIndicator: null,
              errorMessage: action.message,
              finalResponse: m.pendingResponse,
              endedAt: Date.now(),
            }
          : m,
      );

    case 'FREEZE_REVEAL':
      return state.map((m) =>
        m.id === action.id ? { ...m, pendingResponse: m.finalResponse } : m,
      );

    case 'CLEAR_ALL':
      return [];
  }
}

// ── Error message mapping (BackendErrorCode → user-facing copy) ──────────

function planningErrorMessage(code: BackendErrorCode): string {
  switch (code) {
    case 'unauthorized':
      return 'Your session expired. Please sign in again.';
    case 'rate_limit':
      return 'Too many requests. Please wait a moment and try again.';
    case 'network':
      return "Couldn't reach the service. Check your connection.";
    case 'server':
      return 'Something went wrong. Please try again.';
  }
}

function synthesizeErrorMessage(code: BackendErrorCode): string {
  // Synthesize errors arrive AFTER the steps already ran. The execution log
  // is intact; the user just doesn't get a calm prose summary. Phrase the
  // copy to acknowledge that.
  switch (code) {
    case 'unauthorized':
      return 'Your session expired. Please sign in again.';
    case 'rate_limit':
      return 'The summary is rate-limited. The commands ran; the summary will need a retry.';
    case 'network':
      return "Couldn't reach the service for the summary. The commands ran.";
    case 'server':
      return "Couldn't generate a summary. The commands ran.";
  }
}

// A running step silent (no output, no exit) for this long is flagged as
// possibly waiting for input — the hang-on-prompt backstop. Generous so a
// genuinely slow-but-working command (a quiet npm install, a big fetch)
// rarely trips it; and the notice is non-destructive anyway.
const SILENCE_NOTICE_MS = 30000;

// Settlement check for the Timeline hover card sync. Anything that's
// reached a terminal state — successfully done, replied, a system
// outcome like cd/list/history, an error, a cancel.
function isSettledTurnStatus(status: TurnStatus): boolean {
  switch (status) {
    case 'done':
    case 'replied':
    case 'cd-success':
    case 'cd-error':
    case 'list-success':
    case 'list-error':
    case 'history-shown':
    case 'planning-error':
    case 'synthesize-error':
    case 'killed':
    case 'cancelled-before-run':
      return true;
    default:
      return false;
  }
}

// Build the post-settlement update for a turn's prompt-history entry.
// Captures the commands that ran, a short conclusion, and a status
// tag the Timeline can colour by.
function deriveHistoryUpdate(
  m: CommandMessage,
): { commands: string[]; outcome: string | null; status: PromptHistoryStatus } | null {
  const commands = m.steps
    .filter((s) => s.status === 'done' || s.status === 'failed' || s.status === 'cancelled')
    .map((s) => s.command);
  switch (m.status) {
    case 'done':
      return {
        commands,
        outcome: m.finalResponse.length > 0 ? m.finalResponse : null,
        status: 'done',
      };
    case 'replied':
      return {
        commands: [],
        outcome: m.finalResponse.length > 0 ? m.finalResponse : m.pendingResponse,
        status: 'replied',
      };
    case 'cd-success':
      return {
        commands: [],
        outcome: m.cdResolvedDisplay ? `Switched to ${m.cdResolvedDisplay}.` : 'Switched folder.',
        status: 'cd',
      };
    case 'cd-error':
      return {
        commands: [],
        outcome: m.errorMessage,
        status: 'error',
      };
    case 'list-success':
      return {
        commands: [],
        outcome: m.listing
          ? `Listed ${m.listing.entries.length} entries in ${m.listing.path}.`
          : 'Listed a folder.',
        status: 'list',
      };
    case 'list-error':
      return {
        commands: [],
        outcome: m.errorMessage,
        status: 'error',
      };
    case 'history-shown':
      return {
        commands: [],
        outcome: `Showed ${m.promptHistory?.length ?? 0} past prompts.`,
        status: 'history',
      };
    case 'planning-error':
    case 'synthesize-error':
      return {
        commands,
        outcome: m.errorMessage,
        status: 'error',
      };
    case 'killed':
      return {
        commands,
        outcome: 'Stopped.',
        status: 'cancelled',
      };
    case 'cancelled-before-run':
      return {
        commands: [],
        outcome: 'Plan discarded.',
        status: 'cancelled',
      };
    default:
      return null;
  }
}

// Format a raw shell command for the status indicator: collapse runs
// of whitespace into single spaces and truncate to keep one line
// readable. Long PowerShell pipelines and Get-Process one-liners cap
// at 48 chars with an ellipsis so the indicator never blows out.
const INDICATOR_COMMAND_MAX = 48;
function formatCommandForIndicator(command: string): string {
  const collapsed = command.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= INDICATOR_COMMAND_MAX) return collapsed;
  return `${collapsed.slice(0, INDICATOR_COMMAND_MAX - 1).trimEnd()}…`;
}

// ── Conversation history (Phase 5 Chunk 1: Memory) ────────────────────────

// Prior turns' command output is capped at this many lines in the
// history transcript. The CURRENT turn always sends full output —
// only the backward-looking history is trimmed, so a once-huge
// listing doesn't bloat every later request.
const HISTORY_OUTPUT_LINE_CAP = 40;

function truncateForHistory(text: string): string {
  const trimmed = text.trimEnd();
  if (trimmed.length === 0) return '';
  const lines = trimmed.split('\n');
  if (lines.length <= HISTORY_OUTPUT_LINE_CAP) return trimmed;
  return `${lines.slice(0, HISTORY_OUTPUT_LINE_CAP).join('\n')}\n…(trimmed)`;
}

// Compact one completed turn into a history entry for /api/turn. Carries
// what the user asked and what happened — commands + trimmed output, the
// AI's reply, or a cd / error / cancellation note.
function toHistoryEntry(m: CommandMessage): TurnHistoryEntry {
  let outcome: string;
  switch (m.status) {
    case 'cd-success':
      outcome = `Changed working directory to ${m.cdResolvedDisplay ?? '(unknown)'}.`;
      break;
    case 'list-success':
      if (m.listing) {
        const folders = m.listing.entries.filter((e) => e.isDirectory);
        const files = m.listing.entries.filter((e) => !e.isDirectory);
        outcome =
          `Listed ${m.listing.entries.length} entries in ${m.listing.path} ` +
          `(${folders.length} folders, ${files.length} files): ` +
          m.listing.entries
            .slice(0, 30)
            .map((e) => (e.isDirectory ? `${e.name}/` : e.name))
            .join(', ') +
          (m.listing.entries.length > 30 ? ', …' : '') +
          '.';
      } else {
        outcome = 'Listed a folder.';
      }
      break;
    case 'history-shown':
      outcome = `Showed the user's ${m.promptHistory?.length ?? 0} most recent Vorlox prompts.`;
      break;
    case 'cd-error':
    case 'list-error':
    case 'planning-error':
      outcome = m.errorMessage ?? 'Something went wrong.';
      break;
    case 'cancelled-before-run':
      outcome = 'The plan was discarded before running.';
      break;
    default: {
      if (m.executionLog.length > 0) {
        const blocks = m.executionLog.map((e) => {
          const out = truncateForHistory(e.output) || '(no output)';
          return `$ ${e.command}\n${out}`;
        });
        outcome = blocks.join('\n\n');
        const reply = m.finalResponse || m.pendingResponse;
        if (reply) outcome += `\n\nVorlox replied: ${reply}`;
      } else {
        // Reply / refusal turns ran nothing — the AI's prose is the outcome.
        outcome = m.finalResponse || m.pendingResponse || '(no response)';
      }
    }
  }
  return { userInput: m.userInput, outcome };
}

// ── Hook ──────────────────────────────────────────────────────────────────

export function useCommands(
  // The conversation's working directory, or null if the user hasn't
  // chosen one ("folderless"). Folderless conversations still work —
  // commands run from the user's home directory as the invisible
  // default (see effectiveCwd below).
  cwd: CwdInfo | null,
  // Session-wide Plan Mode flag (Chunk 4). When true, every new turn
  // pauses after /api/turn and renders the Plan Card instead of running
  // immediately. Read via a ref so submitInput sees the latest value.
  // Cd-only and footgun-only turns bypass Plan Mode (cd is auto-handled;
  // footguns get their own stripped Plan Card in Chunk 5).
  planMode: boolean,
  // Called when a `cd` turn succeeds. The conversation owns its own cwd
  // state (one cwd per tab); useCommands resolves the path via the
  // backend validator but hands the result back here so the owning
  // ConversationView can update its state and re-render the header.
  onCwdChange: (next: CwdInfo) => void,
  // Absolute path of the file the conversation is locked to, or null.
  // Sent to the backend in the turn context so the AI reads requests as
  // being about that file. Set via the path picker, owned by
  // ConversationView.
  focusedFile: string | null,
): {
  messages: CommandMessage[];
  forceScrollVersion: number;
  submitInput: (userInput: string) => Promise<void>;
  stopCommand: (id: string) => void;
  confirmPlan: (messageId: string) => void;
  cancelPlan: (messageId: string) => void;
} {
  const [messages, setMessages] = useState<CommandMessage[]>([]);
  const messagesRef = useRef<CommandMessage[]>([]);
  const [forceScrollVersion, setForceScrollVersion] = useState(0);
  const [environment, setEnvironment] = useState<EnvironmentInfo | null>(null);
  const { forceSignOut } = useAuth();

  // Mirror planMode into a ref so submitInput reads the latest value
  // without re-creating its closure. The orchestrator captures the value at
  // submit time (not at confirm time) — flipping Plan Mode off mid-turn
  // does NOT release a paused turn; it has to be confirmed or cancelled.
  const planModeRef = useRef(planMode);
  useEffect(() => {
    planModeRef.current = planMode;
  }, [planMode]);

  // Mirror onCwdChange into a ref so the cd branch of submitInput always
  // calls the latest callback without re-creating the orchestrator
  // closure when the parent re-renders.
  const onCwdChangeRef = useRef(onCwdChange);
  useEffect(() => {
    onCwdChangeRef.current = onCwdChange;
  }, [onCwdChange]);

  // Resolver-map for the Plan Mode pause. When the orchestrator enters
  // 'awaiting-confirmation' it stashes a resolver here keyed by message
  // id, then awaits a Promise that resolves true (Run) or false (Cancel).
  // confirmPlan / cancelPlan look up the resolver and call it.
  //
  // Lifecycle: added in submitInput, removed in confirmPlan/cancelPlan
  // (or in bounceToLogin which resolves all pending as cancelled). A
  // missing resolver means the promise was already settled — the public
  // confirm/cancel actions are no-ops in that case.
  const pendingConfirmationsRef = useRef<Map<string, (confirmed: boolean) => void>>(
    new Map(),
  );

  // Track which messages have an active step running (so we know which id
  // to pass to window.api.stopCommand). Map from message-id → currently-
  // running step's id (the id passed to startCommand). Cleared on step
  // completion. Used by the public stopCommand() action.
  const activeStepIdsRef = useRef<Map<string, string>>(new Map());

  // Custom dispatch: applies the reducer synchronously to the ref AND
  // schedules a React render. Same pattern as Phase 3.4.1 — keeps
  // messagesRef.current authoritative immediately after dispatch so the
  // orchestrator can read freshly-applied state without waiting for the
  // commit/effect cycle.
  const dispatch = useCallback((action: Action) => {
    const next = reduce(messagesRef.current, action);
    messagesRef.current = next;
    setMessages(next);
  }, []);

  // Bounce-to-login helper. Identical contract to Phase 3.4.1's version:
  // kill running shells, cancel any in-flight synthesize streams, clear
  // messages, flip auth status. Synchronous so React 18 batches all the
  // setState calls into a single commit (no flash of empty conversation).
  const bounceToLogin = useCallback((): void => {
    for (const m of messagesRef.current) {
      // Kill any running step for this message.
      const stepId = activeStepIdsRef.current.get(m.id);
      if (stepId) window.api.stopCommand(stepId);
      // Cancel any in-flight synthesize stream for this message.
      if (m.status === 'synthesizing' || m.status === 'streaming') {
        window.api.synthesizeCancel(m.id);
      }
    }
    activeStepIdsRef.current.clear();
    // Release every paused Plan Card promise as cancelled so the
    // orchestrator can unwind cleanly. Without this, the awaited Promise
    // in submitInput would never settle and the closure would leak
    // until GC. CLEAR_ALL below drops the messages either way, so the
    // orchestrator's terminal dispatch is a no-op — but unblocking it
    // matters so the async function returns and its scope is freed.
    for (const resolve of pendingConfirmationsRef.current.values()) {
      resolve(false);
    }
    pendingConfirmationsRef.current.clear();
    dispatch({ type: 'CLEAR_ALL' });
    forceSignOut();
  }, [dispatch, forceSignOut]);

  // Fetch environment (platform + shell) once on mount.
  useEffect(() => {
    let cancelled = false;
    window.api.getEnvironment().then((env) => {
      if (!cancelled) setEnvironment(env);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Reveal-smoothing interval. 20ms tick, advance finalResponse by 1 char
  // toward pendingResponse for each message that's behind. Idle ticks are
  // a single .map with no setMessages call (no React re-render). Cleared
  // on unmount via the return.
  useEffect(() => {
    const intervalId = setInterval(() => {
      const current = messagesRef.current;
      let changed = false;
      const next = current.map((m) => {
        if (m.finalResponse.length < m.pendingResponse.length) {
          changed = true;
          return {
            ...m,
            finalResponse: m.pendingResponse.slice(0, m.finalResponse.length + 1),
          };
        }
        return m;
      });
      if (changed) {
        messagesRef.current = next;
        setMessages(next);
      }
    }, 20);
    return () => clearInterval(intervalId);
  }, []);

  // Synthesize stream subscription. Single listener registered once on mount.
  useEffect(() => {
    const off = window.api.onSynthesizeEvent((event) => {
      if (event.type === 'delta') {
        dispatch({ type: 'SYNTHESIZE_DELTA', id: event.messageId, text: event.text });
      } else if (event.type === 'done') {
        dispatch({ type: 'TURN_DONE', id: event.messageId });
      } else {
        // event.type === 'error'
        if (event.code === 'unauthorized') {
          bounceToLogin();
          return;
        }
        dispatch({
          type: 'SYNTHESIZE_ERROR',
          id: event.messageId,
          message: synthesizeErrorMessage(event.code),
        });
      }
    });
    return () => off();
  }, [dispatch, bounceToLogin]);

  // Unmount cleanup. A conversation tab can be closed while a command is
  // still running or a synthesize stream is open; without this the shell
  // process would keep running with its IPC events landing on a
  // listener that no longer exists. Mirrors bounceToLogin's teardown,
  // minus the message clear (the component is going away anyway).
  //
  // Reading the refs' .current inside the cleanup is intentional — we
  // want the LATEST running steps / streaming messages at unmount time,
  // not whatever was set when the effect first ran. The exhaustive-deps
  // ref-in-cleanup warning assumes a DOM-node ref; these are data refs,
  // so the warning doesn't apply.
  useEffect(() => {
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps
      for (const stepId of activeStepIdsRef.current.values()) {
        window.api.stopCommand(stepId);
      }
      for (const m of messagesRef.current) {
        if (m.status === 'synthesizing' || m.status === 'streaming') {
          window.api.synthesizeCancel(m.id);
        }
      }
    };
  }, []);

  // Sync settled turn outcomes back to the prompt-history log so the
  // Timeline hover card can show commands + conclusion. Each id is
  // written once — a Set keeps idempotent across re-renders driven
  // by reveal-smoothing or status-indicator changes after the turn
  // has already settled.
  const writtenHistoryRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const m of messages) {
      if (m.historyEntryId.length === 0) continue;
      if (writtenHistoryRef.current.has(m.historyEntryId)) continue;
      if (!isSettledTurnStatus(m.status)) continue;
      // Wait until reveal-smoothing has caught up so the outcome
      // captures the FULL prose, not a half-revealed snippet.
      if (m.finalResponse.length < m.pendingResponse.length) continue;
      const update = deriveHistoryUpdate(m);
      if (update !== null) {
        updatePromptOutcome(m.historyEntryId, update);
        writtenHistoryRef.current.add(m.historyEntryId);
      }
    }
  }, [messages]);

  // ── Step execution helper ──────────────────────────────────────────────
  // Runs one step locally via the existing command-runner IPC. Resolves
  // when the step exits (naturally or via signal). Throws nothing — even
  // kills resolve normally with signal set.
  //
  // Dispatch sequence per step:
  //   STEP_START                ← step flips queued → running
  //   STEP_OUTPUT × N           ← one per stdout/stderr chunk (live)
  //   STEP_DONE (status=...)    ← step finalizes, executionLog gets entry
  //
  // The orchestrator awaits this and then decides whether to continue,
  // skip remaining steps (on kill or failure), or branch on displayMode.
  const runStep = useCallback(
    (
      messageId: string,
      stepIndex: number,
      step: PlanStep,
      // Absolute directory to run the command in. Resolved once per turn
      // by submitInput (the conversation's cwd, or home if folderless)
      // and threaded through so every step of the turn runs consistently.
      stepCwd: string,
      // The user's shell, threaded through to startCommand so the main
      // process can invoke the right shell binary for this command.
      stepShell: Shell,
    ): Promise<ExecutionLogEntry> => {
      return new Promise<ExecutionLogEntry>((resolve) => {
        const stepId = `${messageId}::${stepIndex}`;
        let output = '';

        // Silence backstop: if the step produces no output and doesn't
        // exit for SILENCE_NOTICE_MS, it may be a command waiting for
        // input Vorlox can't answer. armSilence (re)starts the timer;
        // any output or the exit clears it. STEP_STALLED just surfaces a
        // calm notice — nothing is killed.
        let silenceTimer: ReturnType<typeof setTimeout> | null = null;
        const clearSilence = () => {
          if (silenceTimer !== null) {
            clearTimeout(silenceTimer);
            silenceTimer = null;
          }
        };
        const armSilence = () => {
          clearSilence();
          silenceTimer = setTimeout(() => {
            dispatch({ type: 'STEP_STALLED', id: messageId });
          }, SILENCE_NOTICE_MS);
        };

        // Subscribe to output and exit events for THIS step's id.
        const offOutput = window.api.onCommandOutput(({ id, data }) => {
          if (id !== stepId) return;
          output += data;
          dispatch({ type: 'STEP_OUTPUT', id: messageId, index: stepIndex, data });
          armSilence(); // output means it's alive — restart the clock
        });
        const offExit = window.api.onCommandExit(({ id, code, signal }) => {
          if (id !== stepId) return;
          offOutput();
          offExit();
          clearSilence();
          activeStepIdsRef.current.delete(messageId);

          // Decide step status from exit info:
          //   signal != null  → the runner reports signal on user-initiated
          //                     stop (POSIX SIGTERM or the Windows taskkill
          //                     sentinel from command-runner.ts). Treat as
          //                     'cancelled' — the user paused the plan, not
          //                     a command error.
          //   exitCode === 0  → done
          //   otherwise       → failed (real command error)
          const stepStatus: 'done' | 'failed' | 'cancelled' =
            signal != null ? 'cancelled' : code === 0 ? 'done' : 'failed';

          dispatch({
            type: 'STEP_DONE',
            id: messageId,
            index: stepIndex,
            status: stepStatus,
            output,
            exitCode: code,
            signal,
          });

          resolve({
            stepIndex,
            command: step.command,
            output,
            exitCode: code,
            signal,
          });
        });

        activeStepIdsRef.current.set(messageId, stepId);
        dispatch({ type: 'STEP_START', id: messageId, index: stepIndex });
        window.api.startCommand({
          id: stepId,
          command: step.command,
          cwd: stepCwd,
          // The user's actual shell rides along so the main process can
          // pick the right shell binary — without this, PowerShell
          // cmdlets get invoked through cmd.exe and fail.
          shell: stepShell,
        });
        armSilence(); // start the silence clock for this step
      });
    },
    [dispatch],
  );

  // ── submitInput: the orchestrator ──────────────────────────────────────
  const submitInput = useCallback(
    async (userInput: string) => {
      const trimmed = userInput.trim();
      if (trimmed.length === 0) return;
      // Only `environment` is mandatory now — a folderless conversation
      // (cwd === null) is fine. The effective directory for both the
      // backend plan context and local command execution falls back to
      // the user's home directory when no folder is chosen.
      if (!environment) return;
      const effectiveCwd = cwd?.absolute ?? environment.homeDir;

      // Snapshot the conversation thread BEFORE adding the new turn.
      // messagesRef is authoritative immediately (custom synchronous
      // dispatch), so this must be captured before INPUT_SUBMITTED.
      const history = messagesRef.current.map(toHistoryEntry);

      // Append every prompt to Vorlox's own persistent log, so the
      // built-in "show me my history" view and the Timeline sidebar
      // can list what the user has asked across sessions. Done
      // before any branching so even failed turns are remembered.
      // The returned id lets us update this entry with commands +
      // outcome once the turn settles.
      const historyEntryId = appendPrompt(trimmed);

      const id = crypto.randomUUID();
      dispatch({
        type: 'INPUT_SUBMITTED',
        id,
        userInput: trimmed,
        // Empty string for folderless turns — the field is stored for
        // history but isn't rendered prominently.
        cwd: cwd?.display ?? '',
        historyEntryId,
      });
      setForceScrollVersion((v) => v + 1);

      // 1. /api/turn — plan generation
      const planMode = planModeRef.current;
      const planResult = await window.api.planTurn({
        userInput: trimmed,
        context: {
          cwd: effectiveCwd,
          platform: environment.platform,
          shell: environment.shell,
          focusedFile,
        },
        planMode,
        history,
      });

      if (!planResult.ok) {
        if (planResult.code === 'unauthorized') {
          bounceToLogin();
          return;
        }
        dispatch({
          type: 'PLANNING_ERROR',
          id,
          message: planningErrorMessage(planResult.code),
        });
        return;
      }

      const plan = planResult.data;

      // 2. cd-special-case
      if (plan.isCdCommand) {
        if (!plan.cdTarget) {
          dispatch({
            type: 'CD_ERROR',
            id,
            message: "Couldn't find that folder. Could you double-check the path?",
          });
          return;
        }
        try {
          const newCwd = await window.api.setCwd(plan.cdTarget);
          // Hand the resolved cwd back to the owning ConversationView so
          // its per-tab cwd state (and the header) update. window.api.setCwd
          // only validates + resolves the path here; it is no longer the
          // source of truth for the working directory.
          onCwdChangeRef.current(newCwd);
          dispatch({ type: 'CD_SUCCESS', id, displayPath: newCwd.display });
        } catch {
          dispatch({
            type: 'CD_ERROR',
            id,
            message: "Couldn't find that folder. Could you double-check the path?",
          });
        }
        return;
      }

      // 2b. built-in list — Vorlox renders the folder contents directly
      //     via the directory API; no shell command runs. listTarget is
      //     null for "the current folder," or an absolute / "~/"-prefixed
      //     path. window.api.listDir handles tilde expansion and
      //     resolves to an absolute path on the listing it returns.
      if (plan.isListCommand) {
        const target = plan.listTarget ?? effectiveCwd;
        const listing = await window.api.listDir(target);
        if (listing.error) {
          dispatch({ type: 'LIST_ERROR', id, message: listing.error });
          return;
        }
        dispatch({ type: 'LIST_SUCCESS', id, listing });
        return;
      }

      // 2c. built-in prompt history — Vorlox reads its own log from
      //     localStorage and renders the entries directly. No shell
      //     command runs. The head entry is the prompt we just
      //     appended for this very turn; drop only that one so the
      //     "show me history" request doesn't appear inside its own
      //     output. Prior identical prompts (if the user has asked
      //     for history before) remain visible.
      if (plan.isHistoryCommand) {
        const limit = plan.historyLimit ?? 50;
        const all = readPromptHistory();
        const withoutHead =
          all.length > 0 && all[0].text === trimmed ? all.slice(1) : all;
        const entries = withoutHead.slice(0, Math.max(1, limit));
        dispatch({ type: 'HISTORY_SHOWN', id, entries });
        return;
      }

      // 3. reply — the AI answered without running commands: a clarifying
      //    question, advice, a recommendation, or a calm decline. The
      //    backend signals this with empty steps (and not a cd intent);
      //    plan.plan carries the AI's message. Footguns don't fall here —
      //    they have steps and trigger the Review Needed card below.
      if (plan.steps.length === 0) {
        dispatch({ type: 'REPLIED', id, text: plan.plan });
        return;
      }

      // 4. Execute each step locally.
      //    PLAN_RECEIVED flips status → 'executing' OR 'awaiting-confirmation'
      //    depending on whether the turn needs human approval first.
      //    Approval is required when EITHER:
      //      a) the user has Plan Mode on (session-wide review preference),
      //      b) the backend flagged a footgun on any step (forced gate even
      //         with Plan Mode off; the stripped Plan Card surfaces the
      //         specific risk).
      //    The Plan Card component branches its render on plan.footgunDetected
      //    to swap caption/copy/button label, so a single pause-and-await
      //    path handles both cases.
      const needsConfirmation = planMode || plan.footgunDetected !== false;
      dispatch({
        type: 'PLAN_RECEIVED',
        id,
        plan,
        pauseForConfirmation: needsConfirmation,
      });
      dispatch({ type: 'STEPS_INITIALIZED', id, steps: plan.steps });

      // 4b. Pause for confirmation. Stash a resolver, await user decision.
      //     confirmPlan / cancelPlan dispatch the status transition AND
      //     resolve the promise. bounceToLogin resolves all pending as
      //     cancelled to unblock the orchestrator.
      if (needsConfirmation) {
        const confirmed = await new Promise<boolean>((resolve) => {
          pendingConfirmationsRef.current.set(id, resolve);
        });
        if (!confirmed) {
          // PLAN_CANCELLED already dispatched by cancelPlan — terminal state.
          return;
        }
        // PLAN_CONFIRMED already dispatched by confirmPlan — falls through
        // to the execution loop below with status='executing'.
      }

      const executionLog: ExecutionLogEntry[] = [];
      let killed = false;

      for (let i = 0; i < plan.steps.length; i += 1) {
        const entry = await runStep(
          id,
          i,
          plan.steps[i],
          effectiveCwd,
          environment.shell,
        );
        executionLog.push(entry);
        if (entry.signal != null) {
          killed = true;
          // Mark every remaining queued step as 'skipped' so the StepRow
          // visual tells the truth: those commands never ran.
          for (let j = i + 1; j < plan.steps.length; j += 1) {
            dispatch({
              type: 'STEP_DONE',
              id,
              index: j,
              status: 'skipped',
              output: '',
              exitCode: null,
              signal: null,
            });
          }
          break;
        }
      }

      if (killed) {
        dispatch({ type: 'KILLED', id });
        return;
      }

      // 6. Branch on displayMode.
      //    verbatim → no synthesize call. The Message renders per-step
      //               raw output blocks (header + body in JetBrains Mono).
      //               Status flips straight to 'done'.
      //    summary  → /api/synthesize as before; reveal-smoothed prose.
      if (plan.displayMode === 'verbatim') {
        dispatch({ type: 'TURN_DONE', id });
        return;
      }

      dispatch({
        type: 'STATUS_INDICATOR',
        id,
        info: {
          label: 'Reviewing the output',
          alts: ['Writing the summary'],
        },
      });
      window.api.synthesizeStart({
        messageId: id,
        planId: plan.planId,
        intent: plan.intent,
        plan: plan.plan,
        executionLog,
      });
      // Stream events arrive via the onSynthesizeEvent listener and drive
      // SYNTHESIZE_DELTA / TURN_DONE / SYNTHESIZE_ERROR dispatches.
      // No further action needed in this orchestrator.
    },
    [cwd, environment, focusedFile, dispatch, bounceToLogin, runStep],
  );

  // Public stop / pause. Cancels whatever is currently in motion for
  // this turn. Precedence:
  //   - executing            → kill the running step (existing
  //                            behaviour; step exit handler will
  //                            dispatch KILLED).
  //   - synthesizing /
  //     streaming            → cancel the synthesize SSE stream AND
  //                            dispatch KILLED so the message flips
  //                            out of the in-progress state and
  //                            reveal-smoothing stops at the current
  //                            visible position.
  //   - done / replied with
  //     active reveal        → freeze reveal-smoothing at the current
  //                            position. The turn is already settled
  //                            (status doesn't change) — we just stop
  //                            animating more text in.
  //   - other states         → no-op (nothing to stop).
  const stopCommand = useCallback(
    (messageId: string) => {
      const stepId = activeStepIdsRef.current.get(messageId);
      if (stepId) {
        window.api.stopCommand(stepId);
        return;
      }
      const message = messagesRef.current.find((m) => m.id === messageId);
      if (!message) return;
      if (message.status === 'synthesizing' || message.status === 'streaming') {
        window.api.synthesizeCancel(messageId);
        dispatch({ type: 'KILLED', id: messageId });
        return;
      }
      if (
        (message.status === 'done' || message.status === 'replied') &&
        message.finalResponse.length < message.pendingResponse.length
      ) {
        dispatch({ type: 'FREEZE_REVEAL', id: messageId });
      }
    },
    [dispatch],
  );

  // Plan Card "Run" handler. Pulls the resolver from the pending map,
  // dispatches PLAN_CONFIRMED (which flips status to 'executing'), then
  // resolves the orchestrator's awaited promise with true. Order matters:
  // dispatch first so the React render with new status happens BEFORE the
  // orchestrator picks back up — the next synchronous tick of submitInput
  // sees status='executing' rather than 'awaiting-confirmation' if it
  // were ever to inspect state directly.
  const confirmPlan = useCallback(
    (messageId: string) => {
      const resolve = pendingConfirmationsRef.current.get(messageId);
      if (!resolve) return; // already settled (defensive — UI shouldn't fire twice)
      pendingConfirmationsRef.current.delete(messageId);
      dispatch({ type: 'PLAN_CONFIRMED', id: messageId });
      resolve(true);
    },
    [dispatch],
  );

  // Plan Card "Cancel" handler. Same shape as confirmPlan but resolves
  // false, leaving the turn in 'cancelled-before-run' as its terminal
  // state.
  const cancelPlan = useCallback(
    (messageId: string) => {
      const resolve = pendingConfirmationsRef.current.get(messageId);
      if (!resolve) return;
      pendingConfirmationsRef.current.delete(messageId);
      dispatch({ type: 'PLAN_CANCELLED', id: messageId });
      resolve(false);
    },
    [dispatch],
  );

  return {
    messages,
    forceScrollVersion,
    submitInput,
    stopCommand,
    confirmPlan,
    cancelPlan,
  };
}
