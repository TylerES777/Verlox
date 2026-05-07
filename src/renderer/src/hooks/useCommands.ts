import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BackendErrorCode,
  CwdInfo,
  EnvironmentInfo,
  TranslateResponse,
} from '@shared/types';
import { useAuth } from '../contexts/AuthContext';

export type CommandStatus =
  | 'translating'
  | 'translation-error'    // infrastructure failure (network, server, rate_limit)
  | 'refused'              // model declined to translate (gibberish/harmful/ambiguous)
  | 'cd-success'
  | 'cd-error'
  | 'awaiting-confirmation'
  | 'cancelled'
  | 'running'
  | 'exited'
  | 'killed';

export type ExplanationStatus = 'idle' | 'streaming' | 'done' | 'error';

export interface CommandMessage {
  id: string;
  userInput: string;
  cwd: string;

  status: CommandStatus;

  intent: string;
  explanation: string;
  proposedCommand: string;
  requiresConfirmation: boolean;
  confidence: 'high' | 'medium' | 'low';
  isCdCommand: boolean;
  cdTarget: string | null;

  cdResolvedDisplay: string | null;

  command: string;
  output: string;
  exitCode: number | null;
  signal: string | null;

  errorMessage: string | null;

  // pendingExplanation accumulates raw deltas as the SSE arrives.
  // finalExplanation is what Message.tsx renders; the reveal timer
  // advances it one character per 20ms tick toward pendingExplanation.
  // Decouples the data layer (deltas land in semantic chunks of ~30
  // chars) from the display layer (smooth character-by-character feel).
  pendingExplanation: string;
  finalExplanation: string;
  explanationStatus: ExplanationStatus;

  startedAt: number;
  endedAt: number | null;
}

type Action =
  | { type: 'INPUT_SUBMITTED'; id: string; userInput: string; cwd: string }
  | { type: 'TRANSLATION_SUCCESS'; id: string; response: TranslateResponse }
  | { type: 'TRANSLATION_ERROR'; id: string; message: string }
  | { type: 'CD_SUCCESS'; id: string; displayPath: string }
  | { type: 'CD_ERROR'; id: string; message: string }
  | { type: 'CONFIRMATION_RUN'; id: string }
  | { type: 'CONFIRMATION_CANCEL'; id: string }
  | { type: 'COMMAND_OUTPUT'; id: string; data: string }
  | { type: 'COMMAND_EXITED'; id: string; code: number | null; signal: string | null }
  | { type: 'EXPLAIN_DELTA'; id: string; text: string }
  | { type: 'EXPLAIN_DONE'; id: string }
  | { type: 'EXPLAIN_ERROR'; id: string }
  | { type: 'CLEAR_ALL' };

function newMessage(id: string, userInput: string, cwd: string): CommandMessage {
  return {
    id,
    userInput,
    cwd,
    status: 'translating',
    intent: '',
    explanation: '',
    proposedCommand: '',
    requiresConfirmation: false,
    confidence: 'medium',
    isCdCommand: false,
    cdTarget: null,
    cdResolvedDisplay: null,
    command: '',
    output: '',
    exitCode: null,
    signal: null,
    errorMessage: null,
    pendingExplanation: '',
    finalExplanation: '',
    explanationStatus: 'idle',
    startedAt: Date.now(),
    endedAt: null,
  };
}

function applyTranslation(m: CommandMessage, response: TranslateResponse): CommandMessage {
  const base: CommandMessage = {
    ...m,
    intent: response.intent,
    explanation: response.explanation,
    proposedCommand: response.command,
    requiresConfirmation: response.requiresConfirmation,
    confidence: response.confidence,
    isCdCommand: response.isCdCommand,
    cdTarget: response.cdTarget,
  };

  // Refusal path — model returned an empty command and isn't asking for cd.
  // Per the prompt's refusal section, this happens for gibberish, ambiguous,
  // or harmful requests; the model writes calm refusal copy in `explanation`.
  // Must come before the requiresConfirmation branch (refusals are typically
  // low-confidence, which forces requiresConfirmation:true upstream).
  if (response.command.trim().length === 0 && !response.isCdCommand) {
    return { ...base, status: 'refused', endedAt: Date.now() };
  }

  if (response.isCdCommand) {
    // Stay in 'translating' visually until the orchestrator's setCwd resolves
    // and dispatches CD_SUCCESS or CD_ERROR.
    return base;
  }
  if (response.requiresConfirmation) {
    return { ...base, status: 'awaiting-confirmation' };
  }
  return { ...base, status: 'running', command: response.command };
}

