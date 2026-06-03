import type { AgentPlanInput, AgentStep } from '@shared/types';
import {
  STEP_PARAMETERS,
  STEP_TOOL_DESCRIPTION,
  STEP_TOOL_NAME,
  buildSystem,
  buildUserContent,
  normalizeStep,
} from './agent-shared';

// Anthropic-format caller for Agent Mode (Claude). The key never touches the
// Verlox backend. We force the propose_step tool so the answer is structured.

const VERSION = '2023-06-01';
const MAX_TOKENS = 1024;

function messagesUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/v1/messages`;
}

async function errorText(res: Response): Promise<string> {
  let detail = '';
  try {
    detail = (await res.text()).slice(0, 300);
  } catch {
    // ignore
  }
  if (res.status === 401) return 'Anthropic rejected the key (check the key).';
  if (res.status === 404) return `Not found — check the endpoint URL and model. ${detail}`;
  if (res.status === 429) return 'Anthropic is rate-limiting; try again shortly.';
  return `Anthropic error ${res.status}. ${detail}`.trim();
}

export async function planStepAnthropic(
  input: AgentPlanInput,
  apiKey: string,
  model: string,
  baseUrl: string,
): Promise<AgentStep> {
  const res = await fetch(messagesUrl(baseUrl), {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      system: buildSystem(input),
      messages: [
        {
          role: 'user',
          content: input.image
            ? [
                { type: 'text', text: buildUserContent(input) },
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: input.image.mediaType,
                    data: input.image.base64Data,
                  },
                },
              ]
            : buildUserContent(input),
        },
      ],
      tools: [
        {
          name: STEP_TOOL_NAME,
          description: STEP_TOOL_DESCRIPTION,
          input_schema: STEP_PARAMETERS,
        },
      ],
      tool_choice: { type: 'tool', name: STEP_TOOL_NAME },
    }),
  });
  if (!res.ok) throw new Error(await errorText(res));

  const data = (await res.json()) as {
    content?: Array<{ type: string; input?: Record<string, unknown> }>;
  };
  const toolUse = data.content?.find((b) => b.type === 'tool_use');
  if (!toolUse?.input) throw new Error('Anthropic did not return a structured step.');
  return normalizeStep(toolUse.input);
}

// Validate key + URL + model with a tiny generation.
export async function verifyAnthropic(
  apiKey: string,
  model: string,
  baseUrl: string,
): Promise<void> {
  const res = await fetch(messagesUrl(baseUrl), {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
  if (!res.ok) throw new Error(await errorText(res));
}
