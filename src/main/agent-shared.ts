import type { AgentPlanInput, AgentStep } from '@shared/types';

// Provider-neutral pieces of a direct (own-key) agent call: the prompt text,
// the structured-output schema, and the normalizer that turns the model's
// raw fields into an AgentStep. Shared by the OpenAI and Anthropic callers so
// they behave identically.

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(-max) : s;
}

export function buildSystem(input: AgentPlanInput): string {
  return [
    'You are Verlox, a careful terminal agent helping a non-technical user.',
    `The user is on ${input.platform} using the ${input.shell} shell.`,
    `Commands run in this folder: ${input.cwd}`,
    '',
    'Work toward the goal ONE step at a time. Each turn, propose the single',
    'next shell command, or finish.',
    'Rules:',
    '- Propose exactly one command at a time.',
    '- Mark readOnly=true only when the command merely inspects/reads and',
    '  changes nothing (listing, printing, status). Anything that creates,',
    '  edits, moves, deletes, installs, or sends must be readOnly=false.',
    '- Set risk to a short warning when a command is destructive or hard to',
    '  undo; otherwise leave risk empty.',
    '- When the goal is already achieved, set done=true and leave command',
    '  empty, with a short closing message.',
    '- Keep message and reason short and plain-English.',
    '',
    'Handling errors: if a step fails, DO NOT give up. Read the error',
    'message, work out the likely root cause, and propose a concrete next',
    'step that fixes it or gathers more information (e.g. inspect a file,',
    'check a path, install a missing tool). Explain the cause in your message.',
    'Only finish with done=true if you genuinely cannot proceed.',
    '',
    "Terminal awareness: the snapshot(s) below labeled \"terminal screen\" are",
    "the ACTUAL live content of the user's terminal tabs, including other",
    'tabs. To answer a question about what is on screen, in another tab, or',
    'what the user typed, READ THE SNAPSHOT AND ANSWER DIRECTLY: set',
    'done=true with the answer and no command. Do NOT propose a command to',
    'find out, because your commands run in a separate shell that cannot see',
    "the user's live tabs or their typed history.",
    'Always answer by calling the propose_step tool/function.',
  ].join('\n');
}

export function buildUserContent(input: AgentPlanInput): string {
  const lines: string[] = [];
  if (input.terminalContext) {
    lines.push(
      "What's currently on the user's terminal screen(s):",
      input.terminalContext,
      '',
    );
  }
  lines.push(`Goal: ${input.goal}`, '');
  if (input.priorSteps.length === 0) {
    lines.push('No steps have run yet. Propose the first step.');
  } else {
    lines.push('Steps run so far (most recent last):');
    for (const s of input.priorSteps) {
      lines.push(
        `- Command: ${s.command}`,
        `  Exit code: ${s.exitCode}`,
        `  Output: ${clip(s.output.trim() || '(no output)', 1500)}`,
      );
    }
    lines.push('', 'Propose the next step, or finish if the goal is complete.');
  }
  return lines.join('\n');
}

// JSON Schema for the structured "propose_step" output. Used as both an
// Anthropic tool input_schema and an OpenAI function parameters object.
export const STEP_PARAMETERS = {
  type: 'object',
  properties: {
    done: {
      type: 'boolean',
      description: 'True if the goal is complete and nothing more should run.',
    },
    message: {
      type: 'string',
      description: 'Short plain-English note to show the user.',
    },
    command: {
      type: 'string',
      description: 'The single shell command to run next. Empty when done.',
    },
    reason: {
      type: 'string',
      description: 'One-line reason for the command. Empty when done.',
    },
    readOnly: {
      type: 'boolean',
      description: 'True only if the command reads/inspects and changes nothing.',
    },
    risk: {
      type: 'string',
      description:
        'Short warning if the command is destructive or hard to undo; empty otherwise.',
    },
  },
  required: ['done', 'message', 'command', 'reason', 'readOnly', 'risk'],
} as const;

export const STEP_TOOL_NAME = 'propose_step';
export const STEP_TOOL_DESCRIPTION =
  'Propose the next single shell command toward the goal, or report that the goal is complete.';

export function normalizeStep(raw: Record<string, unknown>): AgentStep {
  const command = typeof raw.command === 'string' ? raw.command.trim() : '';
  const risk = typeof raw.risk === 'string' ? raw.risk.trim() : '';
  return {
    done: raw.done === true || command === '',
    message: typeof raw.message === 'string' ? raw.message : '',
    command: command === '' ? null : command,
    reason: typeof raw.reason === 'string' ? raw.reason : '',
    readOnly: raw.readOnly === true,
    risk: risk === '' ? null : risk,
  };
}