function reduce(state: CommandMessage[], action: Action): CommandMessage[] {
  switch (action.type) {
    case 'INPUT_SUBMITTED':
      return [...state, newMessage(action.id, action.userInput, action.cwd)];

    case 'TRANSLATION_SUCCESS':
      return state.map((m) => (m.id === action.id ? applyTranslation(m, action.response) : m));

    case 'TRANSLATION_ERROR':
      return state.map((m) =>
        m.id === action.id
          ? { ...m, status: 'translation-error', errorMessage: action.message, endedAt: Date.now() }
          : m,
      );

    case 'CD_SUCCESS':
      return state.map((m) =>
        m.id === action.id
          ? { ...m, status: 'cd-success', cdResolvedDisplay: action.displayPath, endedAt: Date.now() }
          : m,
      );

    case 'CD_ERROR':
      return state.map((m) =>
        m.id === action.id
          ? { ...m, status: 'cd-error', errorMessage: action.message, endedAt: Date.now() }
          : m,
      );

    case 'CONFIRMATION_RUN':
      return state.map((m) =>
        m.id === action.id ? { ...m, status: 'running', command: m.proposedCommand } : m,
      );

    case 'CONFIRMATION_CANCEL':
      return state.map((m) =>
        m.id === action.id ? { ...m, status: 'cancelled', endedAt: Date.now() } : m,
      );

    case 'COMMAND_OUTPUT':
      // Defensive: append regardless of current status. Main is async; if a
      // late chunk arrives after exit, we still want to capture it.
      return state.map((m) => (m.id === action.id ? { ...m, output: m.output + action.data } : m));

    case 'COMMAND_EXITED':
      return state.map((m) =>
        m.id === action.id
          ? {
              ...m,
              status: action.signal != null ? 'killed' : 'exited',
              exitCode: action.code,
              signal: action.signal,
              endedAt: Date.now(),
            }
          : m,
      );

    case 'EXPLAIN_DELTA':
      // Append to pendingExplanation only. The reveal timer advances
      // finalExplanation toward pending one char per 20ms tick.
      return state.map((m) =>
        m.id === action.id
          ? {
              ...m,
              pendingExplanation: m.pendingExplanation + action.text,
              explanationStatus: 'streaming',
            }
          : m,
      );

    case 'EXPLAIN_DONE':
      return state.map((m) =>
        m.id === action.id ? { ...m, explanationStatus: 'done' } : m,
      );

    case 'EXPLAIN_ERROR':
      // On error, catch finalExplanation up to whatever pending text we
      // have. Don't make the user wait for the reveal animation while
      // there's an error to read.
      return state.map((m) =>
        m.id === action.id
          ? {
              ...m,
              explanationStatus: 'error',
              finalExplanation: m.pendingExplanation,
            }
          : m,
      );

    case 'CLEAR_ALL':
      return [];
  }
}

