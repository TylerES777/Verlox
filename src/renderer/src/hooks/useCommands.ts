import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BackendErrorCode,
  CwdInfo,
  EnvironmentInfo,
  ExecutionLogEntry,
  PlanDisplayMode,
  PlanResponse,
  PlanStep,
} from '@shared/types';
import { useAuth } from '../contexts/AuthContext';

// ── State machine ─────────────────────────────────────────────────────────

export type TurnStatus =
  | 'translating'             // /api/turn in flight
  | 'planning-error'          // /api/turn failed (network/server/rate-limit)
  | 'refused'                 // model returned empty steps OR footgun (2a placeholder)
  | 'cd-success'              // cd handled
  | 'cd-error'                // cd path invalid
  | 'awaiting-confirmation'   // Plan Mode: Plan Card visible, awaiting Run/Cancel
  | 'cancelled-before-run'    // user clicked Cancel on the Plan Card
  | 'executing'               // running steps locally via window.api.startCommand
  | 'synthesizing'            // /api/synthesize connected, no deltas yet
  | 'streaming'               // first delta arrived; response prose flowing
  | 'done'                    // synthesis complete (or refusal/cd-success terminal)
  | 'killed'                  // user pressed stop on a running step
  | 'synthesize-error';       // /api/synthesize errored

export type StatusIndicatorPhase = 'examining' | 'running' | 'reviewing' | null;

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
  statusIndicator: StatusIndicatorPhase;

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

  // For *-error states + planning-error / synthesize-error:
  errorMessage: string | null;

  // Peek state (Chunk 3). When true, StepRow renders the raw shell
  // command in JetBrains Mono below the title/description. Seeded from
  // the session-wide default at INPUT_SUBMITTED time and toggled per
  // turn via PEEK_TOGGLE — per-turn changes don't update the session
  // default. Only meaningful for displayMode === 'summary' turns;
  // verbatim turns ignore this since the verbatim block already shows
  // the command.
  peekEnabled: boolean;
}

// ── Reducer actions ───────────────────────────────────────────────────────

