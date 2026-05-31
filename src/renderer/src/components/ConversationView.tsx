import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import type { CwdInfo } from '@shared/types';
import { Header } from './Header';
import { Conversation } from './Conversation';
import { Input, type InputHandle } from './Input';
import type { PathSelection } from './PathPicker';
import { useCommands } from '../hooks/useCommands';
import { useUpgrade } from '../contexts/UpgradeContext';

// Empty-state example prompts. Each category carries a short caption
// (Explore / Navigate / Inspect), an icon, and a POOL of prompts that
// rotate on a timer so the dashboard feels alive instead of fixed. The
// user sees a different example on every visit and every few seconds
// while they're staring at it, prompting them with fresh ideas.
interface ExamplePrompt {
  caption: string;
  prompt: string;
  icon: 'folder' | 'compass' | 'pulse';
}

interface CategoryPool {
  caption: string;
  icon: 'folder' | 'compass' | 'pulse';
  prompts: string[];
}

const CATEGORIES: CategoryPool[] = [
  {
    caption: 'Explore',
    icon: 'folder',
    prompts: [
      'List the files in this folder',
      "What's in this folder?",
      'Show me the biggest files here',
      'What changed in this folder this week?',
      'Count the files by type',
      'Find every TODO in this folder',
      'Open the README in this folder',
    ],
  },
  {
    caption: 'Navigate',
    icon: 'compass',
    prompts: [
      'Go to my Documents folder',
      'Take me home',
      'Go up one level',
      'Switch to my Downloads',
      'Open my Desktop',
      'Jump to the last folder I was in',
      'Open the project I worked on last',
    ],
  },
  {
    caption: 'Inspect',
    icon: 'pulse',
    prompts: [
      "Show me what's running on this machine",
      "What's listening on port 3000?",
      'How much disk space is free?',
      'Show me the git status here',
      'What node version do I have?',
      'Show the last 5 git commits',
      'Ping google.com a few times',
    ],
  },
];

// How often the visible prompt in each card rotates. Long enough that a
// user reading one can finish before it swaps, short enough to feel
// alive.
const ROTATION_MS = 5500;

// Max characters for a tab title before it gets an ellipsis.
const TITLE_MAX = 28;

function deriveTitle(firstUserInput: string): string {
  const trimmed = firstUserInput.trim();
  if (trimmed.length <= TITLE_MAX) return trimmed;
  return `${trimmed.slice(0, TITLE_MAX).trimEnd()}…`;
}

interface EmptyStateProps {
  onExampleClick: (prompt: string) => void;
}

