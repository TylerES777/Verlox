import {
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
  ProviderFormat,
  SettingsInfo,
} from '@shared/types';
import { CopyButton } from './CopyButton';
import { snapshotTerminals } from '../lib/terminalRegistry';

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

type AgentMessage =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
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

interface Brain {
  id: string;
  label: string;
  group: string;
  engine: AgentEngine;
  model: string;
  providerId?: string;
}

function buildBrains(s: SettingsInfo | null): Brain[] {
  const list: Brain[] = [
    { id: 'haiku', label: 'Haiku', group: 'Verlox', engine: 'verlox', model: 'haiku' },
    { id: 'sonnet', label: 'Sonnet', group: 'Verlox', engine: 'verlox', model: 'sonnet' },
    { id: 'opus', label: 'Opus', group: 'Verlox', engine: 'verlox', model: 'opus' },
  ];
  for (const p of s?.providers ?? []) {
    list.push({
      id: `custom:${p.id}`,
      label: p.name,
      group: 'Your providers',
      engine: 'custom',
      model: p.model,
      providerId: p.id,
    });
  }
  return list;
}

function defaultBaseUrl(format: ProviderFormat): string {
  return format === 'anthropic'
    ? 'https://api.anthropic.com'
    : 'https://api.openai.com/v1';
}

