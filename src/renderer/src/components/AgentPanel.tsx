import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import type {
  AgentEngine,
  AgentStepHistory,
  AttachedImage,
  EnvironmentInfo,
  LocalModelStatus,
  SettingsInfo,
} from '@shared/types';
import {
  assessCommand,
  highestRisk,
  permissionFor,
  riskLabel,
  type RiskLevel,
} from '@shared/risk';
import { CopyButton } from './CopyButton';
import { lineDiff, type DiffLine } from '../lib/lineDiff';
import { snapshotTerminals } from '../lib/terminalRegistry';
import { formatResets } from '../lib/credits';
import { registerProcess } from '../hooks/useRunningProcesses';
import { createPortal } from 'react-dom';
import { PathPicker, type PathSelection } from './PathPicker';
import { useTier } from '../contexts/TierContext';
import { useUpgrade } from '../contexts/UpgradeContext';
import { useUsage } from '../contexts/UsageContext';

interface AgentPanelProps {
  // The owning terminal tab's id, so the panel can flag which screen is in
  // front when it reads terminal content.
  terminalId: string;
}

// Total cap on the terminal context we send each step (keeps token cost sane).
const TERMINAL_CONTEXT_CAP = 8000;

// Image attach limits (mirror the conversation input).
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

interface AttachmentState extends AttachedImage {
  dataUrl: string;
  name: string;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error('bad read'));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

// The floating panel where you and Verlox talk in plain English — Agent Mode.
//
// You give a goal; Verlox proposes ONE next step at a time. Read-only steps
// can run on their own (a setting); anything that changes files waits for your
// approval. After each step runs, its result is fed back so the AI can decide
// the next step, until it says done, you press Stop, or a safety limit hits.
// Every changing step saves a restore point first, and runs on the "side
// bench" (a controlled one-shot spawn that cleanly captures output).
//
// The brain is chosen in the model switcher: a Verlox model, or any AI
// provider you've added (OpenAI, OpenRouter, Groq, a local model, Anthropic,
// etc.), which is called directly from your machine. Providers are added in
// the gear settings and verified the moment you add them.

const MAX_STEPS = 12;
// Keep going after an error so the agent can diagnose and fix, but stop if it
// hits this many failures in a row (avoids spinning on the same problem).
const MAX_CONSECUTIVE_FAILURES = 3;
const OUTPUT_CAP = 20000;

type ProposalStatus = 'pending' | 'denied' | 'running' | 'done' | 'failed';

// One step inside a plan-first plan, with its live execution state.
type PlanStepUI = {
  command: string;
  reason: string;
  readOnly: boolean;
  // True when this step's capability is set to "never" — it is refused and
  // skipped at run time rather than executed.
  blocked: boolean;
  status: 'idle' | 'running' | 'done' | 'failed' | 'skipped';
  output: string;
  exitCode: number | null;
  // For file-writing steps: the target path + proposed content, used to show a
  // before/after diff in simulate mode.
  path?: string;
  preview?: string;
};

type PlanMessage = {
  kind: 'plan';
  id: string;
  summary: string;
  estimate: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'denied';
  steps: PlanStepUI[];
  // Sandbox mode: the plan was generated to PREVIEW its predicted effect and
  // nothing runs until the user clicks "Run for real".
  simulated: boolean;
};

type AgentMessage =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  // A billing limit was hit: show an upgrade card instead of plain text.
  // 'credits' = out of credits this period; 'proTrial' = the daily free
  // allowance of Pro-model messages is used up (model reverted to default).
  | { kind: 'limit'; id: string; reason: 'credits' | 'proTrial' }
  | PlanMessage
  | {
      kind: 'proposal';
      id: string;
      command: string;
      reason: string;
      readOnly: boolean;
      warn: string | null;
      status: ProposalStatus;
      output: string;
      exitCode: number | null;
      note: string | null;
    };

// Which provider lab owns the model. Drives the small logo on each picker
// row (replaces the old text "group" headers).
type ModelProvider = 'anthropic' | 'openai' | 'google' | 'xai' | 'meta' | 'deepseek' | 'qwen' | 'ollama' | 'custom';