function EmptyState({ onExampleClick }: EmptyStateProps) {
  // Random starting offset per card so we don't always open on the same
  // three prompts. Each card then ticks independently from there.
  const [offsets] = useState(() =>
    CATEGORIES.map((c) => Math.floor(Math.random() * c.prompts.length)),
  );
  const [tick, setTick] = useState(0);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    const id = setInterval(() => setTick((t) => t + 1), ROTATION_MS);
    return () => clearInterval(id);
  }, [paused]);

  // The three currently-visible cards, derived from CATEGORIES + tick.
  const examples: ExamplePrompt[] = CATEGORIES.map((cat, i) => ({
    caption: cat.caption,
    icon: cat.icon,
    prompt: cat.prompts[(offsets[i] + tick) % cat.prompts.length],
  }));

  // Ready-state pip — same lit-glass treatment as the Running pane's
  // green dot, sized down for the header strip. Signals "Verlox is
  // live, just waiting on you" without saying anything explicit.
  const pipStyle: React.CSSProperties = {
    background: 'linear-gradient(135deg, #56C988 0%, #1E8048 100%)',
    boxShadow:
      'inset 0 0.5px 0 rgba(255,255,255,0.45), 0 0 6px rgba(40,160,90,0.55)',
  };
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-8">
      <div className="flex w-full max-w-reading flex-col items-center">
        {/* Ready strip — small mono wordmark + pip, uppercase tracked
            "ready" label. Same visual register as the Running pane
            header so the whole app reads as one design system. */}
        <div className="flex items-center gap-2">
          <span
            className="h-1.5 w-1.5 rounded-full animate-flicker"
            style={pipStyle}
            aria-hidden="true"
          />
          <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-label">
            Verlox · ready
          </span>
        </div>

        {/* Headline — tight letter-spacing, larger than before for
            the premium first-impression. Single line at the column
            width we target so it reads as a deliberate statement. */}
        <h1
          className="mt-5 text-center text-[28px] font-semibold leading-tight text-ink"
          style={{ letterSpacing: '-0.03em' }}
        >
          What would you like to do?
        </h1>

        {/* Sub — narrower so the line breaks land naturally, slightly
            softer ink color for visual hierarchy under the headline. */}
        <p className="mt-3 max-w-[440px] text-center text-[14px] leading-relaxed text-ink-hint">
          Type in plain English. Verlox plans the steps, runs them, and tells
          you what happened — turn on Plan Mode to review every plan first.
        </p>

        {/* Examples — three glass-tinted cards in a row at wide
            widths, stacked on narrower. Each carries the small
            uppercase caption (Explore / Navigate / Inspect), the
            example prompt, and a leading icon. Same liquid-glass
            language as the Running pane: tinted frame, white inset,
            top-edge highlight. */}
        <div
          className="mt-10 grid w-full max-w-[820px] grid-cols-1 gap-3 sm:grid-cols-3"
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
        >
          {examples.map((ex, i) => (
            <ExampleCard
              key={CATEGORIES[i].caption}
              example={ex}
              onClick={() => onExampleClick(ex.prompt)}
            />
          ))}
        </div>

        {/* Subtle hint at the bottom — calm one-liner about the path
            picker shortcut. Doesn't compete with the headline; just
            seeds discovery. */}
        <p className="mt-8 text-[11.5px] text-ink-micro">
          Tip: pick a folder or a file from the input bar to focus the
          conversation on it.
        </p>
      </div>
    </div>
  );
}

