import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BackendErrorCode,
  CwdInfo,
  EnvironmentInfo,
  ExecutionLogEntry,
  PlanResponse,
  PlanStep,
} from '@shared/types';
import { useAuth } from '../contexts/AuthContext';

// ── State machine ─────────────────────────────────────────────────────────

export type TurnStatus =
  | 'translating'        // /api/turn in flight
  | 'planning-error'     // /api/turn failed (network/server/rate-limit)
  | 'refused'            // model returned empty steps OR footgun (2a placeholder)
  | 'cd-success'         // cd handled
  | 'cd-error'           // cd path invalid
  | 'executing'          // running steps locally via window.api.startCommand
  | 'synthesizing'       // /api/synthesize connected, no deltas yet
  | 'streaming'          // first delta arrived; response prose flowing
  | 'done'               // synthesis complete (or refusal/cd-success terminal)
  | 'killed'             // user pressed stop on a running step
  | 'synthesize-error';  // /api/synthesize errored

export type StatusIndicatorPhase = 'examining' | 'running' | 'reviewing' | null;

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
}

// ── Reducer actions ───────────────────────────────────────────────────────

type Action =
  | { type: 'INPUT_SUBMITTED'; id: string; userInput: string; cwd: string }
  | { type: 'PLAN_RECEIVED'; id: string; plan: PlanResponse }
  | { type: 'PLANNING_ERROR'; id: string; message: string }
  | { type: 'REFUSED'; id: string; text: string }
  | { type: 'CD_SUCCESS'; id: string; displayPath: string }
  | { type: 'CD_ERROR'; id: string; message: string }
  | { type: 'STATUS_INDICATOR'; id: string; phase: StatusIndicatorPhase }
  | { type: 'STEP_DONE'; id: string; entry: ExecutionLogEntry }
  | { type: 'KILLED'; id: string }
  | { type: 'SYNTHESIZE_DELTA'; id: string; text: string }
  | { type: 'SYNTHESIZE_DONE'; id: string }
  | { type: 'SYNTHESIZE_ERROR'; id: string; message: string }
  | { type: 'CLEAR_ALL' };

function newMessage(id: string, userInput: string, cwd: string): CommandMessage {
  return {
    id,
    userInput,
    cwd,
    startedAt: Date.now(),
    endedAt: null,
    status: 'translating',
    statusIndicator: 'examining',
    plan: null,
    executionLog: [],
    pendingResponse: '',
    finalResponse: '',
    cdResolvedDisplay: null,
    errorMessage: null,
  };
}