function errorMessageForCode(code: BackendErrorCode): string {
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

export function useCommands(cwd: CwdInfo | null): {
  messages: CommandMessage[];
  forceScrollVersion: number;
  submitInput: (userInput: string) => Promise<void>;
  confirmRun: (id: string) => void;
  cancelRun: (id: string) => void;
  stopCommand: (id: string) => void;
} {
  const [messages, setMessages] = useState<CommandMessage[]>([]);
  const messagesRef = useRef<CommandMessage[]>([]);
  const [forceScrollVersion, setForceScrollVersion] = useState(0);
  const [environment, setEnvironment] = useState<EnvironmentInfo | null>(null);
  const { forceSignOut } = useAuth();

  // Custom dispatch: applies the reducer synchronously to the ref AND schedules
  // a React render. The ref-update timing matters: command-exit listeners read
  // the latest output via the ref, so the explain payload includes the full
  // accumulated stdout/stderr (not stale state from one tick ago).
  const dispatch = useCallback((action: Action) => {
    const next = reduce(messagesRef.current, action);
    messagesRef.current = next;
    setMessages(next);
  }, []);

  // Bounce to login. Triggered when a protected backend call returns 401,
  // which means the session token is no longer valid. Synchronous: kills
  // running shell processes, cancels in-flight explain streams, clears the
  // conversation, and flips auth status. React 18 batches all setState calls
  // so AuthGate swaps to LoginScreen in a single render — no flash of empty
  // conversation, no leakage of the previous user's history.
  const bounceToLogin = useCallback((): void => {
    for (const m of messagesRef.current) {
      if (m.status === 'running') window.api.stopCommand(m.id);
      if (m.explanationStatus === 'streaming') window.api.explainCancel(m.id);
    }
    dispatch({ type: 'CLEAR_ALL' });
    forceSignOut();
  }, [dispatch, forceSignOut]);

  // Fetch environment (platform + shell) once on mount; static for app lifetime.
  useEffect(() => {
    let cancelled = false;
    window.api.getEnvironment().then((env) => {
      if (!cancelled) setEnvironment(env);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Subscribe to command output + exit events from main.
  useEffect(() => {
    const offOutput = window.api.onCommandOutput(({ id, data }) => {
      dispatch({ type: 'COMMAND_OUTPUT', id, data });
    });
    const offExit = window.api.onCommandExit(({ id, code, signal }) => {
      dispatch({ type: 'COMMAND_EXITED', id, code, signal });

      // Explain only on natural exit, not user-initiated kill — telling the
      // user "this was stopped" adds nothing they don't already know.
      if (signal != null) return;

      // ref is current after dispatch above (synchronous via custom dispatch)
      const m = messagesRef.current.find((msg) => msg.id === id);
      if (!m || m.command.length === 0) return;

      // Skip explain for silent successes — exit 0 with empty output
      // (e.g. mkdir, touch). The card already shows the command ran cleanly;
      // a "command ran successfully" sentence would just be noise.
      if (code === 0 && m.output.trim().length === 0) return;

      window.api.explainStart({
        messageId: id,
        command: m.command,
        output: m.output,
        exitCode: code ?? 0,
      });
    });
    return () => {
      offOutput();
      offExit();
    };
  }, [dispatch]);

  // Subscribe to explain SSE events from main.
  useEffect(() => {
    const off = window.api.onExplainEvent((event) => {
      if (event.type === 'delta') {
        dispatch({ type: 'EXPLAIN_DELTA', id: event.messageId, text: event.text });
      } else if (event.type === 'done') {
        dispatch({ type: 'EXPLAIN_DONE', id: event.messageId });
      } else {
        // event.type === 'error'
        if (event.code === 'unauthorized') {
          bounceToLogin();
          return;
        }
        dispatch({ type: 'EXPLAIN_ERROR', id: event.messageId });
      }
    });
    return () => off();
  }, [dispatch, bounceToLogin]);

  // Reveal smoothing. Anthropic delivers deltas in semantic chunks of
  // ~30 chars, which for short explanations reads as a wall of text
  // dropped at once. This interval reveals one character per 20ms tick
  // from pendingExplanation into finalExplanation per message — strict
  // cadence, no acceleration if pending grows. Lag is acceptable.
  //
  // The interval no-ops when no message is "behind", so it costs almost
  // nothing while idle. Cleanup on unmount avoids leaks across the
  // ConversationScreen unmount/remount cycle (sign-out, 401 bounce).
  useEffect(() => {
    const intervalId = setInterval(() => {
      const current = messagesRef.current;
      let changed = false;
      const next = current.map((m) => {
        if (m.finalExplanation.length < m.pendingExplanation.length) {
          changed = true;
          return {
            ...m,
            finalExplanation: m.pendingExplanation.slice(0, m.finalExplanation.length + 1),
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

  const submitInput = useCallback(
    async (userInput: string) => {
      const trimmed = userInput.trim();
      if (trimmed.length === 0) return;
      if (!cwd || !environment) return;

      const id = crypto.randomUUID();
      dispatch({ type: 'INPUT_SUBMITTED', id, userInput: trimmed, cwd: cwd.display });
      setForceScrollVersion((v) => v + 1);

      const result = await window.api.translate({
        userInput: trimmed,
        context: {
          cwd: cwd.absolute,
          platform: environment.platform,
          shell: environment.shell,
        },
      });

      if (!result.ok) {
        if (result.code === 'unauthorized') {
          bounceToLogin();
          return;
        }
        dispatch({ type: 'TRANSLATION_ERROR', id, message: errorMessageForCode(result.code) });
        return;
      }

      const response = result.data;
      dispatch({ type: 'TRANSLATION_SUCCESS', id, response });

      // Refusal — reducer already moved status to 'refused'; nothing to do.
      if (response.command.trim().length === 0 && !response.isCdCommand) {
        return;
      }

      if (response.isCdCommand) {
        if (!response.cdTarget) {
          dispatch({
            type: 'CD_ERROR',
            id,
            message: "Couldn't find that folder. Could you double-check the path?",
          });
          return;
        }
        try {
          const newCwd = await window.api.setCwd(response.cdTarget);
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

      if (response.requiresConfirmation) {
        return;
      }

      // Auto-run path. Reducer already moved status='running' and command set.
      window.api.startCommand({ id, command: response.command });
    },
    [cwd, environment, dispatch, bounceToLogin],
  );

  const confirmRun = useCallback(
    (id: string) => {
      const m = messagesRef.current.find((msg) => msg.id === id);
      if (!m || m.status !== 'awaiting-confirmation') return;
      dispatch({ type: 'CONFIRMATION_RUN', id });
      window.api.startCommand({ id, command: m.proposedCommand });
    },
    [dispatch],
  );

  const cancelRun = useCallback(
    (id: string) => {
      dispatch({ type: 'CONFIRMATION_CANCEL', id });
    },
    [dispatch],
  );

  const stopCommand = useCallback((id: string) => {
    window.api.stopCommand(id);
  }, []);

  return { messages, forceScrollVersion, submitInput, confirmRun, cancelRun, stopCommand };
}