// One example prompt rendered as a glass-tinted card. Outer frame:
// soft warm-grey gradient with a 1px top highlight. Inner white area
// holds the caption + prompt. Same compositional pattern as the
// Running pane so the whole app feels designed together.
function ExampleCard({
  example,
  onClick,
}: {
  example: ExamplePrompt;
  onClick: () => void;
}) {
  // Hold the prompt we're actually rendering separately from the prop.
  // When the prop changes (rotation tick), fade the current text out, swap
  // the displayed string, then fade back in. The remount/`key` approach
  // hard-cuts the old element before the new one fades in, which reads
  // as a flicker — this two-phase opacity does a real crossfade.
  const FADE_MS = 220;
  const [displayedPrompt, setDisplayedPrompt] = useState(example.prompt);
  const [fading, setFading] = useState(false);
  useEffect(() => {
    if (example.prompt === displayedPrompt) return;
    setFading(true);
    const timer = setTimeout(() => {
      setDisplayedPrompt(example.prompt);
      setFading(false);
    }, FADE_MS);
    return () => clearTimeout(timer);
  }, [example.prompt, displayedPrompt]);

  const frameStyle: React.CSSProperties = {
    background:
      'linear-gradient(180deg, rgba(244,245,248,0.95) 0%, rgba(240,242,246,0.95) 100%)',
    backdropFilter: 'blur(12px) saturate(140%)',
    WebkitBackdropFilter: 'blur(12px) saturate(140%)',
    boxShadow:
      '0 1px 0 rgba(255,255,255,0.7) inset, 0 0 0 0.5px rgba(0,0,0,0.04), 0 6px 18px -10px rgba(20,30,60,0.15)',
  };
  const innerStyle: React.CSSProperties = {
    background: 'linear-gradient(180deg, #FFFFFF 0%, #FDFEFE 100%)',
    boxShadow:
      '0 1px 0 rgba(255,255,255,0.9) inset, 0 1px 2px rgba(16,24,40,0.03)',
  };
  return (
    <button
      type="button"
      onClick={onClick}
      title={example.prompt}
      className="group relative overflow-hidden rounded-2xl border border-subtle-border text-left transition-transform hover:-translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/15"
      style={frameStyle}
    >
      {/* Top-edge highlight — same treatment as Running / Plan Card. */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/85 to-transparent"
        aria-hidden="true"
      />

      {/* Caption strip — uppercase tracked label, sits on the tinted
          frame, no divider. Echoes the Running pane header pattern. */}
      <div className="flex items-center gap-2 px-3.5 pt-3 pb-2">
        <span className="text-ink-micro group-hover:text-ink-label transition-colors">
          <ExampleIcon kind={example.icon} />
        </span>
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-ink-label">
          {example.caption}
        </span>
      </div>

      {/* Inner white card with the prompt — bright surface that reads
          as the action's payload. Hover tightens text to ink. */}
      <div
        className="mx-2 mb-2 rounded-xl border border-subtle-border/70 px-3.5 py-3"
        style={innerStyle}
      >
        {/* Controlled opacity instead of a remount, so there's no
            single-frame gap between the old and new text. The wrapper
            transition handles both the fade-out (fading=true) and the
            fade-in (fading=false) symmetrically. */}
        <p
          className={`text-[13.5px] leading-snug text-ink-body transition-opacity duration-200 group-hover:text-ink ${
            fading ? 'opacity-0' : 'opacity-100'
          }`}
          style={{ transitionDuration: `${FADE_MS}ms` }}
        >
          {displayedPrompt}
        </p>
      </div>
    </button>
  );
}

function ExampleIcon({ kind }: { kind: ExamplePrompt['icon'] }) {
  const common = {
    viewBox: '0 0 16 16',
    className: 'h-3.5 w-3.5',
    fill: 'none' as const,
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  switch (kind) {
    case 'folder':
      // Classic folder — tab on top, body below.
      return (
        <svg {...common}>
          <path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h2.6l1.4 1.5h5A1.5 1.5 0 0 1 14 7v4.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-6z" />
        </svg>
      );
    case 'compass':
      // Compass — circle with a directional needle. Reads as
      // "navigation / go to" cleanly at 14px.
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6" />
          <path d="M10.5 5.5L7.2 7.2 5.5 10.5l3.3-1.7L10.5 5.5z" />
        </svg>
      );
    case 'pulse':
      // Activity pulse — three-step waveform inside a circle.
      // Echoes "what's running / live machine state."
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6" />
          <path d="M4.5 8h1.6L7.3 5.5l1.4 5L9.8 8h1.7" />
        </svg>
      );
  }
}

interface ConversationViewProps {
  conversationId: string;
  // True when this conversation is the active tab. Inactive views stay
  // mounted (hidden via CSS) so running commands and history survive a
  // tab switch — isActive only drives input focus.
  isActive: boolean;
  // Session-wide Plan Mode preference, owned by ConversationsShell.
  // Every ConversationView shares the same value; the per-conversation
  // Header renders the toggle bound to it.
  planMode: boolean;
  onPlanModeChange: (value: boolean) => void;
  // Reports this conversation's tab title up to the shell. Fired once
  // when the first message arrives (the title derives from it).
  onTitleChange: (conversationId: string, title: string) => void;
  // Reports which commands are currently running in this conversation,
  // so the shell can aggregate them into the global running pill. Fired
  // only when the running set actually changes (a command starts/stops),
  // not on every output chunk.
  onRunningChange: (
    conversationId: string,
    running: { stepId: string; command: string }[],
  ) => void;
  // The shell sets this when the user clicks a Timeline entry meant
  // for this conversation. `tick` changes per click so identical
  // text twice in a row still re-triggers the paste. null when this
  // conversation isn't the active paste target.
  insertRequest: { value: string; tick: number } | null;
}

