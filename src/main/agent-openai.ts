import type { AgentFullPlan, AgentPlanInput, AgentStep } from '@shared/types';
import {
  PLAN_PARAMETERS,
  PLAN_TOOL_DESCRIPTION,
  PLAN_TOOL_NAME,
  STEP_PARAMETERS,
  STEP_TOOL_DESCRIPTION,
  STEP_TOOL_NAME,
  buildPlanSystem,
  buildSystem,
  buildUserContent,
  normalizePlan,
  normalizeStep,
} from './agent-shared';

// OpenAI-compatible caller for Agent Mode. Works for OpenAI itself and any
// provider that speaks the same chat-completions + function-calling format
// (OpenRouter, Groq, Together, local Ollama / LM Studio, etc.) by pointing
// baseUrl at their endpoint. The key never touches the Verlox backend.

function chatUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

async function errorText(res: Response): Promise<string> {
  let detail = '';
  try {
    detail = (await res.text()).slice(0, 300);
  } catch {
    // ignore
  }
  if (res.status === 401) return 'The provider rejected the key (check the key).';
  if (res.status === 404) return `Not found — check the endpoint URL and model. ${detail}`;
  if (res.status === 429) return 'The provider is rate-limiting; try again shortly.';
  return `Provider error ${res.status}. ${detail}`.trim();
}

export async function planStepOpenAI(
  input: AgentPlanInput,
  apiKey: string,
  model: string,
  baseUrl: string,
): Promise<AgentStep> {
  const userText = buildUserContent(input);
  const userContent = input.image
    ? [
        { type: 'text', text: userText },
        {
          type: 'image_url',
          image_url: {
            url: `data:${input.image.mediaType};base64,${input.image.base64Data}`,
          },
        },
      ]
    : userText;
  const res = await fetch(chatUrl(baseUrl), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: buildSystem(input) },
        { role: 'user', content: userContent },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: STEP_TOOL_NAME,
            description: STEP_TOOL_DESCRIPTION,
            parameters: STEP_PARAMETERS,
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: STEP_TOOL_NAME } },
    }),
  });
  if (!res.ok) throw new Error(await errorText(res));

  const data = (await res.json()) as {
    choices?: Array<{
      message?: { tool_calls?: Array<{ function?: { arguments?: string } }> };
    }>;
  };
  const args = data.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (!args) throw new Error('The provider did not return a structured step.');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(args) as Record<string, unknown>;
  } catch {
    throw new Error('The provider returned a step that could not be read.');
  }
  return normalizeStep(parsed);
}

// Plan-first variant: ask for the COMPLETE ordered plan in one call.
export async function planAllOpenAI(
  input: AgentPlanInput,
  apiKey: string,
  model: string,
  baseUrl: string,
): Promise<AgentFullPlan> {
  const userText = buildUserContent(input);
  const userContent = input.image
    ? [
        { type: 'text', text: userText },
        {
          type: 'image_url',
          image_url: {
            url: `data:${input.image.mediaType};base64,${input.image.base64Data}`,
          },
        },
      ]
    : userText;
  const res = await fetch(chatUrl(baseUrl), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: buildPlanSystem(input) },
        { role: 'user', content: userContent },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: PLAN_TOOL_NAME,
            description: PLAN_TOOL_DESCRIPTION,
            parameters: PLAN_PARAMETERS,
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: PLAN_TOOL_NAME } },
    }),
  });
  if (!res.ok) throw new Error(await errorText(res));

  const data = (await res.json()) as {
    choices?: Array<{
      message?: { tool_calls?: Array<{ function?: { arguments?: string } }> };
    }>;
  };
  const args = data.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (!args) throw new Error('The provider did not return a structured plan.');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(args) as Record<string, unknown>;
  } catch {
    throw new Error('The provider returned a plan that could not be read.');
  }
  return normalizePlan(parsed);
}

// Validate key + URL + model with a tiny generation.
export async function verifyOpenAI(
  apiKey: string,
  model: string,
  baseUrl: string,
): Promise<void> {
  const res = await fetch(chatUrl(baseUrl), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
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