interface Brain {
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

function buildBrains(s: SettingsInfo | null, ollamaModels: { name: string }[] = []): Brain[] {
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

// The hosted model choices that are Pro-only. Keep in sync with the backend
// registry (tier.ts, minTier === 'pro') and the brain list above.
const PRO_MODELS = new Set(['sonnet', 'opus', 'gpt-reasoning', 'gemini']);
// Per-model credit cost surfaced in the picker's hover hint. Mirrors the
// backend env defaults (config/env.ts); the backend is the source of truth
// for billing, this is for display only. Update both together.
const MODEL_CREDIT_COST: Record<string, number> = {
  haiku: 1,
  sonnet: 4,
  opus: 6,
  'gpt-mini': 1,
  gpt: 4,
  'gpt-reasoning': 8,
  'gemini-flash': 1,
  gemini: 4,
  grok: 4,
  llama: 1,
  deepseek: 1,
  qwen: 1,
};
// The free default model selection reverts to when the Pro trial is spent.
const DEFAULT_FREE_BRAIN = 'haiku';
function isProBrain(b: Brain): boolean {
  return b.engine === 'verlox' && PRO_MODELS.has(b.model);
}

// Real PNG logos for the providers the user supplied; clean inline SVG
// fallback for the two they didn't (OpenAI, Google). Vite bundles the PNGs
// from assets/providers/ and inlines them as data URLs at build time.
import iconAnthropic from '../assets/providers/anthropic.png';
import iconOpenAI from '../assets/providers/openai.png';
import iconGoogle from '../assets/providers/google.png';
import iconMeta from '../assets/providers/meta.png';
import iconGrok from '../assets/providers/grok.png';
import iconDeepSeek from '../assets/providers/deepseek.png';
import iconQwen from '../assets/providers/qwen.png';

const PROVIDER_PNGS: Partial<Record<ModelProvider, string>> = {
  anthropic: iconAnthropic,
  openai: iconOpenAI,
  google: iconGoogle,
  meta: iconMeta,
  xai: iconGrok,
  deepseek: iconDeepSeek,
  qwen: iconQwen,
};

function ProviderIcon({ p }: { p: ModelProvider }) {
  const png = PROVIDER_PNGS[p];
  if (png) {
    // Object-contain so a non-square logo doesn't get distorted by the 14px
    // box. opacity-80 keeps the colored brands from shouting over the row.
    return <img src={png} alt="" aria-hidden="true" className="h-3.5 w-3.5 flex-none object-contain opacity-80" />;
  }
  // Inline SVG for the two non-lab providers — every brand above is a real PNG.
  const c = 'h-3 w-3 flex-none text-[#9A9DA5]';
  if (p === 'custom') {
    // Plug icon (BYOK).
    return (
      <svg viewBox="0 0 24 24" className={c} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0V8ZM12 16v5" />
      </svg>
    );
  }
  if (p === 'ollama') {
    // Small home/box mark for local-on-device. Calm and abstract; swap for
    // the official Ollama logo once we ship a PNG.
    return (
      <svg viewBox="0 0 24 24" className={c} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 11 12 4l8 7v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-8Z" />
        <path d="M10 20v-5h4v5" />
      </svg>
    );
  }
  return null;
}

function newId(): string {
  return crypto.randomUUID();
}

function shortFolder(p: string): string {
  if (!p) return '';
  const segs = p.split(/[\\/]/).filter(Boolean);
  if (segs.length <= 2) return p;
  return `…${segs.slice(-2).join('\\')}`;
}

// Gather what's on the terminal screen(s) into a compact, labeled block.
function collectTerminalContext(currentId: string): string {
  const snaps = snapshotTerminals(currentId).filter((s) => s.text);
  if (snaps.length === 0) return '';
  const blocks = snaps.map((s, i) => {
    const label = s.current ? `Terminal ${i + 1} (the one in front)` : `Terminal ${i + 1}`;
    return `[${label}]\n${s.text.slice(-4000)}`;
  });
  return blocks.join('\n\n').slice(-TERMINAL_CONTEXT_CAP);
}

// Per-level colors for the risk badge — calm, muted variants of the app's
// green / amber / red so the score reads at a glance without shouting.
const RISK_UI: Record<RiskLevel, { dot: string; text: string; bg: string }> = {
  low: { dot: 'bg-[#3E7A53]', text: 'text-[#3E7A53]', bg: 'bg-[#EAF3EC]' },
  medium: { dot: 'bg-[#B07A1E]', text: 'text-[#9A7D2E]', bg: 'bg-[#FBF4E6]' },
  high: { dot: 'bg-[#B4322B]', text: 'text-[#B4322B]', bg: 'bg-[#FBEAE8]' },
};

function RiskBadge({ level }: { level: RiskLevel }) {
  const ui = RISK_UI[level];
  return (
    <span
      className={`flex shrink-0 items-center gap-1 rounded-full ${ui.bg} px-2 py-0.5 text-[10.5px] font-semibold ${ui.text}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${ui.dot}`} />
      {riskLabel(level)}
    </span>
  );
}

// The step's index badge in a plan, doubling as a status indicator: a number
// while pending/running, a check when done, a "!" when it failed.
function StepNumber({ index, status }: { index: number; status: PlanStepUI['status'] }) {
  if (status === 'done')
    return (
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[#3E7A53] text-[9px] font-bold text-white">
        ✓
      </span>
    );
  if (status === 'failed')
    return (
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[#B4322B] text-[9px] font-bold text-white">
        !
      </span>
    );
  const tone =
    status === 'running'
      ? 'bg-[#3A3A3A] text-white'
      : status === 'skipped'
        ? 'bg-black/10 text-[#9A9A9A]'
        : 'bg-black/15 text-[#6A6A6A]';
  return (
    <span
      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold ${tone}`}
    >
      {index + 1}
    </span>
  );
}

// One row in a plan. Shows the capability + EITHER its risk badge OR a
// "Blocked" tag (never both — a refused step's risk is moot), the command, an
// optional reason, and live run status. Blocked steps get a faint red tint so
// they read as "won't run" without piling on badges.
function PlanStepRow({
  index,
  step,
  simulated,
  cwd,
}: {
  index: number;
  step: PlanStepUI;
  simulated: boolean;
  cwd: string;
}) {
  const risk = assessCommand(step.command);
  const [diff, setDiff] = useState<DiffLine[] | null>(null);
  const [newFile, setNewFile] = useState(false);

  // In simulate mode, fetch the target file's current content and diff it
  // against the proposed content, so the user sees exactly what would change.
  useEffect(() => {
    let cancelled = false;
    if (!simulated || step.blocked || !step.path || step.preview === undefined) {
      setDiff(null);
      return;
    }
    void window.api
      .previewFile(step.path, cwd)
      .then((res) => {
        if (cancelled) return;
        setNewFile(!res.exists);
        setDiff(lineDiff(res.content, step.preview ?? ''));
      })
      .catch(() => {
        if (!cancelled) setDiff(null);
      });
    return () => {
      cancelled = true;
    };
  }, [simulated, step.blocked, step.path, step.preview, cwd]);

  return (
    <li
      className={`border-t border-black/[0.06] p-2 first:border-t-0 ${
        step.blocked ? 'bg-[#FDF6F5]' : ''
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <StepNumber index={index} status={step.status} />
          <span className="truncate text-[11px] font-medium text-[#6A6A6A]">
            {risk.label}
          </span>
        </div>
        {step.blocked ? (
          <span className="shrink-0 rounded-full bg-[#FBEAE8] px-2 py-0.5 text-[10.5px] font-semibold text-[#B4322B]">
            Blocked
          </span>
        ) : (
          <RiskBadge level={risk.level} />
        )}
      </div>
      <code className="mt-1.5 block break-all rounded bg-black/[0.04] px-2 py-1 font-mono text-[11px] text-[#3A3A3A]">
        {step.command}
      </code>
      {step.reason && (
        <div className="mt-1 text-[11px] text-[#9A9A9A]">{step.reason}</div>
      )}
      {step.blocked && (
        <div className="mt-1 text-[11px] text-[#B4322B]">
          Refused — “{risk.label}” is set to Never. Allow it in Settings to run this.
        </div>
      )}

      {/* AI diff (simulate mode): current vs proposed file content. */}
      {diff && (
        <div className="mt-1.5 overflow-hidden rounded-md border border-hairline">
          <div className="flex items-center justify-between border-b border-hairline bg-surface-subtle px-2 py-0.5">
            <span className="truncate font-mono text-[10px] text-ink-label" title={step.path}>
              {step.path}
            </span>
            <span className="shrink-0 text-[9.5px] uppercase tracking-wide text-ink-micro">
              {newFile ? 'new file' : 'diff'}
            </span>
          </div>
          <pre className="max-h-44 overflow-auto bg-white font-mono text-[10.5px] leading-relaxed">
            {diff.map((d, k) => (
              <div
                key={k}
                className={
                  d.type === 'add'
                    ? 'bg-[#EAF3EC] text-[#2E6B45]'
                    : d.type === 'del'
                      ? 'bg-[#FBEAE8] text-[#9c2b25]'
                      : 'text-[#6A6A6A]'
                }
              >
                <span className="select-none px-1 text-ink-micro">
                  {d.type === 'add' ? '+' : d.type === 'del' ? '-' : ' '}
                </span>
                {d.text || ' '}
              </div>
            ))}
          </pre>
        </div>
      )}

      {step.status === 'running' && (
        <div className="mt-1 text-[11px] text-[#9A9A9A]">Running…</div>
      )}
      {(step.status === 'done' || step.status === 'failed') &&
        step.output.trim() !== '' && (
          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded border border-hairline bg-surface-subtle px-2 py-1 font-mono text-[10.5px] leading-relaxed text-[#3A3A3A]">
            {step.output}
          </pre>
        )}
      {step.status === 'failed' && (
        <div className="mt-1 text-[11px] text-[#B4632F]">Failed (exit {step.exitCode}).</div>
      )}
      {step.status === 'skipped' && !step.blocked && (
        <div className="mt-1 text-[11px] text-[#9A9A9A]">Skipped.</div>
      )}
    </li>
  );
}

export function AgentPanel({ terminalId }: AgentPanelProps) {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [thinking, setThinking] = useState(false);
  // Hover/focus drive the bar open; otherwise it sits closed (compact).
  const [hovered, setHovered] = useState(false);
  const [workDir, setWorkDir] = useState('');

  // The agent panel only READS settings now (provider list for the brain
  // switcher, auto-approve, permission enforcement). Editing them lives in the
  // Settings page; this copy refreshes via the 'verlox:settings-changed' event.
  const [settings, setSettings] = useState<SettingsInfo | null>(null);
  // Billing tier gates the power features (Sandbox, long vault retention).
  const { isPro } = useTier();
  const { openUpgrade } = useUpgrade();
  const { usage, refresh: refreshUsage } = useUsage();

  // Pro models (locked for free users beyond the daily trial). The free
  // default model that selection reverts to once the trial is used up.
  const proTrialCap = usage?.caps?.proTrial;
  const proTrialLeft =
    !isPro && proTrialCap && proTrialCap.limit !== null
      ? Math.max(0, proTrialCap.limit - proTrialCap.used)
      : null;
  // Locked = a free user who has spent the whole daily Pro trial.
  const proLocked = !isPro && proTrialLeft === 0;

  // Model switcher.
  const [brainId, setBrainId] = useState<string>('sonnet');
  // Whether the user has manually chosen a model this session. Until they do,
  // the default tracks their tier (Pro → Sonnet, Free → the free default) so
  // free users start on a free model and only spend the Pro trial on purpose.
  const userPickedBrainRef = useRef(false);
  useEffect(() => {
    if (!userPickedBrainRef.current) {
      setBrainId(isPro ? 'sonnet' : DEFAULT_FREE_BRAIN);
    }
  }, [isPro]);
  // Once a free user's daily Pro trial is spent, revert any selected Pro
  // model to the free default so the next send doesn't hit the limit. (Pro
  // users are never locked, so their selection is untouched.)
  useEffect(() => {
    if (proLocked && PRO_MODELS.has(brainId)) setBrainId(DEFAULT_FREE_BRAIN);
  }, [proLocked, brainId]);
  const [brainMenuOpen, setBrainMenuOpen] = useState(false);
  const brainWrapRef = useRef<HTMLDivElement>(null);
  const brainBtnRef = useRef<HTMLButtonElement>(null);
  const brainMenuRef = useRef<HTMLDivElement>(null);
  // Fixed-position coords for the portaled model menu (so the panel's
  // overflow-hidden can't clip it). Anchored bottom-left, growing upward.
  const [brainCoords, setBrainCoords] = useState<{ left: number; bottom: number } | null>(null);
  // Built-in folder/file picker (the chat bar's folder button), portaled so
  // the panel's overflow-hidden can't clip it.
  const folderBtnRef = useRef<HTMLButtonElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerAnchor, setPickerAnchor] = useState<{ left: number; top: number } | null>(null);

  // Image attachment + folder lock.
  const [attachment, setAttachment] = useState<AttachmentState | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [folderLocked, setFolderLocked] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // A folder the user explicitly chose (overrides the guarded folder).
  const pickedFolderRef = useRef<string | null>(null);
  // Image captured at submit, sent only with the first step of a goal.
  const imageRef = useRef<AttachedImage | null>(null);

  const envRef = useRef<EnvironmentInfo | null>(null);
  const workDirRef = useRef<string>('');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const msgListRef = useRef<HTMLDivElement | null>(null);
  const prevMsgLenRef = useRef(0);

  const goalRef = useRef<string>('');
  const priorStepsRef = useRef<AgentStepHistory[]>([]);
  const autoApproveRef = useRef(true);
  const stopRef = useRef(false);
  const runningRef = useRef(false);
  const stepCountRef = useRef(0);
  const consecutiveFailuresRef = useRef(0);
  const lastCommandRef = useRef<string | null>(null);
  const currentRunIdRef = useRef<string | null>(null);
  const engineRef = useRef<AgentEngine>('verlox');
  const modelRef = useRef<string>('sonnet');
  const providerIdRef = useRef<string | undefined>(undefined);

  // Probe the local Ollama runtime once when the picker first matters, and
  // again whenever the picker opens so freshly-pulled models show up without
  // an app restart. `available:false` keeps the Install Ollama prompt visible.
  const [ollama, setOllama] = useState<{ available: boolean; models: { name: string }[] }>(
    { available: false, models: [] },
  );
  const probeOllamaNow = useCallback(() => {
    window.api
      .listOllama()
      .then((r) => setOllama({ available: r.available, models: r.models }))
      .catch(() => setOllama({ available: false, models: [] }));
  }, []);
  useEffect(() => {
    probeOllamaNow();
  }, [probeOllamaNow]);

  // Bundled local model status (download / boot / ready). Subscribed once so
  // the picker label, the modal, and the pickBrain handler all share one
  // source of truth. Snapshotted via getLocalModelStatus() on mount so the
  // installed=true case shows correctly even before the first broadcast.
  const [localStatus, setLocalStatus] = useState<LocalModelStatus | null>(null);
  useEffect(() => {
    void window.api.getLocalModelStatus().then(setLocalStatus).catch(() => {});
    const unsub = window.api.onLocalModelStatus((s) => setLocalStatus(s));
    return () => unsub();
  }, []);

  const brains = buildBrains(settings, ollama.models);
  const selectedBrain = brains.find((b) => b.id === brainId) ?? brains[1];

  useEffect(() => {
    void (async () => {
      try {
        const env = await window.api.getEnvironment();
        envRef.current = env;
        const status = await window.api.snapshotStatus();
        const dir = status.guardedFolder ?? env.homeDir;
        workDirRef.current = dir;
        setWorkDir(dir);
      } catch {
        // Best-effort.
      }
      try {
        const s = await window.api.settingsGet();
        setSettings(s);
        autoApproveRef.current = s.autoApproveReadonly;
        if (s.providers.length > 0) setBrainId(`custom:${s.providers[0].id}`);
      } catch {
        // Leave defaults.
      }
    })();
  }, []);

  // Re-read settings whenever the Settings page changes them, so the brain
  // switcher, auto-approve, and permission enforcement stay current.
  useEffect(() => {
    const refresh = async () => {
      try {
        const s = await window.api.settingsGet();
        setSettings(s);
        autoApproveRef.current = s.autoApproveReadonly;
      } catch {
        // Keep current.
      }
    };
    window.addEventListener('verlox:settings-changed', refresh);
    return () => window.removeEventListener('verlox:settings-changed', refresh);
  }, []);

  // Follow the raw terminal's directory: when the user `cd`s in the shell,
  // TerminalView emits the new cwd and the agent's working folder tracks it,
  // so both stay pointed at the same place.
  useEffect(() => {
    const onCwd = (e: Event) => {
      const detail = (e as CustomEvent<{ id: string; cwd: string }>).detail;
      if (!detail || detail.id !== terminalId || !detail.cwd) return;
      pickedFolderRef.current = detail.cwd;
      workDirRef.current = detail.cwd;
      setWorkDir(detail.cwd);
    };
    window.addEventListener('verlox:cwd-changed', onCwd);
    return () => window.removeEventListener('verlox:cwd-changed', onCwd);
  }, [terminalId]);

  useEffect(() => {
    if (!brainMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      // The menu is portaled out of brainWrapRef, so check it separately.
      if (brainWrapRef.current?.contains(t)) return;
      if (brainMenuRef.current?.contains(t)) return;
      setBrainMenuOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setBrainMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [brainMenuOpen]);

  // Close the folder picker on an outside click or Escape.
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (folderBtnRef.current?.contains(t)) return;
      if (pickerRef.current?.contains(t)) return;
      setPickerOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setPickerOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [pickerOpen]);

  // Keep the thread readable without yanking the user's scroll position:
  //  - a NEW message scrolls to show ITS TOP (so you read a long reply from the
  //    start, not dumped at the bottom),
  //  - in-place updates / the thinking indicator only stick to the bottom if
  //    you were already near it (if you scrolled up to read, you stay put).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const grew = messages.length > prevMsgLenRef.current;
    prevMsgLenRef.current = messages.length;
    const list = msgListRef.current;
    if (grew && list) {
      const last = list.children[messages.length - 1] as HTMLElement | undefined;
      if (last) {
        const top =
          last.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
        el.scrollTop = Math.max(0, top - 8);
        return;
      }
    }
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [messages, thinking]);

  const addUser = (text: string) =>
    setMessages((p) => [...p, { kind: 'user', id: newId(), text }]);
  const addAssistant = (text: string) =>
    setMessages((p) => [...p, { kind: 'assistant', id: newId(), text }]);
  const update = (id: string, patch: Partial<AgentMessage>) =>
    setMessages((p) =>
      p.map((m) => (m.id === id ? ({ ...m, ...patch } as AgentMessage) : m)),
    );

  const endLoop = () => {
    runningRef.current = false;
    stopRef.current = false;
    currentRunIdRef.current = null;
    setRunning(false);
    setThinking(false);
  };

  const planNextRef = useRef<() => Promise<void>>(async () => {});
  const runProposalRef = useRef<(id: string, command: string) => Promise<void>>(
    async () => {},
  );
  // Plan-first: generate the whole plan upfront, then run its steps in order.
  const startPlanRef = useRef<() => Promise<void>>(async () => {});
  const runPlanRef = useRef<
    (planId: string, steps: { command: string; blocked: boolean }[]) => Promise<void>
  >(async () => {});

  const updatePlanStep = (planId: string, idx: number, patch: Partial<PlanStepUI>) =>
    setMessages((p) =>
      p.map((m) =>
        m.id === planId && m.kind === 'plan'
          ? { ...m, steps: m.steps.map((s, i) => (i === idx ? { ...s, ...patch } : s)) }
          : m,
      ),
    );
  const markRemainingSkipped = (planId: string, from: number) =>
    setMessages((p) =>
      p.map((m) =>
        m.id === planId && m.kind === 'plan'
          ? {
              ...m,
              steps: m.steps.map((s, i) =>
                i >= from && s.status === 'idle' ? { ...s, status: 'skipped' } : s,
              ),
            }
          : m,
      ),
    );

  // One-shot command on the side bench (same path the single-step flow uses),
  // resolving with the exit code. Output is streamed back via onOutput.
  const runOneCommand = (
    command: string,
    cwd: string,
    shell: EnvironmentInfo['shell'],
    onOutput: (out: string) => void,
  ): Promise<number | null> =>
    new Promise((resolve) => {
      const runId = `agent-${newId()}`;
      currentRunIdRef.current = runId;
      let output = '';
      const offOutput = window.api.onCommandOutput(({ id, data }) => {
        if (id !== runId) return;
        output += data;
        if (output.length > OUTPUT_CAP) output = output.slice(-OUTPUT_CAP);
        onOutput(output);
      });
      const offExit = window.api.onCommandExit(({ id, code }) => {
        if (id !== runId) return;
        offOutput();
        offExit();
        currentRunIdRef.current = null;
        resolve(code);
      });
      window.api.startCommand({ id: runId, command, cwd, shell });
      registerProcess({ stepId: runId, conversationId: terminalId, command, cwd, shell });
    });

  const approvePlan = (plan: PlanMessage) => {
    update(plan.id, { status: 'running' } as Partial<AgentMessage>);
    runningRef.current = true;
    setRunning(true);
    void runPlanRef.current(
      plan.id,
      plan.steps.map((s) => ({ command: s.command, blocked: s.blocked })),
    );
  };
  const denyPlan = (planId: string) => {
    update(planId, { status: 'denied' } as Partial<AgentMessage>);
    addAssistant('Okay, I discarded that plan. What would you like instead?');
    endLoop();
  };
  // Promote a simulation to a real run: drop the preview flag and execute.
  const runForReal = (plan: PlanMessage) => {
    update(plan.id, { simulated: false } as Partial<AgentMessage>);
    approvePlan(plan);
  };

  planNextRef.current = async () => {
    const env = envRef.current;
    if (!env) {
      addAssistant('I could not detect your shell yet. Try reopening the app.');
      endLoop();
      return;
    }

    setThinking(true);
    let result;
    try {
      result = await window.api.agentPlanStep({
        goal: goalRef.current,
        priorSteps: priorStepsRef.current.slice(-10),
        cwd: workDirRef.current || env.homeDir,
        platform: env.platform,
        shell: env.shell,
        engine: engineRef.current,
        model: modelRef.current,
        providerId: providerIdRef.current,
        // The image goes only with the first step of a goal.
        image: priorStepsRef.current.length === 0 ? imageRef.current : null,
        // Always-on: a fresh snapshot of the terminal screen(s) each step.
        terminalContext: collectTerminalContext(terminalId),
      });
    } catch {
      addAssistant('Something went wrong reaching the AI. Please try again.');
      endLoop();
      return;
    }
    setThinking(false);

    if (stopRef.current) {
      endLoop();
      return;
    }
    if (!result.ok) {
      addAssistant(result.error);
      endLoop();
      return;
    }

    const step = result.step;
    if (step.done || !step.command) {
      addAssistant(step.message || 'All done.');
      endLoop();
      return;
    }

    const command = step.command;
    if (command === lastCommandRef.current) {
      addAssistant(
        'The next step would repeat the last command, so I stopped. Tell me how you’d like to continue.',
      );
      endLoop();
      return;
    }

    const autoRun = autoApproveRef.current && step.readOnly && !step.risk;
    const propId = newId();
    if (step.message) addAssistant(step.message);
    setMessages((p) => [
      ...p,
      {
        kind: 'proposal',
        id: propId,
        command,
        reason: step.reason,
        readOnly: step.readOnly,
        warn: step.risk,
        status: autoRun ? 'running' : 'pending',
        output: '',
        exitCode: null,
        note: null,
      },
    ]);

    if (autoRun) await runProposalRef.current(propId, command);
  };

  runProposalRef.current = async (id: string, command: string) => {
    const env = envRef.current;
    const cwd = workDirRef.current;
    if (!env) {
      update(id, { status: 'failed', note: 'Could not detect your shell.' });
      endLoop();
      return;
    }

    let note = 'Saved a restore point, then ran it.';
    try {
      const cp = await window.api.snapshotCheckpoint(`Before: ${command}`);
      if (!cp.ok) {
        note = 'Ran it. No restore point: protect a folder (the shield) to enable undo.';
      }
    } catch {
      note = 'Ran it. Could not save a restore point.';
    }
    update(id, { status: 'running', output: '', note });

    const runId = `agent-${newId()}`;
    currentRunIdRef.current = runId;
    let output = '';
    const offOutput = window.api.onCommandOutput(({ id: rid, data }) => {
      if (rid !== runId) return;
      output += data;
      if (output.length > OUTPUT_CAP) output = output.slice(-OUTPUT_CAP);
      update(id, { output });
    });
    const offExit = window.api.onCommandExit(({ id: rid, code }) => {
      if (rid !== runId) return;
      offOutput();
      offExit();
      currentRunIdRef.current = null;

      const failed = code !== 0 && code !== null;
      update(id, { status: failed ? 'failed' : 'done', exitCode: code });

      priorStepsRef.current.push({ command, exitCode: code, output });
      lastCommandRef.current = command;
      stepCountRef.current += 1;

      if (stopRef.current) {
        endLoop();
        return;
      }
      if (failed) {
        consecutiveFailuresRef.current += 1;
        if (consecutiveFailuresRef.current >= MAX_CONSECUTIVE_FAILURES) {
          addAssistant(
            `That failed ${MAX_CONSECUTIVE_FAILURES} times in a row, so I stopped. Tell me how you’d like to proceed.`,
          );
          endLoop();
          return;
        }
        // Otherwise keep going: the error is now in the history, so the agent
        // can read it, work out the cause, and propose a fix.
      } else {
        consecutiveFailuresRef.current = 0;
      }
      if (stepCountRef.current >= MAX_STEPS) {
        addAssistant(
          `I’ve run ${MAX_STEPS} steps. Tell me to keep going if there’s more to do.`,
        );
        endLoop();
        return;
      }
      void planNextRef.current();
    });

    window.api.startCommand({ id: runId, command, cwd, shell: env.shell });
    // Register in the live-processes board so the sidebar's Running section
    // shows it. The global listeners (installProcessListeners) handle its
    // output (URL detection) and exit (status) from here. Long-lived commands
    // (dev servers, watchers) stay visible; quick ones finish and drop out.
    registerProcess({
      stepId: runId,
      conversationId: terminalId,
      command,
      cwd,
      shell: env.shell,
    });
  };

  startPlanRef.current = async () => {
    const env = envRef.current;
    if (!env) {
      addAssistant('I could not detect your shell yet. Try reopening the app.');
      endLoop();
      return;
    }
    setThinking(true);
    let result;
    try {
      result = await window.api.agentPlanAll({
        goal: goalRef.current,
        // Carry recent executed steps so follow-up questions/goals have context.
        priorSteps: priorStepsRef.current.slice(-10),
        cwd: workDirRef.current || env.homeDir,
        platform: env.platform,
        shell: env.shell,
        engine: engineRef.current,
        model: modelRef.current,
        providerId: providerIdRef.current,
        image: imageRef.current,
        terminalContext: collectTerminalContext(terminalId),
      });
    } catch {
      addAssistant('Something went wrong reaching the AI. Please try again.');
      endLoop();
      return;
    }
    setThinking(false);
    if (stopRef.current) {
      endLoop();
      return;
    }
    if (!result.ok) {
      // Billing limits get a clean upgrade card instead of a plain message.
      // proTrial also reverts the model selection to the free default.
      if (result.code === 'limit_reached') {
        setMessages((p) => [...p, { kind: 'limit', id: newId(), reason: 'credits' }]);
      } else if (result.code === 'feature_capped' && result.cap === 'proTrial') {
        setBrainId(DEFAULT_FREE_BRAIN);
        setMessages((p) => [...p, { kind: 'limit', id: newId(), reason: 'proTrial' }]);
      } else {
        addAssistant(result.error);
      }
      refreshUsage();
      endLoop();
      return;
    }
    refreshUsage();
    const plan = result.plan;
    if (plan.done || plan.steps.length === 0) {
      // Goal already complete, or a pure question answered from the snapshot.
      addAssistant(plan.summary || plan.message || 'All done.');
      endLoop();
      return;
    }
    // Apply the per-capability permission rules: mark "never" steps blocked,
    // and — when every step is "always" and auto-approve is on — run the plan
    // immediately without waiting for the Approve click.
    const perms = settings?.permissions;
    const autoOk = settings?.autoApproveReadonly ?? true;
    const planId = newId();
    const steps: PlanStepUI[] = plan.steps.map((s) => ({
      command: s.command,
      reason: s.reason,
      readOnly: s.readOnly,
      blocked: permissionFor(perms, assessCommand(s.command).capability) === 'never',
      status: 'idle',
      output: '',
      exitCode: null,
      path: s.path,
      preview: s.preview,
    }));
    const simulated = simulateRef.current;
    const allAlways =
      plan.steps.length > 0 &&
      plan.steps.every(
        (s) => permissionFor(perms, assessCommand(s.command).capability) === 'always',
      );
    // A simulation never runs on its own — it's a preview.
    const autoRun = autoOk && allAlways && !simulated;

    setMessages((p) => [
      ...p,
      {
        kind: 'plan',
        id: planId,
        summary: plan.summary,
        estimate: plan.estimate,
        status: autoRun ? 'running' : 'pending',
        steps,
        simulated,
      },
    ]);
    if (autoRun) {
      void runPlanRef.current(
        planId,
        steps.map((s) => ({ command: s.command, blocked: s.blocked })),
      );
    }
  };

  runPlanRef.current = async (planId, steps) => {
    const env = envRef.current;
    const cwd = workDirRef.current;
    if (!env) {
      update(planId, { status: 'failed' } as Partial<AgentMessage>);
      addAssistant('Could not detect your shell.');
      endLoop();
      return;
    }
    let blockedCount = 0;
    for (let i = 0; i < steps.length; i++) {
      if (stopRef.current) {
        markRemainingSkipped(planId, i);
        update(planId, { status: 'failed' } as Partial<AgentMessage>);
        endLoop();
        return;
      }
      // A step whose capability is set to "never" is refused, not run.
      if (steps[i].blocked) {
        blockedCount += 1;
        updatePlanStep(planId, i, { status: 'skipped' });
        continue;
      }
      const command = steps[i].command;
      // Recovery Vault: before a delete runs, copy its targets into the vault
      // so the deletion is reversible. Non-fatal — a failed capture must not
      // block the command (the OS Recycle Bin is still the fallback).
      const assessment = assessCommand(command);
      if (assessment.capability === 'delete' && assessment.files.length > 0) {
        try {
          // Free keeps deletes 24h; Pro defaults to a week (extendable to forever).
          await window.api.vaultCapture({
            command,
            cwd,
            paths: assessment.files,
            retention: isPro ? 'week' : 'day',
          });
          window.dispatchEvent(new Event('verlox:vault-changed'));
        } catch {
          // ignore
        }
      }
      // Save a restore point before each changing step (best-effort).
      try {
        await window.api.snapshotCheckpoint(`Before: ${command}`);
      } catch {
        // No restore point available; proceed.
      }
      updatePlanStep(planId, i, { status: 'running', output: '' });
      let stepOutput = '';
      const code = await runOneCommand(command, cwd, env.shell, (out) => {
        stepOutput = out;
        updatePlanStep(planId, i, { output: out });
      });
      const failed = code !== 0 && code !== null;
      updatePlanStep(planId, i, { status: failed ? 'failed' : 'done', exitCode: code });
      // Remember what ran so later turns have conversation context (e.g. a
      // follow-up "where's the file I just made?"). The agent's commands run on
      // a side bench invisible to the terminal snapshot, so this history is the
      // only record it gets.
      priorStepsRef.current.push({ command, exitCode: code, output: stepOutput });
      lastCommandRef.current = command;
      // Timeline replay: log the executed action (main timestamps + classifies).
      void window.api
        .timelineRecord({ command, exitCode: code, cwd })
        .then(() => window.dispatchEvent(new Event('verlox:timeline-changed')))
        .catch(() => {});
      if (failed) {
        markRemainingSkipped(planId, i + 1);
        update(planId, { status: 'failed' } as Partial<AgentMessage>);
        addAssistant(
          `Step ${i + 1} failed (exit ${code}). I stopped the plan — tell me how you’d like to proceed.`,
        );
        endLoop();
        return;
      }
    }
    update(planId, { status: 'done' } as Partial<AgentMessage>);
    addAssistant(
      blockedCount > 0
        ? `Plan complete. ✓ (${blockedCount} step${blockedCount > 1 ? 's' : ''} blocked by your permission settings.)`
        : 'Plan complete. ✓',
    );
    endLoop();
  };

  const approve = (id: string, command: string) => {
    void runProposalRef.current(id, command);
  };

  const deny = (id: string) => {
    update(id, { status: 'denied', note: 'Skipped. Nothing was run.' });
    addAssistant('Okay, I skipped that and stopped. What would you like instead?');
    endLoop();
  };

  const stop = () => {
    stopRef.current = true;
    if (currentRunIdRef.current) window.api.stopCommand(currentRunIdRef.current);
    addAssistant('Stopped.');
    endLoop();
  };

  // True while a simulate run is being set up, so startPlanRef marks the plan
  // as a preview (predicted outcome, nothing runs until "Run for real").
  const simulateRef = useRef(false);

  const submit = async (e?: FormEvent, simulate = false) => {
    e?.preventDefault();
    const text = input.trim();
    // Allow an image-only goal (e.g. "what's this?" with a screenshot).
    if ((!text && !attachment) || runningRef.current) return;
    simulateRef.current = simulate;

    addUser(attachment ? `${text || 'Take a look at this image.'} 📎` : text);
    setInput('');

    const env = envRef.current;
    if (!env) {
      addAssistant('I could not detect your shell yet. Try reopening the app.');
      return;
    }

    // Working folder: a folder the user explicitly chose wins; otherwise
    // fall back to the protected folder, then home.
    if (pickedFolderRef.current) {
      workDirRef.current = pickedFolderRef.current;
      setWorkDir(pickedFolderRef.current);
    } else {
      try {
        const status = await window.api.snapshotStatus();
        const dir = status.guardedFolder ?? env.homeDir;
        workDirRef.current = dir;
        setWorkDir(dir);
      } catch {
        // Keep last known folder.
      }
    }

    // Capture the image for the first step, then clear the staged attachment.
    imageRef.current = attachment
      ? { mediaType: attachment.mediaType, base64Data: attachment.base64Data }
      : null;
    setAttachment(null);
    setAttachmentError(null);

    goalRef.current = text || 'Take a look at this image and help.';
    // NOTE: priorStepsRef is intentionally NOT cleared here — it accumulates
    // across the conversation so follow-ups ("where's that file?") have context.
    stepCountRef.current = 0;
    consecutiveFailuresRef.current = 0;
    lastCommandRef.current = null;
    stopRef.current = false;
    engineRef.current = selectedBrain.engine;
    modelRef.current = selectedBrain.model;
    providerIdRef.current = selectedBrain.providerId;
    runningRef.current = true;
    setRunning(true);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    // Plan-first: lay out the whole plan, then run it on approval.
    await startPlanRef.current();
  };

  // --- folder + image handlers ---
  const handlePickFolder = (sel: PathSelection) => {
    pickedFolderRef.current = sel.dir;
    workDirRef.current = sel.dir;
    setWorkDir(sel.dir);
    setFolderLocked(true);
    setPickerOpen(false);
    // Keep the raw terminal in sync — cd it to the same folder.
    window.api.ptyInput({ id: terminalId, data: `cd "${sel.dir}"\r` });
  };

  const acceptFile = async (file: File) => {
    if (!ACCEPTED_IMAGE_TYPES.has(file.type)) {
      setAttachmentError('Only PNG, JPEG, WebP, and GIF images are supported.');
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      const mb = (file.size / (1024 * 1024)).toFixed(1);
      setAttachmentError(`Image is ${mb} MB — the limit is 5 MB.`);
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const base64Data = dataUrl.includes(',')
        ? dataUrl.slice(dataUrl.indexOf(',') + 1)
        : dataUrl;
      setAttachment({ mediaType: file.type, base64Data, dataUrl, name: file.name || 'image' });
      setAttachmentError(null);
    } catch {
      setAttachmentError('Could not read that file. Try a different image.');
    }
  };

  const onFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void acceptFile(file);
    e.target.value = '';
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i += 1) {
      if (items[i].kind === 'file' && items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile();
        if (file) {
          e.preventDefault();
          void acceptFile(file);
          return;
        }
      }
    }
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (Array.from(e.dataTransfer.types).includes('Files')) {
      e.preventDefault();
      setDragging(true);
    }
  };
  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (e.currentTarget === e.target) setDragging(false);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const file = Array.from(e.dataTransfer.files).find((f) =>
      ACCEPTED_IMAGE_TYPES.has(f.type),
    );
    if (file) void acceptFile(file);
  };

  const onTextareaKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit(e as unknown as FormEvent);
    }
  };