// One conversation: its own working directory, its own message history,
// its own card. Multiple of these are mounted at once (one per tab) —
// only the active one is visible. ConversationsShell owns the list.
export function ConversationView({
  conversationId,
  isActive,
  planMode,
  onPlanModeChange,
  onTitleChange,
  onRunningChange,
  insertRequest,
}: ConversationViewProps) {
  // Per-conversation working directory. null = folderless: commands
  // still run (from the home directory), the header shows "No folder".
  // A successful `cd` turn fills this in via onCwdChange below.
  const [cwd, setCwd] = useState<CwdInfo | null>(null);
  // Absolute path of the file the conversation is locked to, or null.
  // When set, cwd is the file's parent folder and the AI is told the
  // file is the focus. Set via the path picker; cleared by a folder
  // lock or a `cd` turn.
  const [focusedFile, setFocusedFile] = useState<string | null>(null);
  const inputRef = useRef<InputHandle>(null);

  // A `cd` turn locks to a folder, so it also clears any file focus.
  const handleCwdChange = useCallback((next: CwdInfo) => {
    setCwd(next);
    setFocusedFile(null);
  }, []);

  // Path picker result. Folder → lock cwd to it, no file focus. File →
  // lock cwd to the file's parent folder and record the file as focus.
  // window.api.setCwd validates the directory and returns its CwdInfo.
  const handlePickPath = useCallback(async (selection: PathSelection) => {
    try {
      if (selection.isDirectory) {
        const info = await window.api.setCwd(selection.path);
        setCwd(info);
        setFocusedFile(null);
      } else {
        const info = await window.api.setCwd(selection.dir);
        setCwd(info);
        setFocusedFile(selection.path);
      }
    } catch {
      // The directory vanished between listing and selecting — rare.
      // Leave the current lock untouched.
    }
  }, []);

  const { openUpgrade } = useUpgrade();
  // When a turn is rejected for hitting the monthly cap, raise the pro
  // wall (upgrade modal) so the upgrade path is front and centre.
  const handleLimitReached = useCallback(() => {
    openUpgrade({ limitReached: true });
  }, [openUpgrade]);

  const {
    messages,
    forceScrollVersion,
    submitInput,
    stopCommand,
    confirmPlan,
    cancelPlan,
    clearConversation,
  } = useCommands(
    conversationId,
    cwd,
    planMode,
    handleCwdChange,
    focusedFile,
    handleLimitReached,
  );

  // Clear button handler — drops the message list and pulls focus back
  // to the input so the user can immediately start typing again. The
  // hook handles killing running steps + cancelling synthesize streams.
  const handleClear = useCallback(() => {
    clearConversation();
    inputRef.current?.focus();
  }, [clearConversation]);

  // Report the tab title up to the shell. The title is "New conversation"
  // until the first message lands, then a truncation of that message.
  // lastTitleRef seeds to the empty-state title so the mount render
  // doesn't fire a redundant report.
  const lastTitleRef = useRef<string>('New conversation');
  useEffect(() => {
    const title =
      messages.length === 0
        ? 'New conversation'
        : deriveTitle(messages[0].userInput);
    if (title !== lastTitleRef.current) {
      lastTitleRef.current = title;
      onTitleChange(conversationId, title);
    }
  }, [messages, conversationId, onTitleChange]);

  // Report running commands up to the shell for the global running pill.
  // A command is running when a message is 'executing' and one of its
  // steps is 'running'. messages changes on every output chunk, so we
  // dedup by signature — onRunningChange fires only when the set of
  // running commands actually changes (a command started or stopped).
  const lastRunningSigRef = useRef<string>('');
  useEffect(() => {
    const running = messages
      .filter((m) => m.status === 'executing')
      .flatMap((m) => {
        const step = m.steps.find((s) => s.status === 'running');
        return step
          ? [{ stepId: `${m.id}::${step.index}`, command: step.command }]
          : [];
      });
    const sig = running.map((r) => `${r.stepId} ${r.command}`).join('|');
    if (sig === lastRunningSigRef.current) return;
    lastRunningSigRef.current = sig;
    onRunningChange(conversationId, running);
  }, [messages, conversationId, onRunningChange]);

  // Focus the input when this conversation becomes active (tab switch or
  // first mount). Focusing a display:none element is a no-op, but by the
  // time this effect runs the `hidden` class is already gone.
  useEffect(() => {
    if (isActive) inputRef.current?.focus();
  }, [isActive]);

  // Paste-from-Timeline: when the shell sets an insertRequest aimed at
  // this conversation, drop the text into the input and focus it. The
  // tick changes per click so the same prompt twice in a row still
  // re-pastes.
  useEffect(() => {
    if (!insertRequest) return;
    inputRef.current?.setValue(insertRequest.value);
    inputRef.current?.focus();
  }, [insertRequest?.tick, insertRequest?.value]);

  // After a Plan Card resolves, pull focus back to the input so the user
  // can keep typing without clicking into the conversation first.
  const handleConfirmPlan = useCallback(
    (id: string) => {
      confirmPlan(id);
      inputRef.current?.focus();
    },
    [confirmPlan],
  );
  const handleCancelPlan = useCallback(
    (id: string) => {
      cancelPlan(id);
      inputRef.current?.focus();
    },
    [cancelPlan],
  );

  const handleConversationClick = (event: MouseEvent<HTMLDivElement>) => {
    const selection = window.getSelection();
    if (selection && selection.toString().length > 0) return;
    if (event.target instanceof HTMLAnchorElement) return;
    if (event.target instanceof HTMLButtonElement) return;
    inputRef.current?.focus();
  };

  // What the header shows for this conversation's lock:
  //   file lock   → the file's full path (folder trace + filename)
  //   folder lock → the folder's display path
  //   nothing     → null (Header renders "No folder")
  // For a file lock, cwd is the file's parent (display form); the
  // separator is taken from the raw focusedFile so Windows shows '\'
  // and POSIX shows '/'.
  const headerPath = focusedFile
    ? `${cwd?.display ?? ''}${focusedFile.includes('\\') ? '\\' : '/'}${
        focusedFile.split(/[\\/]/).filter(Boolean).pop() ?? focusedFile
      }`
    : (cwd?.display ?? null);

  // A folder or file is locked (file locks always set cwd too).
  const locked = cwd !== null || focusedFile !== null;

  // The AI is actively working when a turn is mid-flight — planning,
  // running steps, or streaming a response — OR has settled but its
  // prose is still being revealed character-by-character. While busy
  // the input locks so the user can't fire a second turn over the top
  // of the one in progress; it unlocks the instant the turn finishes
  // or the user stops it (via the in-flight turn's existing stop
  // control), which snaps reveal to its end / flips status to
  // 'killed' — both clearing the conditions below.
  const isBusy = messages.some(
    (m) =>
      m.status === 'translating' ||
      m.status === 'executing' ||
      m.status === 'synthesizing' ||
      m.status === 'streaming' ||
      ((m.status === 'done' || m.status === 'replied') &&
        m.finalResponse.length < m.pendingResponse.length),
  );

  // No card chrome — the conversation flows directly on the white app
  // surface. Timeline sidebar's right border is the only divider; the
  // conversation area carries no rounded card / shadow of its own.
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Header
        displayPath={headerPath}
        planMode={planMode}
        onPlanModeChange={onPlanModeChange}
        canClear={messages.length > 0}
        onClear={handleClear}
      />
      {messages.length === 0 ? (
        <EmptyState
          onExampleClick={(prompt) => inputRef.current?.setValue(prompt)}
        />
      ) : (
        // Relative wrapper so the top/bottom fades can overlay the
        // scroll area's edges. The fades mask the hard cut-off where
        // content meets the header (top) and the input bar (bottom),
        // so a turn scrolling past either edge dissolves instead of
        // slicing off mid-line.
        <div className="relative flex min-h-0 flex-1 flex-col">
          <Conversation
            messages={messages}
            forceScrollVersion={forceScrollVersion}
            onStop={stopCommand}
            onConfirmPlan={handleConfirmPlan}
            onCancelPlan={handleCancelPlan}
            onBackgroundClick={handleConversationClick}
          />
          <div
            className="pointer-events-none absolute inset-x-0 top-0 z-10 h-8 bg-gradient-to-b from-white to-transparent"
            aria-hidden="true"
          />
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-10 bg-gradient-to-t from-white to-transparent"
            aria-hidden="true"
          />
        </div>
      )}
      <Input
        ref={inputRef}
        onSubmit={(text, image) => {
          void submitInput(text, image);
        }}
        pickerInitialPath={cwd?.absolute ?? null}
        onPickPath={handlePickPath}
        locked={locked}
        busy={isBusy}
      />
    </div>
  );
}