function reduce(state: CommandMessage[], action: Action): CommandMessage[] {
  switch (action.type) {
    case 'INPUT_SUBMITTED':
      return [...state, newMessage(action.id, action.userInput, action.cwd)];

    case 'PLAN_RECEIVED':
      return state.map((m) =>
        m.id === action.id
          ? { ...m, plan: action.plan, status: 'executing', statusIndicator: 'running' }
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
      return state.map((m) =>
        m.id === action.id
          ? { ...m, executionLog: [...m.executionLog, action.entry] }
          : m,
      );

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

    case 'SYNTHESIZE_DONE':
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

export function useCommands(cwd: CwdInfo | null): {
  messages: CommandMessage[];
  forceScrollVersion: number;
  submitInput: (userInput: string) => Promise<void>;
  stopCommand: (id: string) => void;
} {
  const [messages, setMessages] = useState<CommandMessage[]>([]);
  const messagesRef = useRef<CommandMessage[]>([]);
  const [forceScrollVersion, setForceScrollVersion] = useState(0);
  const [environment, setEnvironment] = useState<EnvironmentInfo | null>(null);
  const { forceSignOut } = useAuth();

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
        dispatch({ type: 'SYNTHESIZE_DONE', id: event.messageId });
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
  // when the step exits (naturally or via signal). Returns the captured
  // ExecutionLogEntry. Throws nothing — even kills resolve normally with
  // signal set.
  const runStep = useCallback(
    (messageId: string, stepIndex: number, step: PlanStep): Promise<ExecutionLogEntry> => {
      return new Promise<ExecutionLogEntry>((resolve) => {
        const stepId = `${messageId}::${stepIndex}`;
        let output = '';

        // Subscribe to output and exit events for THIS step's id.
        const offOutput = window.api.onCommandOutput(({ id, data }) => {
          if (id === stepId) output += data;
        });
        const offExit = window.api.onCommandExit(({ id, code, signal }) => {
          if (id !== stepId) return;
          offOutput();
          offExit();
          activeStepIdsRef.current.delete(messageId);
          resolve({
            stepIndex,
            command: step.command,
            output,
            exitCode: code,
            signal,
          });
        });

        activeStepIdsRef.current.set(messageId, stepId);
        window.api.startCommand({ id: stepId, command: step.command });
      });
    },
    [],
  );

  // ── submitInput: the orchestrator ──────────────────────────────────────
  const submitInput = useCallback(
    async (userInput: string) => {
      const trimmed = userInput.trim();
      if (trimmed.length === 0) return;
      if (!cwd || !environment) return;

      const id = crypto.randomUUID();
      dispatch({ type: 'INPUT_SUBMITTED', id, userInput: trimmed, cwd: cwd.display });
      setForceScrollVersion((v) => v + 1);

      // 1. /api/turn — plan generation
      const planResult = await window.api.planTurn({
        userInput: trimmed,
        context: {
          cwd: cwd.absolute,
          platform: environment.platform,
          shell: environment.shell,
        },
        // 2a placeholder: Plan Mode UI doesn't exist yet (Chunk 4 wires it).
        // Always plan-mode-off for now.
        planMode: false,
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

      // 3. footgun (Chunk 2a placeholder — render as refusal-style message;
      //    Chunk 5 replaces this branch with the stripped Plan Card).
      if (plan.footgunDetected) {
        dispatch({
          type: 'REFUSED',
          id,
          text: `That action is risky: ${plan.footgunDetected.reason}. Vorlox isn't running it without explicit approval.`,
        });
        return;
      }

      // 4. refusal — model returned empty steps and not a cd intent.
      if (plan.steps.length === 0) {
        dispatch({ type: 'REFUSED', id, text: plan.plan });
        return;
      }

      // 5. Execute each step locally.
      dispatch({ type: 'PLAN_RECEIVED', id, plan });
      const executionLog: ExecutionLogEntry[] = [];
      let killed = false;

      for (let i = 0; i < plan.steps.length; i += 1) {
        const entry = await runStep(id, i, plan.steps[i]);
        dispatch({ type: 'STEP_DONE', id, entry });
        executionLog.push(entry);
        if (entry.signal != null) {
          killed = true;
          break;
        }
      }

      if (killed) {
        dispatch({ type: 'KILLED', id });
        return;
      }

      // 6. Synthesize the response prose. (2a fall-through: ignore
      //    displayMode and always synthesize. Chunk 2b adds the verbatim
      //    branch that renders raw output instead.)
      dispatch({ type: 'STATUS_INDICATOR', id, phase: 'reviewing' });
      window.api.synthesizeStart({
        messageId: id,
        planId: plan.planId,
        intent: plan.intent,
        plan: plan.plan,
        executionLog,
      });
      // Stream events arrive via the onSynthesizeEvent listener and drive
      // SYNTHESIZE_DELTA / SYNTHESIZE_DONE / SYNTHESIZE_ERROR dispatches.
      // No further action needed in this orchestrator.
    },
    [cwd, environment, dispatch, bounceToLogin, runStep],
  );

  // Public stop: cancels the currently-running step for the given message.
  const stopCommand = useCallback((messageId: string) => {
    const stepId = activeStepIdsRef.current.get(messageId);
    if (stepId) window.api.stopCommand(stepId);
  }, []);

  return { messages, forceScrollVersion, submitInput, stopCommand };
}