  const onTextareaInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 96)}px`;
  };

  const pickBrain = (b: Brain) => {
    // A free user who has used up the daily Pro trial can't select a Pro
    // model — clicking it opens the upgrade card instead.
    if (isProBrain(b) && proLocked) {
      setBrainMenuOpen(false);
      openUpgrade({ feature: 'Pro models' });
      return;
    }
    userPickedBrainRef.current = true;
    setBrainId(b.id);
    setBrainMenuOpen(false);
    // Picking the bundled local model when it isn't downloaded yet kicks the
    // install: ~30 MB binary + ~2 GB weights, with progress in the modal.
    if (b.engine === 'local' && localStatus && !localStatus.installed) {
      void window.api.ensureLocalModel();
    }
  };

  // Picker categories in the order they render: Free, Pro, then Your providers
  // (BYOK). Only include sections that actually have entries — a user with no
  // custom providers doesn't see an empty "Your providers" header.
  // Picker categories: Free → Pro → Offline → Your providers. The Offline
  // section renders even when no models are listed, because the empty state
  // is itself useful (an "Install Ollama" prompt). Custom/free/pro sections
  // appear only when they have entries.
  const pickerSections: Array<{ tier: 'free' | 'pro' | 'offline' | 'custom'; label: string }> = (
    [
      { tier: 'free', label: 'Free' },
      { tier: 'pro', label: 'Pro' },
      { tier: 'offline', label: 'Offline · local' },
      { tier: 'custom', label: 'Your providers' },
    ] as const
  ).filter((s) => s.tier === 'offline' || brains.some((b) => b.tier === s.tier));
  // Show the conversation thread only when there's something to show, so the
  // panel stays a clean, calm input bar when idle (no manual collapse).
  const showThread = messages.length > 0 || thinking;
  // The bar opens on hover or focus, and stays open while there's a reason to:
  // typing, a turn running, the model/settings menus, a thread, or an image.
  // Hover/focus drive open/close. Note: a conversation thread does NOT keep it
  // open — so it always collapses on mouse-out and re-opens on hover, even with
  // content. It stays open only during active use (typing, a running turn, an
  // open menu/picker, a pending attachment) so it can't collapse mid-action.
  // Hover, an active turn, an open menu/picker, a staged attachment, or text in
  // the box keep the thread expanded. NOTE: textarea focus alone does NOT —
  // the collapsed state IS the input bar, so focus needn't pin it open. This is
  // what lets the panel reliably collapse when you mouse away.
  const open =
    hovered ||
    running ||
    brainMenuOpen ||
    pickerOpen ||
    !!attachment ||
    input.trim().length > 0;

  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="absolute bottom-4 left-1/2 z-10 flex w-[min(92%,680px)] -translate-x-1/2 flex-col overflow-hidden rounded-3xl border border-black/10 bg-white/95 shadow-xl backdrop-blur"
      style={
        !open ? undefined : showThread ? { height: 'min(42%, 19rem)' } : undefined
      }
    >
      {/* Header (no `relative` so the settings overlay below anchors to the
          whole panel, not just this bar). */}
      <div className="shrink-0">
        {/* Header bar — height + fade animate with the bar's open state. The
            overflow-hidden is on this wrapper (not the header div), so the
            settings overlay below still anchors to the whole panel. */}
        <div
          className={`grid transition-all duration-200 ease-out ${
            open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
          }`}
        >
          <div className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-black/5 px-3 py-2">
        <div className="flex min-w-0 items-center gap-1.5 text-[#6A6A6A]">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
            className="shrink-0"
          >
            <path
              d="M12 3l1.8 4.9L18.7 9.7 13.8 11.5 12 16.4 10.2 11.5 5.3 9.7 10.2 7.9 12 3z"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinejoin="round"
            />
          </svg>
          <span className="shrink-0 text-xs font-medium">Verlox</span>
          {workDir && (
            <span
              className="ml-1 truncate text-[11px] text-[#9A9A9A]"
              title={`Working in ${workDir}`}
            >
              · working in {shortFolder(workDir)}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {running && (
            <button
              onClick={stop}
              className="rounded-md border border-[#B4632F]/30 bg-[#FBF1EA] px-2 py-0.5 text-[11px] font-medium text-[#B4632F] hover:bg-[#F6E6DB]"
            >
              Stop
            </button>
          )}
        </div>
            </div>
          </div>
        </div>

        {/* Settings now live in a dedicated page (SettingsView), opened from
            the top-bar gear — no longer an overlay inside this panel. */}
      </div>

      {/* Conversation area */}
      {open && showThread && (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {messages.length === 0 && !thinking ? (
            <div className="mx-auto max-w-md py-6 text-center text-sm leading-relaxed text-[#9A9A9A]">
              Tell Verlox what you want to do, in plain English. It works one
              step at a time, asks before changing anything, and saves a
              restore point so you can always undo.
            </div>
          ) : (
            <div ref={msgListRef} className="flex flex-col gap-3">
              {(() => {
                // Number the proposal cards in order so the run reads as
                // sequential steps, even though the agent proposes one at a
                // time today. (Plan-first multi-step is the next iteration.)
                let stepCounter = 0;
                const stepOf = new Map<string, number>();
                for (const mm of messages)
                  if (mm.kind === 'proposal') stepOf.set(mm.id, ++stepCounter);
                return messages.map((m) => {
                  if (m.kind === 'user') {
                    return (
                      <div key={m.id} className="flex justify-end">
                        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-[#EFEFED] px-3 py-1.5 text-sm text-[#3A3A3A]">
                          {m.text}
                        </div>
                      </div>
                    );
                  }
                  if (m.kind === 'assistant') {
                    return (
                      <div key={m.id} className="group max-w-[90%]">
                        <div className="text-sm leading-relaxed text-[#3A3A3A]">
                          {m.text}
                        </div>
                        <div className="mt-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                          <CopyButton text={m.text} variant="inline" label="Copy" />
                        </div>
                      </div>
                    );
                  }
                  // Billing limit → a clean card: Get Pro, or switch to the
                  // free default model. Replaces the old plain-text message.
                  if (m.kind === 'limit') {
                    const dismiss = () =>
                      setMessages((p) => p.filter((x) => x.id !== m.id));
                    const isProTrial = m.reason === 'proTrial';
                    const remaining = usage?.remaining ?? 0;
                    // Three cases, in priority order:
                    //  1. Out of credits entirely → "no more credits until X"
                    //     (most important — wins even if the model was also
                    //     unaffordable, since nothing runs regardless).
                    //  2. Credits left but not enough for THIS model → suggest a
                    //     cheaper one.
                    //  3. Daily Pro trial used up → reverted to the free model.
                    const outOfCredits = !isProTrial && remaining <= 0;
                    const resetPhrase = formatResets(usage?.resetsAt);
                    const title = isProTrial
                      ? 'Daily Pro limit reached'
                      : outOfCredits
                        ? "You're out of credits"
                        : 'Not enough credits for this model';
                    const body = isProTrial
                      ? `You've used your ${proTrialCap?.limit ?? 4} free Pro-model messages today, so you're back on the free model. Upgrade to keep using Sonnet, Opus, and o3.`
                      : outOfCredits
                        ? `You've used all your credits for now. You'll get more ${resetPhrase}. Upgrade to Pro for a much larger allowance.`
                        : `You have ${remaining} credit${remaining === 1 ? '' : 's'} left, and this model costs more than that. Switch to a cheaper model like Haiku, or upgrade to Pro.`;
                    // Switching to the free model only helps when there's at
                    // least 1 credit to spend (Haiku costs 1) or the trial is up.
                    const showSwitch = isProTrial || !outOfCredits;
                    return (
                      <div key={m.id} className="max-w-[90%]">
                        <div className="rounded-2xl border border-black/10 bg-white p-4 shadow-sm">
                          <div className="flex items-center gap-2">
                            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#F4F4F5] text-[#6A6A6A]">
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <rect x="3" y="11" width="18" height="11" rx="2" />
                                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                              </svg>
                            </span>
                            <p className="text-[13px] font-semibold text-[#2A2A2A]">{title}</p>
                          </div>
                          <p className="mt-2 text-[12.5px] leading-relaxed text-[#6A6A6A]">{body}</p>
                          <div className="mt-3 flex gap-2">
                            <button
                              type="button"
                              onClick={() =>
                                openUpgrade({ feature: isProTrial ? 'Pro models' : 'more credits' })
                              }
                              className="rounded-lg bg-[#15161A] px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90"
                            >
                              Get Pro
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                if (showSwitch) setBrainId(DEFAULT_FREE_BRAIN);
                                dismiss();
                              }}
                              className="rounded-lg border border-black/10 px-3 py-1.5 text-[12px] font-medium text-[#3A3A3A] hover:bg-black/5"
                            >
                              {showSwitch ? 'Switch to free model' : 'Got it'}
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  }
                  // Plan → the whole forecast as one numbered, scored card.
                  if (m.kind === 'plan') {
                    const stepRisks = m.steps.map((s) => assessCommand(s.command));
                    const overall = highestRisk(stepRisks.map((r) => r.level));
                    // Only count files from steps that will actually run — a
                    // blocked (never-allowed) step is refused, so it touches
                    // nothing and shouldn't appear in "Files it will touch".
                    const allFiles = Array.from(
                      new Set(
                        m.steps.flatMap((s, i) => (s.blocked ? [] : stepRisks[i].files)),
                      ),
                    ).slice(0, 12);
                    // Sandbox: aggregate the plan's predicted effect for the
                    // simulation summary (nothing actually runs).
                    const outcome: string[] = [];
                    if (m.simulated) {
                      const cnt = (cap: string) =>
                        m.steps.reduce(
                          (n, s, i) =>
                            n + (!s.blocked && stepRisks[i].capability === cap ? 1 : 0),
                          0,
                        );
                      if (allFiles.length)
                        outcome.push(
                          `${allFiles.length} file${allFiles.length > 1 ? 's' : ''} affected`,
                        );
                      const add = (cap: string, noun: string) => {
                        const n = cnt(cap);
                        if (n) outcome.push(`${n} ${noun}${n > 1 ? 's' : ''}`);
                      };
                      add('install', 'package install');
                      add('delete', 'deletion');
                      add('build', 'build/test run');
                      add('network', 'network request');
                      add('deploy', 'deployment');
                      add('database', 'database change');
                      if (outcome.length === 0) outcome.push('No changes — read-only.');
                    }
                    return (
                      <div
                        key={m.id}
                        className="overflow-hidden rounded-xl border border-black/10 bg-[#FBFBFA]"
                      >
                        <div className="flex items-center justify-between gap-2 border-b border-black/[0.06] px-3 py-2">
                          <span className="text-[11px] font-semibold text-[#6A6A6A]">
                            {m.simulated ? 'Simulation' : 'Plan'} · {m.steps.length} step
                            {m.steps.length > 1 ? 's' : ''}
                          </span>
                          <div className="flex shrink-0 items-center gap-1.5">
                            {m.simulated && (
                              <span className="rounded-full bg-[#EAF1F6] px-2 py-0.5 text-[10.5px] font-semibold text-[#2E5FA3]">
                                Preview · nothing ran
                              </span>
                            )}
                            {/* Overall risk is a roll-up — only when multi-step
                                (a single step shows its own badge below). */}
                            {m.steps.length > 1 && <RiskBadge level={overall} />}
                          </div>
                        </div>
                        <div className="p-3">
                          {m.summary && (
                            <div className="text-xs leading-relaxed text-[#4A4A4A]">
                              {m.summary}
                            </div>
                          )}
                          {m.estimate && (
                            <div className="mt-1.5 inline-block rounded-md bg-black/[0.04] px-2 py-0.5 text-[11px] text-[#6A6A6A]">
                              Estimated changes: {m.estimate}
                            </div>
                          )}
                          {m.simulated && (
                            <div className="mt-2 rounded-lg border border-[#2E5FA3]/20 bg-[#F2F7FB] p-2">
                              <div className="text-[10px] font-medium uppercase tracking-wide text-[#2E5FA3]">
                                Predicted outcome
                              </div>
                              <div className="mt-1 flex flex-wrap gap-1">
                                {outcome.map((o) => (
                                  <span
                                    key={o}
                                    className="rounded-md border border-[#2E5FA3]/15 bg-white px-1.5 py-0.5 text-[10.5px] text-[#3A5A82]"
                                  >
                                    {o}
                                  </span>
                                ))}
                              </div>
                              <div className="mt-1 text-[10px] text-[#6A8FB5]">
                                Forecast from the plan — nothing has run.
                              </div>
                            </div>
                          )}
                          <ol className="mt-2.5 overflow-hidden rounded-lg border border-black/[0.06] bg-white">
                            {m.steps.map((s, i) => (
                              <PlanStepRow
                                key={i}
                                index={i}
                                step={s}
                                simulated={m.simulated}
                                cwd={workDir}
                              />
                            ))}
                          </ol>
                          {allFiles.length > 0 && (
                            <div className="mt-2.5">
                              <div className="text-[10px] font-medium uppercase tracking-wide text-[#A8A8A8]">
                                Files it will touch
                              </div>
                              <div className="mt-1 flex flex-wrap gap-1">
                                {allFiles.map((f) => (
                                  <span
                                    key={f}
                                    className="max-w-full truncate rounded bg-black/[0.05] px-1.5 py-0.5 font-mono text-[10.5px] text-[#6A6A6A]"
                                  >
                                    {f}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                          {m.status === 'pending' && (
                            <div className="mt-3 flex gap-2">
                              {m.simulated ? (
                                <>
                                  <button
                                    onClick={() => runForReal(m)}
                                    className="rounded-lg bg-[#3A3A3A] px-3 py-1 text-xs font-medium text-white hover:bg-black"
                                  >
                                    Run for real
                                  </button>
                                  <button
                                    onClick={() => denyPlan(m.id)}
                                    className="rounded-lg border border-black/10 px-3 py-1 text-xs text-[#6A6A6A] hover:bg-black/5"
                                  >
                                    Dismiss
                                  </button>
                                </>
                              ) : (
                                <>
                                  <button
                                    onClick={() => approvePlan(m)}
                                    className="rounded-lg bg-[#3A3A3A] px-3 py-1 text-xs font-medium text-white hover:bg-black"
                                  >
                                    Approve plan & run
                                  </button>
                                  <button
                                    onClick={() => denyPlan(m.id)}
                                    className="rounded-lg border border-black/10 px-3 py-1 text-xs text-[#6A6A6A] hover:bg-black/5"
                                  >
                                    Deny
                                  </button>
                                </>
                              )}
                            </div>
                          )}
                          {m.status === 'running' && (
                            <div className="mt-2 text-[11px] text-[#9A9A9A]">
                              Running the plan…
                            </div>
                          )}
                          {m.status === 'done' && (
                            <div className="mt-2 text-[11px] text-[#3E7A53]">Plan complete.</div>
                          )}
                          {m.status === 'failed' && (
                            <div className="mt-2 text-[11px] text-[#B4632F]">Plan stopped.</div>
                          )}
                          {m.status === 'denied' && (
                            <div className="mt-2 text-[11px] text-[#9A9A9A]">Discarded.</div>
                          )}
                        </div>
                      </div>
                    );
                  }

                  // Proposal → a risk-scored step card. The risk engine
                  // (shared/risk.ts) classifies the command; the card shows the
                  // score, what it does, and the files it will touch — so the
                  // action is understandable before it runs.
                  const risk = assessCommand(m.command);
                  return (
                    <div
                      key={m.id}
                      className="overflow-hidden rounded-xl border border-black/10 bg-[#FBFBFA]"
                    >
                      {/* Header: step number + capability + risk badge */}
                      <div className="flex items-center justify-between gap-2 border-b border-black/[0.06] px-3 py-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[#3A3A3A] text-[9px] font-semibold text-white">
                            {stepOf.get(m.id)}
                          </span>
                          <span className="truncate text-[11px] font-medium text-[#6A6A6A]">
                            {risk.label}
                          </span>
                        </div>
                        <RiskBadge level={risk.level} />
                      </div>

                      <div className="p-3">
                        {m.reason && (
                          <div className="text-xs leading-relaxed text-[#4A4A4A]">
                            {m.reason}
                          </div>
                        )}
                        <code className="mt-2 block break-all rounded-lg bg-black/[0.04] px-2.5 py-1.5 font-mono text-xs text-[#3A3A3A]">
                          {m.command}
                        </code>
                        <div className="mt-2 text-[11px] text-[#9A9A9A]">{risk.reason}</div>

                        {risk.files.length > 0 && (
                          <div className="mt-2">
                            <div className="text-[10px] font-medium uppercase tracking-wide text-[#A8A8A8]">
                              Files it will touch
                            </div>
                            <div className="mt-1 flex flex-wrap gap-1">
                              {risk.files.map((f) => (
                                <span
                                  key={f}
                                  className="max-w-full truncate rounded bg-black/[0.05] px-1.5 py-0.5 font-mono text-[10.5px] text-[#6A6A6A]"
                                >
                                  {f}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}

                        <div className="mt-2 text-[11px] text-[#9A9A9A]">
                          {m.readOnly
                            ? 'Reads only, changes nothing.'
                            : 'Makes changes on your computer.'}
                        </div>

                        {m.warn && (
                          <div className="mt-2 rounded-lg bg-[#FBF1EA] px-2 py-1 text-[11px] text-[#B4632F]">
                            Heads up: {m.warn}
                          </div>
                        )}

                        {m.status === 'pending' && (
                          <div className="mt-2.5 flex gap-2">
                            <button
                              onClick={() => approve(m.id, m.command)}
                              className="rounded-lg bg-[#3A3A3A] px-3 py-1 text-xs font-medium text-white hover:bg-black"
                            >
                              Approve & run
                            </button>
                            <button
                              onClick={() => deny(m.id)}
                              className="rounded-lg border border-black/10 px-3 py-1 text-xs text-[#6A6A6A] hover:bg-black/5"
                            >
                              Deny
                            </button>
                          </div>
                        )}

                        {m.status === 'running' && (
                          <div className="mt-2 text-[11px] text-[#9A9A9A]">Running…</div>
                        )}
                        {m.status === 'denied' && (
                          <div className="mt-2 text-[11px] text-[#9A9A9A]">Skipped.</div>
                        )}
                        {(m.status === 'done' || m.status === 'failed') && (
                          <div
                            className={`mt-2 text-[11px] ${
                              m.status === 'done' ? 'text-[#3E7A53]' : 'text-[#B4632F]'
                            }`}
                          >
                            {m.status === 'done'
                              ? 'Done.'
                              : `Finished with an error (code ${m.exitCode}).`}
                          </div>
                        )}

                        {(m.status === 'running' ||
                          m.status === 'done' ||
                          m.status === 'failed') &&
                          m.output.trim() !== '' && (
                            <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-hairline bg-surface-subtle px-2.5 py-2 font-mono text-[11px] leading-relaxed text-[#3A3A3A]">
                              {m.output}
                            </pre>
                          )}

                        {m.note && (
                          <div className="mt-1.5 text-[11px] text-[#9A9A9A]">{m.note}</div>
                        )}
                      </div>
                    </div>
                  );
                });
              })()}
              {thinking && (
                <div className="text-[11px] italic text-[#9A9A9A]">
                  Verlox is thinking…
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Input */}
      {/* Bottom region: attachment preview + error + input row, with
          drag-and-drop for images. */}
      <div
        className="shrink-0 border-t border-black/5"
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {attachment && (
          <div className="flex items-start px-3 pt-2">
            <div className="relative">
              <img
                src={attachment.dataUrl}
                alt={attachment.name}
                className="h-12 w-12 rounded-lg border border-black/10 object-cover"
              />
              <button
                type="button"
                onClick={() => {
                  setAttachment(null);
                  setAttachmentError(null);
                }}
                aria-label="Remove image"
                className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full border border-black/10 bg-white text-[10px] leading-none text-[#6A6A6A] shadow hover:text-[#3A3A3A]"
              >
                ✕
              </button>
            </div>
          </div>
        )}
        {attachmentError && !attachment && (
          <div className="mx-3 mt-2 flex items-center justify-between gap-2 rounded-lg border border-[#B4632F]/30 bg-[#FBF1EA] px-2 py-1 text-[11px] text-[#B4632F]">
            <span>{attachmentError}</span>
            <button type="button" onClick={() => setAttachmentError(null)} aria-label="Dismiss">
              ✕
            </button>
          </div>
        )}
        <form onSubmit={submit} className="flex flex-col px-3.5 pb-3 pt-2.5">
          {/* Input — full width on top, like the mockup. */}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={onTextareaInput}
            onKeyDown={onTextareaKeyDown}
            onPaste={onPaste}
            disabled={running}
            rows={1}
            placeholder={
              running
                ? 'Working… approve a step or press Stop'
                : attachment
                  ? 'Add a note about the image…'
                  : 'Ask Verlox to do something…'
            }
            aria-label="Ask Verlox to do something"
            className={`w-full resize-none bg-transparent px-1 pt-0.5 text-[14px] leading-6 text-[#3A3A3A] placeholder:text-[#9A9A9A] focus:outline-none disabled:opacity-60 ${
              dragging ? 'rounded-lg ring-2 ring-[#3A3A3A]/15' : ''
            }`}
            style={{ maxHeight: '120px' }}
          />

          {/* Control row — left tools, right model + circular send.
              Height + fade animate with the bar's open state. */}
          <div
            className={`grid transition-all duration-200 ease-out ${
              open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
            }`}
          >
            <div className="overflow-hidden">
              <div className="flex items-center gap-1.5 pt-2">
            {/* Choose working folder */}
            <button
              ref={folderBtnRef}
              type="button"
              onClick={() => {
                if (!pickerOpen) {
                  const r = folderBtnRef.current?.getBoundingClientRect();
                  if (r) setPickerAnchor({ left: r.left, top: r.top });
                }
                setPickerOpen((o) => !o);
              }}
              disabled={running}
              title={folderLocked ? `Working in ${workDir}` : 'Choose a folder to work in'}
              aria-label="Choose working folder"
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-colors disabled:opacity-40 ${
                folderLocked
                  ? 'border-[#C8962E]/50 bg-[#C8962E]/10 text-[#A9781E]'
                  : 'border-black/10 text-[#6A6A6A] hover:text-[#3A3A3A]'
              }`}
            >
              <svg width="15" height="15" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M2 4.5h5l1.7 2H16v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
              </svg>
            </button>
            {/* Attach image */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={running}
              title="Attach an image (or paste / drop one)"
              aria-label="Attach image"
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-colors disabled:opacity-40 ${
                attachment
                  ? 'border-[#3A3A3A]/30 bg-black/[0.05] text-[#3A3A3A]'
                  : 'border-black/10 text-[#6A6A6A] hover:text-[#3A3A3A]'
              }`}
            >
              <svg width="15" height="15" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M14.5 8.5l-6.2 6.2a3 3 0 1 1-4.3-4.3L9.7 4.7a2 2 0 1 1 2.8 2.8L7 13" />
              </svg>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              onChange={onFileInput}
            />
            {/* Model switcher */}
            <div ref={brainWrapRef} className="shrink-0">
              <button
                ref={brainBtnRef}
                type="button"
                onClick={() => {
                  if (!brainMenuOpen) {
                    const r = brainBtnRef.current?.getBoundingClientRect();
                    if (r) {
                      setBrainCoords({ left: r.left, bottom: window.innerHeight - r.top + 8 });
                    }
                    // Re-probe Ollama every time the menu opens so freshly
                    // pulled models (or a daemon the user just started) show
                    // up without restarting the app. Probe is < 1.5s.
                    probeOllamaNow();
                  }
                  setBrainMenuOpen((o) => !o);
                }}
                disabled={running}
                aria-haspopup="listbox"
                aria-expanded={brainMenuOpen}
                title={`Model: ${selectedBrain.label}`}
                className="flex max-w-[150px] items-center gap-1 rounded-lg px-2 py-1.5 text-[12px] font-medium text-[#6A6A6A] hover:bg-black/5 hover:text-[#3A3A3A] disabled:opacity-40"
              >
                <span className="truncate">{selectedBrain.label}</span>
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 12 12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className={`shrink-0 transition-transform ${brainMenuOpen ? 'rotate-180' : ''}`}
                  aria-hidden="true"
                >
                  <polyline points="3,4.5 6,7.5 9,4.5" />
                </svg>
              </button>
            </div>
            {brainMenuOpen &&
              brainCoords &&
              createPortal(
                <div
                  ref={brainMenuRef}
                  style={{
                    position: 'fixed',
                    left: brainCoords.left,
                    bottom: brainCoords.bottom,
                    zIndex: 50,
                  }}
                  className="flex w-60 flex-col overflow-hidden rounded-xl border border-black/10 bg-white shadow-xl"
                >
                  {/* The model list scrolls inside a fixed-height panel so the
                      menu doesn't grow taller than the bottom-anchored chat bar
                      when many providers are listed. The "+ Add provider" row
                      stays pinned at the bottom outside the scroll area. The
                      top/bottom white-fade overlays cover content under the
                      first/last visible row so a half-cropped model name reads
                      as "more above/below" rather than a chopped cutoff. */}
                  <div className="relative">
                    <div
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-gradient-to-b from-white via-white/95 to-transparent"
                    />
                    <div
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6 bg-gradient-to-t from-white via-white/95 to-transparent"
                    />
                    <div className="picker-scroll max-h-[320px] overflow-y-auto p-1">
                  {pickerSections.map((section) => (
                    <div key={section.tier}>
                      <div className="px-2.5 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wide text-[#B0B0B0]">
                        {section.label}
                      </div>
                      {/* Offline empty states: tell the user how to get models
                          here. Two distinct copies so the next step is clear. */}
                      {section.tier === 'offline' && ollama.models.length === 0 && (
                        <div className="px-2.5 py-2 text-[11px] leading-relaxed text-[#8A8A8A]">
                          {ollama.available ? (
                            <span>
                              No local models yet. Pull one with{' '}
                              <span className="rounded bg-black/[0.05] px-1 py-px font-mono text-[10px] text-[#3A3A3A]">
                                ollama pull llama3.3
                              </span>
                              .
                            </span>
                          ) : (
                            <span>
                              Install{' '}
                              <a
                                href="https://ollama.com/download"
                                target="_blank"
                                rel="noreferrer noopener"
                                className="underline decoration-[#B0B0B0] underline-offset-2 hover:text-[#3A3A3A]"
                              >
                                Ollama
                              </a>{' '}
                              to run models locally — free + private.
                            </span>
                          )}
                        </div>
                      )}
                      {brains
                        .filter((b) => b.tier === section.tier)
                        .map((b) => {
                          const active = b.id === brainId;
                          // Free users see Pro models with a daily-trial badge,
                          // then a lock once the trial is spent.
                          const gated = isProBrain(b) && !isPro;
                          const locked = gated && proLocked;
                          const credits = MODEL_CREDIT_COST[b.model];
                          return (
                            <button
                              key={b.id}
                              type="button"
                              onClick={() => pickBrain(b)}
                              title={
                                gated
                                  ? locked
                                    ? 'Pro model — daily free tries used up. Upgrade to use.'
                                    : `Pro model — ${proTrialLeft} free ${proTrialLeft === 1 ? 'try' : 'tries'} left today`
                                  : undefined
                              }
                              className={`group/row relative flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left ${
                                active ? 'bg-black/[0.05]' : 'hover:bg-black/[0.035]'
                              }`}
                            >
                              <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[#3A3A3A]">
                                {active ? '✓' : ''}
                              </span>
                              <span
                                className={`truncate text-xs font-medium ${
                                  locked ? 'text-[#A8A8A8]' : 'text-[#3A3A3A]'
                                }`}
                              >
                                {b.label}
                              </span>
                              {/* Right side: provider logo, plus (on Pro rows
                                  for free users) the daily trial indicator —
                                  "N left" while tries remain, a lock once
                                  spent. On hover, the per-message credit cost
                                  fades in just before the icons. */}
                              <span className="ml-auto flex shrink-0 items-center gap-1.5">
                                {/* Hover hint: hosted models show their per-
                                    message credit cost; local/BYOK models say
                                    "free · local" or "your key" so users see
                                    the cost story before they pick. */}
                                <span className="font-mono text-[9.5px] text-[#8A8A8A] opacity-0 transition-opacity duration-150 group-hover/row:opacity-100">
                                  {b.engine === 'local'
                                    ? localStatus?.installed
                                      ? 'free · on-device'
                                      : 'download · 2 GB'
                                    : b.engine === 'ollama'
                                      ? 'free · local'
                                      : b.engine === 'custom'
                                        ? 'your key'
                                        : credits !== undefined
                                          ? `${credits} cr / msg`
                                          : ''}
                                </span>
                                {gated && (
                                  locked ? (
                                    <svg className="h-3 w-3 text-[#B0B0B0]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                      <rect x="3" y="11" width="18" height="11" rx="2" />
                                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                                    </svg>
                                  ) : (
                                    <span className="rounded-full bg-black/[0.05] px-1.5 py-0.5 font-mono text-[9px] text-[#8A8A8A]">
                                      {proTrialLeft} left
                                    </span>
                                  )
                                )}
                                <ProviderIcon p={b.provider} />
                              </span>
                            </button>
                          );
                        })}
                    </div>
                  ))}
                  </div>
                  </div>
                  {/* Pinned footer — always visible regardless of scroll. */}
                  <div className="border-t border-black/[0.06] p-1">
                  <button
                    type="button"
                    onClick={() => {
                      setBrainMenuOpen(false);
                      // Open the app-level Settings page (the chat bar no longer
                      // hosts settings itself).
                      window.dispatchEvent(new Event('verlox:open-settings'));
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[11px] text-[#6A6A6A] hover:bg-black/[0.035]"
                  >
                    ＋ Add an AI provider…
                  </button>
                  </div>
                </div>,
                document.body,
              )}
            {/* Local-model install / boot modal. Visible whenever a busy
                state is broadcast (downloading / unpacking / starting) or
                there's an install error. Plain-language progress only — no
                spinner, no percentage shouting; matches the calm aesthetic. */}
            {localStatus &&
              (localStatus.state.kind === 'downloading' ||
                localStatus.state.kind === 'unpacking' ||
                localStatus.state.kind === 'starting' ||
                localStatus.state.kind === 'error') &&
              createPortal(
                <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 backdrop-blur-sm">
                  <div className="w-[420px] max-w-[92vw] rounded-2xl border border-black/10 bg-white p-6 shadow-2xl">
                    <p className="text-[13px] font-semibold text-[#2A2A2A]">
                      {(() => {
                        const s = localStatus.state;
                        if (s.kind === 'downloading')
                          return s.what === 'binary'
                            ? 'Downloading model runtime'
                            : 'Downloading Llama 3.2 3B';
                        if (s.kind === 'unpacking') return 'Unpacking model runtime';
                        if (s.kind === 'starting') return 'Starting the local model';
                        return 'Local model setup failed';
                      })()}
                    </p>
                    {localStatus.state.kind === 'downloading' && (
                      <>
                        {(() => {
                          const s = localStatus.state;
                          const pct =
                            s.total > 0 ? Math.min(100, Math.floor((s.bytes / s.total) * 100)) : 0;
                          const mb = (n: number) => (n / 1048576).toFixed(0);
                          return (
                            <>
                              <p className="mt-2 font-mono text-[11.5px] text-[#6A6A6A]">
                                {s.total > 0
                                  ? `${mb(s.bytes)} of ${mb(s.total)} MB · ${pct}%`
                                  : `${mb(s.bytes)} MB`}
                              </p>
                              <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-black/[0.06]">
                                <div
                                  className="h-full rounded-full bg-[#15161A] transition-[width] duration-150"
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                              <p className="mt-3 text-[11.5px] leading-relaxed text-[#8A8A8A]">
                                One-time download. The model then runs entirely on
                                your machine — no network, no credits.
                              </p>
                              {/* Cancel: abort the stream, drop the partial
                                  file, and revert the selection back to the
                                  free default so the user isn't stranded on
                                  a model they just stopped installing. */}
                              <div className="mt-4 flex justify-end">
                                <button
                                  type="button"
                                  onClick={() => {
                                    void window.api.cancelLocalModel();
                                    setBrainId(DEFAULT_FREE_BRAIN);
                                  }}
                                  className="rounded-lg border border-black/10 px-3 py-1.5 text-[12px] text-[#3A3A3A] hover:bg-black/5"
                                >
                                  Cancel download
                                </button>
                              </div>
                            </>
                          );
                        })()}
                      </>
                    )}
                    {localStatus.state.kind === 'unpacking' && (
                      <p className="mt-3 text-[11.5px] leading-relaxed text-[#8A8A8A]">
                        Almost there — finishing the runtime install.
                      </p>
                    )}
                    {localStatus.state.kind === 'starting' && (
                      <p className="mt-3 text-[11.5px] leading-relaxed text-[#8A8A8A]">
                        Loading the model into memory. This takes about 10 seconds
                        the first time.
                      </p>
                    )}
                    {localStatus.state.kind === 'error' && (
                      <>
                        <p className="mt-2 text-[12px] leading-relaxed text-[#B04A43]">
                          {localStatus.state.message}
                        </p>
                        <div className="mt-3 flex justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              // Switch back to a hosted model AND dismiss the
                              // error (the modal stays visible until state
                              // leaves 'error' — cancelLocalModel resets it).
                              setBrainId(DEFAULT_FREE_BRAIN);
                              void window.api.cancelLocalModel();
                            }}
                            className="rounded-lg border border-black/10 px-3 py-1.5 text-[12px] text-[#3A3A3A] hover:bg-black/5"
                          >
                            Use a hosted model
                          </button>
                          <button
                            type="button"
                            onClick={async () => {
                              // Clear the error first so the modal shows the
                              // download / starting state cleanly when the
                              // retry kicks off — otherwise it'd briefly
                              // re-show the same error message.
                              await window.api.cancelLocalModel();
                              void window.api.ensureLocalModel();
                            }}
                            className="rounded-lg bg-[#15161A] px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90"
                          >
                            Try again
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </div>,
                document.body,
              )}
            {pickerOpen &&
              pickerAnchor &&
              createPortal(
                <div
                  ref={pickerRef}
                  style={{
                    position: 'fixed',
                    left: pickerAnchor.left,
                    top: pickerAnchor.top,
                    zIndex: 50,
                  }}
                >
                  <PathPicker initialPath={workDir || null} onPick={handlePickFolder} />
                </div>,
                document.body,
              )}

            {/* Spacer pushes send to the right edge, mockup-style. */}
            <div className="flex-1" />

            {/* Simulate — preview the plan's predicted outcome without running. */}
            <button
              type="button"
              onClick={() =>
                isPro
                  ? void submit(undefined, true)
                  : openUpgrade({ feature: 'Sandbox' })
              }
              disabled={(!input.trim() && !attachment) || running}
              title={
                isPro
                  ? 'Simulate — preview the predicted outcome without running anything'
                  : 'Sandbox is a Pro feature — simulate plans with before/after diffs'
              }
              aria-label="Simulate"
              className="mr-1.5 flex h-9 shrink-0 items-center gap-1 rounded-full border border-hairline px-3 text-[11px] font-medium text-ink-label transition-colors hover:bg-surface-subtle hover:text-ink disabled:opacity-30"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M9 3h6M10 3v6.5L5.5 18A1.5 1.5 0 0 0 7 20h10a1.5 1.5 0 0 0 1.5-2L14 9.5V3"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              Simulate
              {!isPro && (
                <span className="ml-0.5 rounded bg-[#EAF1F6] px-1 py-px text-[8.5px] font-semibold text-[#2E5FA3]">
                  PRO
                </span>
              )}
            </button>

            {/* Send */}
            <button
              type="submit"
              disabled={(!input.trim() && !attachment) || running}
              aria-label="Send"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#3A3A3A] text-white transition-colors hover:bg-black disabled:opacity-30"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M5 12h13M13 6l6 6-6 6"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
              </div>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
