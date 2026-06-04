import type { AgentFullPlan, AgentPlanInput, AgentStep } from '@shared/types';

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
    '- The user wants you to DO things, not explain how. If the request is an',
    '  action (list, show, find, open, create, edit, move, rename, install,',
    '  run, delete, etc.), propose the ACTUAL command that performs it. NEVER',
    '  reply with advice like "you can use the X command" and done=true —',
    '  propose X as the command so the user can approve and run it. Returning',
    '  done=true without a command for an action request is wrong.',
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
    "the user's live tabs or their typed history. This direct-answer path is",
    'ONLY for pure questions about existing screen content — an action request',
    '(do/list/create/run/etc.) still gets a real command, never a done=true.',
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

// ---- Plan-first (lay out ALL steps upfront for one approval) --------------

export function buildPlanSystem(input: AgentPlanInput): string {
  return [
    'You are Verlox, a careful terminal agent helping a non-technical user.',
    `The user is on ${input.platform} using the ${input.shell} shell.`,
    `Commands run in this folder: ${input.cwd}`,
    '',
    'Lay out the COMPLETE ordered plan of shell commands needed to achieve',
    'the goal. The user reviews the whole plan once, approves it, and then the',
    'steps run in sequence. This is a forecast, so keep it realistic.',
    'Rules:',
    '- The user wants you to DO things, not explain how. Every step must be a',
    '  REAL shell command that performs work — never advice like "you can use',
    '  the X command".',
    '- NEVER tell the user to do something manually. Do NOT suggest Windows',
    '  File Explorer, Finder, a GUI, or "navigate to the folder and delete it".',
    '  You act ONLY through shell commands — output the command that does it.',
    '- This applies to destructive actions too (delete, overwrite, etc.):',
    '  produce the real command (e.g. Remove-Item -Recurse). Verlox shows every',
    '  step for approval and routes deletes to the Recycle Bin, so it is always',
    '  safe for you to propose the command rather than refuse or explain.',
    '- "this folder" / "here" refers to the working folder named above; build',
    '  the command against that path.',
    '- If a step CREATES or OVERWRITES a text file with content you know, set',
    '  `path` to that file and `preview` to the FULL proposed new file content.',
    '  This lets the user see a before/after diff. Omit both for folder-only,',
    '  binary, or dynamic steps where the resulting content is not known ahead.',
    '- List steps in the exact order they should run. Prefer the FEWEST steps',
    '  that achieve the goal; do not pad with redundant inspection commands.',
    '- For each step set readOnly=true ONLY when it merely inspects/reads and',
    '  changes nothing; anything that creates, edits, moves, deletes, installs,',
    '  or sends must be readOnly=false.',
    '- summary: one or two plain-English sentences describing what the plan',
    '  does overall.',
    '- estimate: a short forecast of the changes, e.g. "Creates 1 folder and',
    '  writes 1 file" or "Installs 2 packages". Empty if it only reads.',
    '- If the goal is already complete, or it is a pure question you can answer',
    '  from the terminal snapshot below, set done=true, put the answer in',
    '  summary, and return an empty steps list.',
    '',
    "Terminal awareness: the snapshot(s) below labeled \"terminal screen\" are",
    "the ACTUAL live content of the user's terminal tabs. To answer a question",
    'about what is on screen, read the snapshot and answer in summary with',
    'done=true and no steps — do NOT add a command to find out.',
    'Always answer by calling the propose_plan tool/function.',
  ].join('\n');
}

// JSON Schema for the structured "propose_plan" output.
export const PLAN_PARAMETERS = {
  type: 'object',
  properties: {
    done: {
      type: 'boolean',
      description:
        'True if the goal is already complete or it is a pure question — then steps is empty.',
    },
    summary: {
      type: 'string',
      description: 'One or two plain-English sentences describing the whole plan (or the answer when done).',
    },
    estimate: {
      type: 'string',
      description: 'Short forecast of changes, e.g. "Creates 1 folder, writes 1 file". Empty if read-only.',
    },
    steps: {
      type: 'array',
      description: 'The ordered list of commands to run. Empty when done=true.',
      items: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command for this step.' },
          reason: { type: 'string', description: 'One-line reason for this step.' },
          readOnly: {
            type: 'boolean',
            description: 'True only if this step reads/inspects and changes nothing.',
          },
          path: {
            type: 'string',
            description:
              'If this step creates/overwrites a text file with known content, the file path (else omit).',
          },
          preview: {
            type: 'string',
            description:
              'The full proposed new content of `path`, for a before/after diff (else omit).',
          },
        },
        required: ['command', 'reason', 'readOnly'],
      },
    },
  },
  required: ['done', 'summary', 'estimate', 'steps'],
} as const;

export const PLAN_TOOL_NAME = 'propose_plan';
export const PLAN_TOOL_DESCRIPTION =
  'Propose the complete ordered plan of shell commands to achieve the goal, or report that the goal is already complete.';

export function normalizePlan(raw: Record<string, unknown>): AgentFullPlan {
  const rawSteps = Array.isArray(raw.steps) ? raw.steps : [];
  const steps = rawSteps
    .map((s) => {
      const obj = (s ?? {}) as Record<string, unknown>;
      const command = typeof obj.command === 'string' ? obj.command.trim() : '';
      const path = typeof obj.path === 'string' && obj.path.trim() ? obj.path.trim() : undefined;
      const preview = typeof obj.preview === 'string' ? obj.preview : undefined;
      return {
        command,
        reason: typeof obj.reason === 'string' ? obj.reason : '',
        readOnly: obj.readOnly === true,
        ...(path ? { path } : {}),
        ...(path && preview !== undefined ? { preview } : {}),
      };
    })
    .filter((s) => s.command !== '');
  return {
    done: raw.done === true || steps.length === 0,
    message: typeof raw.summary === 'string' ? raw.summary : '',
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    estimate: typeof raw.estimate === 'string' ? raw.estimate : '',
    steps,
  };
}

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
