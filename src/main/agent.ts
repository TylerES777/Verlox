import type {
  AddProviderInput,
  AgentPlanAllResult,
  AgentPlanInput,
  AgentStepResult,
  BackendErrorCode,
  ModelChoice,
  TurnHistoryEntry,
} from '@shared/types';
import { planTurn } from './backend-client';
import { getProvider, getProviderKey } from './settings-store';
import { planAllAnthropic, planStepAnthropic, verifyAnthropic } from './agent-anthropic';
import { planAllOpenAI, planStepOpenAI, verifyOpenAI } from './agent-openai';

// Routes a "what's the next step?" request to the right engine:
//   - 'custom': call the chosen provider directly from this machine with the
//     saved key (no Verlox backend, no Verlox credits).
//   - 'verlox': reuse the Verlox backend planner one step at a time, feeding
//     prior results back as history so it can continue.
// Either way it returns the same AgentStep shape.

function backendErrorMessage(code: BackendErrorCode): string {
  switch (code) {
    case 'unauthorized':
      return 'Please sign in to use Verlox’s AI (or add your own provider in settings).';
    case 'limit_reached':
      return 'You are out of Verlox credits for now (or add your own provider in settings).';
    case 'feature_capped':
      return 'You have hit a plan limit. Add your own provider in settings to keep going.';
    case 'network':
      return 'I could not reach the server. Check your connection.';
    case 'rate_limit':
      return 'Too many requests right now. Try again in a moment.';
    default:
      return 'Something went wrong asking the AI. Please try again.';
  }
}

export async function planStep(
  input: AgentPlanInput,
): Promise<AgentStepResult> {
  // --- Custom provider path: call it directly ---
  if (input.engine === 'custom') {
    const provider = input.providerId ? getProvider(input.providerId) : undefined;
    if (!provider) {
      return { ok: false, error: 'That AI provider is no longer set up. Pick another in the model menu.' };
    }
    const key = input.providerId ? getProviderKey(input.providerId) : null;
    if (!key) {
      return { ok: false, error: 'That provider has no saved key. Re-add it in settings.' };
    }
    try {
      const step =
        provider.format === 'anthropic'
          ? await planStepAnthropic(input, key, provider.model, provider.baseUrl)
          : await planStepOpenAI(input, key, provider.model, provider.baseUrl);
      return { ok: true, step };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  // --- Verlox backend path ---
  const history: TurnHistoryEntry[] = input.priorSteps.map((s) => ({
    userInput: input.goal,
    outcome:
      `Ran: ${s.command}\nExit code: ${s.exitCode}\nOutput:\n` +
      (s.output.trim() ? s.output.trim().slice(-1500) : '(no output)'),
  }));
  const ctx = input.terminalContext
    ? `What's currently on the user's terminal screen(s):\n${input.terminalContext}\n\n`
    : '';
  const userInput =
    ctx +
    (input.priorSteps.length === 0
      ? input.goal
      : `Continue toward this goal: "${input.goal}". The previous step already ran; its result is in the history. Give only the single next step needed. If the goal is now complete, reply with no command.`);

  const res = await planTurn({
    userInput,
    context: {
      cwd: input.cwd,
      platform: input.platform,
      shell: input.shell,
      focusedFile: null,
    },
    planMode: false,
    model: input.model as ModelChoice,
    history,
    runningProcesses: [],
    attachedImage: input.image ?? null,
  });

  if (!res.ok) return { ok: false, error: backendErrorMessage(res.code) };

  const plan = res.data;
  if (plan.steps.length === 0) {
    return {
      ok: true,
      step: {
        done: true,
        message: plan.plan?.trim() || plan.intent?.trim() || 'All done.',
        command: null,
        reason: '',
        readOnly: true,
        risk: null,
      },
    };
  }

  const step = plan.steps[0];
  return {
    ok: true,
    step: {
      done: false,
      message: plan.plan?.trim() || plan.intent?.trim() || '',
      command: step.command,
      reason: step.description?.trim() || step.title?.trim() || '',
      readOnly: plan.affects.readOnly,
      risk: plan.footgunDetected ? plan.footgunDetected.reason : null,
    },
  };
}

// Plan-first: lay out the COMPLETE ordered plan in one call (for the approve-
// the-whole-plan UI), instead of one step at a time.
export async function planAll(input: AgentPlanInput): Promise<AgentPlanAllResult> {
  // --- Custom provider path ---
  if (input.engine === 'custom') {
    const provider = input.providerId ? getProvider(input.providerId) : undefined;
    if (!provider) {
      return { ok: false, error: 'That AI provider is no longer set up. Pick another in the model menu.' };
    }
    const key = input.providerId ? getProviderKey(input.providerId) : null;
    if (!key) {
      return { ok: false, error: 'That provider has no saved key. Re-add it in settings.' };
    }
    try {
      const plan =
        provider.format === 'anthropic'
          ? await planAllAnthropic(input, key, provider.model, provider.baseUrl)
          : await planAllOpenAI(input, key, provider.model, provider.baseUrl);
      return { ok: true, plan };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  // --- Verlox backend path: the planner already returns multiple steps. ---
  const ctx = input.terminalContext
    ? `What's currently on the user's terminal screen(s):\n${input.terminalContext}\n\n`
    : '';
  const res = await planTurn({
    userInput: ctx + input.goal,
    context: {
      cwd: input.cwd,
      platform: input.platform,
      shell: input.shell,
      focusedFile: null,
    },
    planMode: true,
    model: input.model as ModelChoice,
    history: [],
    runningProcesses: [],
    attachedImage: input.image ?? null,
  });
  if (!res.ok) return { ok: false, error: backendErrorMessage(res.code) };

  const plan = res.data;
  const summary = plan.plan?.trim() || plan.intent?.trim() || '';
  if (plan.steps.length === 0) {
    return {
      ok: true,
      plan: { done: true, message: summary || 'All done.', summary: summary || 'All done.', estimate: '', steps: [] },
    };
  }
  return {
    ok: true,
    plan: {
      done: false,
      message: summary,
      summary,
      estimate: '',
      steps: plan.steps.map((s) => ({
        command: s.command,
        reason: s.description?.trim() || s.title?.trim() || '',
        readOnly: plan.affects.readOnly,
      })),
    },
  };
}

// Verify a candidate provider (key + URL + model) with a tiny call. Throws
// with a plain-language message on failure.
export async function verifyProvider(input: AddProviderInput): Promise<void> {
  const base = input.baseUrl.trim();
  if (input.format === 'anthropic') {
    await verifyAnthropic(input.key.trim(), input.model.trim(), base);
  } else {
    await verifyOpenAI(input.key.trim(), input.model.trim(), base);
  }
}