type Action =
  | {
      type: 'INPUT_SUBMITTED';
      id: string;
      userInput: string;
      cwd: string;
      peekEnabled: boolean;
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
  | { type: 'REFUSED'; id: string; text: string }
  | { type: 'CD_SUCCESS'; id: string; displayPath: string }
  | { type: 'CD_ERROR'; id: string; message: string }
  | { type: 'STATUS_INDICATOR'; id: string; phase: StatusIndicatorPhase }
  // STEPS_INITIALIZED takes the plan steps and seeds steps[] all queued.
  // Dispatched right after PLAN_RECEIVED, before any step starts.
  | { type: 'STEPS_INITIALIZED'; id: string; steps: PlanStep[] }
  // STEP_START flips a single step from queued → running.
  | { type: 'STEP_START'; id: string; index: number }
  // STEP_OUTPUT appends raw shell output to a running step. Fires on every
  // stdout/stderr chunk so the verbatim/details panels can render live.
  | { type: 'STEP_OUTPUT'; id: string; index: number; data: string }
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
  // PEEK_TOGGLE flips the per-turn peekEnabled flag. Per-turn only —
  // the session-wide default lives in usePeekDefault and is only read
  // at INPUT_SUBMITTED time.
  | { type: 'PEEK_TOGGLE'; id: string }
  | { type: 'CLEAR_ALL' };

function newMessage(
  id: string,
  userInput: string,
  cwd: string,
  peekEnabled: boolean,
): CommandMessage {
  return {
    id,
    userInput,
    cwd,
    startedAt: Date.now(),
    endedAt: null,
    status: 'translating',
    statusIndicator: 'examining',
    plan: null,
    displayMode: null,
    steps: [],
    executionLog: [],
    pendingResponse: '',
    finalResponse: '',
    cdResolvedDisplay: null,
    errorMessage: null,
    peekEnabled,
  };
}

function reduce(state: CommandMessage[], action: Action): CommandMessage[] {
  switch (action.type) {
    case 'INPUT_SUBMITTED':
      return [
        ...state,
        newMessage(action.id, action.userInput, action.cwd, action.peekEnabled),
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
              statusIndicator: action.pauseForConfirmation ? null : 'running',
            }
          : m,
      );

    case 'PLAN_CONFIRMED':
      return state.map((m) =>
        m.id === action.id
          ? { ...m, status: 'executing', statusIndicator: 'running' }
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
      return state.map((m) =>
        m.id === action.id
          ? {
              ...m,
              steps: m.steps.map((s) =>
                s.index === action.index ? { ...s, status: 'running' as const } : s,
              ),
            }
          : m,
      );

    case 'STEP_OUTPUT':
      return state.map((m) =>
        m.id === action.id
          ? {
              ...m,
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

    case 'REFUSED':
      // Refusal text flows through reveal-smoothing (it's AI-generated prose).
      return state.map((m) =>
        m.id === action.id
          ? {
              ...m,
              status: 'refused',
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

    case 'STATUS_INDICATOR':
      return state.map((m) =>
        m.id === action.id ? { ...m, statusIndicator: action.phase } : m,
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

    case 'PEEK_TOGGLE':
      return state.map((m) =>
        m.id === action.id ? { ...m, peekEnabled: !m.peekEnabled } : m,
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

// ── Hook ──────────────────────────────────────────────────────────────────

export function useCommands(
  cwd: CwdInfo | null,
  // Session-wide peek default. Each new turn copies this value into its
  // CommandMessage at INPUT_SUBMITTED time. Read via a ref so submitInput
  // always sees the latest value without listing it as a dependency
  // (changing the default mid-session shouldn't tear down the orchestrator
  // closures or invalidate any in-flight turn).
  peekDefault: boolean,
  // Session-wide Plan Mode flag (Chunk 4). When true, every new turn
  // pauses after /api/turn and renders the Plan Card instead of running
  // immediately. Read via a ref so submitInput sees the latest value.
  // Cd-only and footgun-only turns bypass Plan Mode (cd is auto-handled;
  // footguns get their own stripped Plan Card in Chunk 5).
  planMode: boolean,
): {
  messages: CommandMessage[];
  forceScrollVersion: number;
  submitInput: (userInput: string) => Promise<void>;
  stopCommand: (id: string) => void;
  togglePeek: (messageId: string) => void;
  confirmPlan: (messageId: string) => void;
  cancelPlan: (messageId: string) => void;
} {
  const [messages, setMessages] = useState<CommandMessage[]>([]);
  const messagesRef = useRef<CommandMessage[]>([]);
  const [forceScrollVersion, setForceScrollVersion] = useState(0);
  const [environment, setEnvironment] = useState<EnvironmentInfo | null>(null);
  const { forceSignOut } = useAuth();

  // Mirror peekDefault into a ref so submitInput reads the latest value
  // without re-creating its useCallback closure when the user toggles
  // the session preference.
  const peekDefaultRef = useRef(peekDefault);
  useEffect(() => {
    peekDefaultRef.current = peekDefault;
  }, [peekDefault]);

  // Same pattern for planMode. The orchestrator captures the value at
  // submit time (not at confirm time) — flipping Plan Mode off mid-turn
  // does NOT release a paused turn; it has to be confirmed or cancelled.
  const planModeRef = useRef(planMode);
  useEffect(() => {
    planModeRef.current = planMode;
  }, [planMode]);

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
    ): Promise<ExecutionLogEntry> => {
      return new Promise<ExecutionLogEntry>((resolve) => {
        const stepId = `${messageId}::${stepIndex}`;
        let output = '';

        // Subscribe to output and exit events for THIS step's id.
        const offOutput = window.api.onCommandOutput(({ id, data }) => {
          if (id !== stepId) return;
          output += data;
          dispatch({ type: 'STEP_OUTPUT', id: messageId, index: stepIndex, data });
        });
        const offExit = window.api.onCommandExit(({ id, code, signal }) => {
          if (id !== stepId) return;
          offOutput();
          offExit();
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
        window.api.startCommand({ id: stepId, command: step.command });
      });
    },
    [dispatch],
  );

  // ── submitInput: the orchestrator ──────────────────────────────────────
  const submitInput = useCallback(
    async (userInput: string) => {
      const trimmed = userInput.trim();
      if (trimmed.length === 0) return;
      if (!cwd || !environment) return;

      const id = crypto.randomUUID();
      dispatch({
        type: 'INPUT_SUBMITTED',
        id,
        userInput: trimmed,
        cwd: cwd.display,
        peekEnabled: peekDefaultRef.current,
      });
      setForceScrollVersion((v) => v + 1);

      // 1. /api/turn — plan generation
      const planMode = planModeRef.current;
      const planResult = await window.api.planTurn({
        userInput: trimmed,
        context: {
          cwd: cwd.absolute,
          platform: environment.platform,
          shell: environment.shell,
        },
        planMode,
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

      // 3. refusal — model returned empty steps and not a cd intent.
      //    'refused' is reserved for model-driven refusals after Chunk 5:
      //    footguns no longer fall through here, they trigger the Review
      //    Needed card below.
      if (plan.steps.length === 0) {
        dispatch({ type: 'REFUSED', id, text: plan.plan });
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
        const entry = await runStep(id, i, plan.steps[i]);
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

      dispatch({ type: 'STATUS_INDICATOR', id, phase: 'reviewing' });
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
    [cwd, environment, dispatch, bounceToLogin, runStep],
  );

  // Public stop: cancels the currently-running step for the given message.
  const stopCommand = useCallback((messageId: string) => {
    const stepId = activeStepIdsRef.current.get(messageId);
    if (stepId) window.api.stopCommand(stepId);
  }, []);

  // Public per-turn peek toggle. Flips peekEnabled on the given message.
  // Independent of the session-wide default — toggling here does not
  // call setPeekDefault.
  const togglePeek = useCallback(
    (messageId: string) => {
      dispatch({ type: 'PEEK_TOGGLE', id: messageId });
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
    togglePeek,
    confirmPlan,
    cancelPlan,
  };
}