function modelPlaceholder(format: ProviderFormat): string {
  return format === 'anthropic' ? 'e.g. claude-sonnet-4-5' : 'e.g. gpt-4o';
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

export function AgentPanel({ terminalId }: AgentPanelProps) {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [workDir, setWorkDir] = useState('');

  const [settings, setSettings] = useState<SettingsInfo | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Add-provider form.
  const [formName, setFormName] = useState('');
  const [formFormat, setFormFormat] = useState<ProviderFormat>('openai');
  const [formUrl, setFormUrl] = useState(defaultBaseUrl('openai'));
  const [formModel, setFormModel] = useState('');
  const [formKey, setFormKey] = useState('');
  const [addMsg, setAddMsg] = useState<string | null>(null);
  const [addBusy, setAddBusy] = useState(false);

  // Model switcher.
  const [brainId, setBrainId] = useState<string>('sonnet');
  const [brainMenuOpen, setBrainMenuOpen] = useState(false);
  const brainWrapRef = useRef<HTMLDivElement>(null);

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

  const brains = buildBrains(settings);
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

  useEffect(() => {
    if (!brainMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (brainWrapRef.current && !brainWrapRef.current.contains(e.target as Node)) {
        setBrainMenuOpen(false);
      }
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

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, expanded, thinking]);

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

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    // Allow an image-only goal (e.g. "what's this?" with a screenshot).
    if ((!text && !attachment) || runningRef.current) return;

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
    priorStepsRef.current = [];
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
    await planNextRef.current();
  };

  // --- folder + image handlers ---
  const chooseFolder = async () => {
    const dir = await window.api.pickDirectory();
    if (!dir) return;
    pickedFolderRef.current = dir;
    workDirRef.current = dir;
    setWorkDir(dir);
    setFolderLocked(true);
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

  // --- settings actions ---
  const submitProvider = async (e: FormEvent) => {
    e.preventDefault();
    setAddBusy(true);
    setAddMsg('Checking…');
    const res = await window.api.settingsAddProvider({
      name: formName.trim(),
      format: formFormat,
      baseUrl: formUrl.trim(),
      model: formModel.trim(),
      key: formKey.trim(),
    });
    setSettings(res.settings);
    if (res.ok) {
      setAddMsg('Added.');
      setFormName('');
      setFormModel('');
      setFormKey('');
    } else {
      setAddMsg(res.error ?? 'Could not add it.');
    }
    setAddBusy(false);
  };
  const removeProvider = async (id: string) => {
    const s = await window.api.settingsRemoveProvider(id);
    setSettings(s);
    if (brainId === `custom:${id}`) setBrainId('sonnet');
  };
  const toggleAuto = async () => {
    if (!settings) return;
    const s = await window.api.settingsSetAutoApprove(!settings.autoApproveReadonly);
    setSettings(s);
    autoApproveRef.current = s.autoApproveReadonly;
  };

  const pickBrain = (b: Brain) => {
    setBrainId(b.id);
    setBrainMenuOpen(false);
  };

  const hasProviders = (settings?.providers.length ?? 0) > 0;
  const groups = Array.from(new Set(brains.map((b) => b.group)));

  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      className="absolute bottom-4 left-1/2 z-10 flex w-[min(92%,680px)] -translate-x-1/2 flex-col overflow-hidden rounded-2xl border border-black/10 bg-white/95 shadow-xl backdrop-blur"
      style={
        settingsOpen
          ? { height: 'min(80%, 32rem)' }
          : expanded
            ? { height: 'min(42%, 19rem)' }
            : undefined
      }
    >
      {/* Header (no `relative` so the settings overlay below anchors to the
          whole panel, not just this bar). */}
      <div className="flex shrink-0 items-center justify-between border-b border-black/5 px-3 py-2">
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
          <button
            onClick={() => {
              setSettingsOpen((v) => !v);
              setExpanded(true);
            }}
            className={`rounded p-1 hover:bg-black/5 ${
              hasProviders ? 'text-[#3E7A53]' : 'text-[#9A9A9A]'
            } hover:text-[#3A3A3A]`}
            aria-label="Agent settings"
            title="Settings"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
              <path
                d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <button
            onClick={() => setExpanded((v) => !v)}
            className="rounded p-1 text-[#9A9A9A] hover:bg-black/5 hover:text-[#3A3A3A]"
            aria-label={expanded ? 'Collapse panel' : 'Expand panel'}
            title={expanded ? 'Collapse' : 'Expand'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d={expanded ? 'M6 9l6 6 6-6' : 'M6 15l6-6 6 6'}
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>

        {/* Settings overlay — covers the whole panel and scrolls inside it,
            so the full form is reachable and never clipped. */}
        {settingsOpen && (
          <div className="absolute inset-0 z-40 overflow-y-auto rounded-2xl bg-white p-3">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium text-[#3A3A3A]">AI providers</span>
              <button
                onClick={() => setSettingsOpen(false)}
                className="rounded px-1.5 py-0.5 text-xs text-[#8A8A8A] hover:bg-black/5 hover:text-[#3A3A3A]"
                aria-label="Close settings"
              >
                ✕
              </button>
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-[#9A9A9A]">
              Add any AI provider with an API key. Its model then shows up in the
              switcher and is called directly from your computer (no Verlox
              credits used). Works with OpenAI, OpenRouter, Groq, local models,
              Anthropic, and more.
            </p>

            {/* Existing providers */}
            {hasProviders && (
              <div className="mt-2 space-y-1">
                {settings?.providers.map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center justify-between rounded-lg border border-black/10 px-2 py-1"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-xs font-medium text-[#3A3A3A]">
                        {p.name}
                      </div>
                      <div className="truncate text-[11px] text-[#9A9A9A]">
                        {p.model}
                      </div>
                    </div>
                    <button
                      onClick={() => removeProvider(p.id)}
                      className="shrink-0 text-[11px] text-[#B4632F] hover:underline"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Add a provider */}
            <form onSubmit={submitProvider} className="mt-3 space-y-1.5">
              <div className="text-[11px] font-medium uppercase tracking-wide text-[#9A9A9A]">
                Add a provider
              </div>
              <input
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="Name (e.g. GPT-4o)"
                className="w-full rounded-lg border border-black/10 px-2 py-1 text-xs text-[#3A3A3A] focus:outline-none focus:ring-1 focus:ring-black/20"
              />
              <select
                value={formFormat}
                onChange={(e) => {
                  const f = e.target.value as ProviderFormat;
                  setFormFormat(f);
                  setFormUrl(defaultBaseUrl(f));
                }}
                className="w-full rounded-lg border border-black/10 px-2 py-1 text-xs text-[#3A3A3A] focus:outline-none focus:ring-1 focus:ring-black/20"
              >
                <option value="openai">OpenAI-compatible (most providers)</option>
                <option value="anthropic">Anthropic (Claude)</option>
              </select>
              <input
                value={formUrl}
                onChange={(e) => setFormUrl(e.target.value)}
                placeholder="Endpoint URL"
                className="w-full rounded-lg border border-black/10 px-2 py-1 text-xs text-[#3A3A3A] focus:outline-none focus:ring-1 focus:ring-black/20"
              />
              <input
                value={formModel}
                onChange={(e) => setFormModel(e.target.value)}
                placeholder={modelPlaceholder(formFormat)}
                className="w-full rounded-lg border border-black/10 px-2 py-1 text-xs text-[#3A3A3A] focus:outline-none focus:ring-1 focus:ring-black/20"
              />
              <input
                type="password"
                value={formKey}
                onChange={(e) => setFormKey(e.target.value)}
                placeholder="API key"
                className="w-full rounded-lg border border-black/10 px-2 py-1 text-xs text-[#3A3A3A] focus:outline-none focus:ring-1 focus:ring-black/20"
              />
              <button
                type="submit"
                disabled={addBusy}
                className="w-full rounded-lg bg-[#3A3A3A] px-2.5 py-1 text-xs font-medium text-white hover:bg-black disabled:opacity-50"
              >
                {addBusy ? 'Checking…' : 'Add & verify'}
              </button>
              {addMsg && (
                <div
                  className={`break-words text-[11px] ${
                    addMsg === 'Added.' || addMsg === 'Checking…'
                      ? 'text-[#3E7A53]'
                      : 'text-[#B4632F]'
                  }`}
                >
                  {addMsg}
                </div>
              )}
            </form>

            <button
              onClick={toggleAuto}
              disabled={!settings}
              className="mt-3 flex w-full items-center justify-between rounded-lg px-1 py-1 text-left hover:bg-black/5 disabled:opacity-50"
            >
              <div className="min-w-0 pr-2">
                <div className="text-xs text-[#3A3A3A]">Run read-only steps automatically</div>
                <div className="text-[11px] text-[#9A9A9A]">
                  {settings?.autoApproveReadonly
                    ? 'Listing/reading runs without asking'
                    : 'Ask before every step'}
                </div>
              </div>
              <span
                className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${
                  settings?.autoApproveReadonly ? 'bg-[#3A3A3A]' : 'bg-black/15'
                }`}
              >
                <span
                  className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                    settings?.autoApproveReadonly ? 'translate-x-3.5' : 'translate-x-0.5'
                  }`}
                />
              </span>
            </button>
          </div>
        )}
      </div>

      {/* Conversation area */}
      {expanded && (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {messages.length === 0 && !thinking ? (
            <div className="mx-auto max-w-md py-6 text-center text-sm leading-relaxed text-[#9A9A9A]">
              Tell Verlox what you want to do, in plain English. It works one
              step at a time, asks before changing anything, and saves a
              restore point so you can always undo.
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {messages.map((m) => {
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
                return (
                  <div
                    key={m.id}
                    className="rounded-xl border border-black/10 bg-[#FBFBFA] p-2.5"
                  >
                    <div className="text-[11px] uppercase tracking-wide text-[#9A9A9A]">
                      Proposed command
                    </div>
                    <code className="mt-1 block break-all rounded bg-black/5 px-2 py-1 font-mono text-xs text-[#3A3A3A]">
                      {m.command}
                    </code>
                    {m.reason && (
                      <div className="mt-1.5 text-xs text-[#6A6A6A]">{m.reason}</div>
                    )}
                    <div className="mt-1 text-[11px] text-[#9A9A9A]">
                      {m.readOnly ? 'Reads only, changes nothing.' : 'Makes changes on your computer.'}
                    </div>
                    {m.warn && (
                      <div className="mt-1.5 rounded bg-[#FBF1EA] px-2 py-1 text-[11px] text-[#B4632F]">
                        Heads up: {m.warn}
                      </div>
                    )}

                    {m.status === 'pending' && (
                      <div className="mt-2 flex gap-2">
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
                        <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-[#2A2A28] px-2 py-1.5 font-mono text-[11px] leading-relaxed text-[#E8E8E6]">
                          {m.output}
                        </pre>
                      )}

                    {m.note && (
                      <div className="mt-1.5 text-[11px] text-[#9A9A9A]">{m.note}</div>
                    )}
                  </div>
                );
              })}
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
        <form onSubmit={submit} className="flex items-end gap-2 px-3 py-2">
          {/* Choose working folder */}
          <button
            type="button"
            onClick={chooseFolder}
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
        <div ref={brainWrapRef} className="relative shrink-0">
          {brainMenuOpen && (
            <div className="absolute bottom-[calc(100%+8px)] left-0 z-30 w-60 overflow-hidden rounded-xl border border-black/10 bg-white p-1 shadow-xl">
              {groups.map((group) => (
                <div key={group}>
                  <div className="px-2.5 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wide text-[#B0B0B0]">
                    {group}
                  </div>
                  {brains
                    .filter((b) => b.group === group)
                    .map((b) => {
                      const active = b.id === brainId;
                      return (
                        <button
                          key={b.id}
                          type="button"
                          onClick={() => pickBrain(b)}
                          className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left ${
                            active ? 'bg-black/[0.05]' : 'hover:bg-black/[0.035]'
                          }`}
                        >
                          <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[#3A3A3A]">
                            {active ? '✓' : ''}
                          </span>
                          <span className="truncate text-xs font-medium text-[#3A3A3A]">
                            {b.label}
                          </span>
                        </button>
                      );
                    })}
                </div>
              ))}
              <button
                type="button"
                onClick={() => {
                  setBrainMenuOpen(false);
                  setSettingsOpen(true);
                }}
                className="mt-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[11px] text-[#6A6A6A] hover:bg-black/[0.035]"
              >
                ＋ Add an AI provider…
              </button>
            </div>
          )}
          <button
            type="button"
            onClick={() => setBrainMenuOpen((o) => !o)}
            disabled={running}
            aria-haspopup="listbox"
            aria-expanded={brainMenuOpen}
            title={`Model: ${selectedBrain.label}`}
            className="flex max-w-[120px] items-center gap-1 rounded-lg border border-black/10 px-2 py-1 text-[11px] font-medium text-[#6A6A6A] hover:text-[#3A3A3A] disabled:opacity-40"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="shrink-0">
              <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
            </svg>
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
          className={`min-w-0 flex-1 resize-none self-center bg-transparent py-1 text-sm leading-5 text-[#3A3A3A] placeholder:text-[#9A9A9A] focus:outline-none disabled:opacity-60 ${
            dragging ? 'rounded-lg ring-2 ring-[#3A3A3A]/15' : ''
          }`}
          style={{ maxHeight: '96px' }}
        />
        <button
          type="submit"
          disabled={(!input.trim() && !attachment) || running}
          aria-label="Send"
          className="flex h-8 w-8 shrink-0 items-center justify-center self-end rounded-lg bg-[#3A3A3A] text-white hover:bg-black disabled:opacity-30"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M5 12h13M13 6l6 6-6 6"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        </form>
      </div>
    </div>
  );
}
