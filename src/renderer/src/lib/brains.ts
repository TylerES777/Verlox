import type { AgentEngine, SettingsInfo } from '@shared/types';

// The model list, shared by every surface that offers a model picker.
// Lived in the AI-terminal panel until that surface was retired; the
// terminal's own AI bar needs the same list, so it lives on its own now.

// Which provider lab owns the model. Drives the small logo on each picker
// row (replaces the old text "group" headers).
export type ModelProvider = 'anthropic' | 'openai' | 'google' | 'xai' | 'meta' | 'deepseek' | 'qwen' | 'ollama' | 'custom';

export interface Brain {
  id: string;
  label: string;
  // Visual grouping in the picker: 'free' / 'pro' / 'offline' (local Ollama)
  // / 'custom' (BYOK).
  tier: 'free' | 'pro' | 'offline' | 'custom';
  // Which company makes the model — picks the logo on the right.
  provider: ModelProvider;
  engine: AgentEngine;
  model: string;
  providerId?: string;
}

// Exported so the Blocks bar's AI presence chip can offer the same model
// list without duplicating it.
export function buildBrains(s: SettingsInfo | null, ollamaModels: { name: string }[] = []): Brain[] {
  // Hosted models (credit-based). The `model` value is the backend
  // ModelChoice; tier matches the backend registry (tier.ts minTier).
  // Free at top, Pro below, BYOK ('custom') at the bottom.
  const list: Brain[] = [
    // --- Free ---
    { id: 'haiku', label: 'Haiku', tier: 'free', provider: 'anthropic', engine: 'verlox', model: 'haiku' },
    { id: 'gpt-mini', label: 'GPT-4o mini', tier: 'free', provider: 'openai', engine: 'verlox', model: 'gpt-mini' },
    { id: 'gpt', label: 'GPT-4o', tier: 'free', provider: 'openai', engine: 'verlox', model: 'gpt' },
    { id: 'gemini-flash', label: 'Gemini Flash', tier: 'free', provider: 'google', engine: 'verlox', model: 'gemini-flash' },
    { id: 'grok', label: 'Grok 4.3', tier: 'free', provider: 'xai', engine: 'verlox', model: 'grok' },
    { id: 'llama', label: 'Llama 3.3 70B', tier: 'free', provider: 'meta', engine: 'verlox', model: 'llama' },
    { id: 'deepseek', label: 'DeepSeek V3', tier: 'free', provider: 'deepseek', engine: 'verlox', model: 'deepseek' },
    { id: 'qwen', label: 'Qwen 2.5 72B', tier: 'free', provider: 'qwen', engine: 'verlox', model: 'qwen' },
    // --- Pro ---
    { id: 'sonnet', label: 'Sonnet', tier: 'pro', provider: 'anthropic', engine: 'verlox', model: 'sonnet' },
    { id: 'opus', label: 'Opus', tier: 'pro', provider: 'anthropic', engine: 'verlox', model: 'opus' },
    { id: 'gpt-reasoning', label: 'o3 (reasoning)', tier: 'pro', provider: 'openai', engine: 'verlox', model: 'gpt-reasoning' },
    { id: 'gemini', label: 'Gemini 2.5 Pro', tier: 'pro', provider: 'google', engine: 'verlox', model: 'gemini' },
  ];
  // --- Offline (bundled): the always-present built-in Llama 3.2 3B. Picked,
  //     downloaded (~2 GB) on first use, then served by a local llama-server
  //     process. Zero credits, zero network at runtime. ---
  list.push({
    id: 'local:llama-3.2-3b',
    label: 'Llama 3.2 3B (built-in)',
    tier: 'offline',
    provider: 'ollama',
    engine: 'local',
    model: 'llama-3.2-3b',
  });
  // --- Offline (local Ollama) — populated only when the daemon is detected
  //     and has at least one pulled model. The 'model' is the Ollama tag the
  //     OpenAI-compatible /v1/chat/completions endpoint expects verbatim. ---
  for (const m of ollamaModels) {
    list.push({
      id: `ollama:${m.name}`,
      label: m.name,
      tier: 'offline',
      provider: 'ollama',
      engine: 'ollama',
      model: m.name,
    });
  }
  for (const p of s?.providers ?? []) {
    list.push({
      id: `custom:${p.id}`,
      label: p.name,
      tier: 'custom',
      provider: 'custom',
      engine: 'custom',
      model: p.model,
      providerId: p.id,
    });
  }
  return list;
}
