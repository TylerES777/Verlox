import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { Shell } from '@shared/types';
import { CopyButton } from './CopyButton';
import {
  registerTerminal,
  snapshotTerminals,
  unregisterTerminal,
} from '../lib/terminalRegistry';
import {
  assessCommand,
  permissionFor,
  PERMISSION_CAPABILITIES,
  type CapabilityPermissions,
} from '@shared/risk';
import { useAuth } from '../contexts/AuthContext';
import {
  finalizeProcess,
  registerProcess,
  touchProcess,
} from '../hooks/useRunningProcesses';
import { BlockSurface } from '../lib/blockSurface';
import { buildBrains, type Brain } from '../lib/brains';
import {
  applyCandidate,
  commandCandidates,
  currentToken,
  historyAppend,
  historyLoad,
  historySearch,
  pathCandidates,
  planCompletion,
  type TokenSpan,
} from '../lib/commandBar';
import {
  appendToOpenBlock,
  applyFallbackEvents,
  attachSnapshotToLastClosed,
  closeBlock,
  markOpenBlockInteractive,
  markOpenBlockStopped,
  openBlock,
  isSafetyBanner,
  PromptFallbackParser,
  shortenPath,
  stripChoiceGuide,
  suggestedReplies,
  WAITING_AFTER_MS,
  type TerminalBlockData,
} from '../lib/terminalBlocks';
import type { AgentStepHistory, VaultEntry } from '@shared/types';

// One entry in an AI session's timeline: the AI (or user) speaking, or the
// AI proposing a command for approval. Rendered interleaved with terminal
// blocks by timestamp.
interface AiItem {
  id: string;
  at: number;
  from: 'ai' | 'user';
  kind: 'message' | 'proposal';
  text: string;
  command?: string | null;
  risk?: string | null;
  status?: 'pending' | 'accepted' | 'skipped';
  // Filled in once the command this proposal started has finished, so the
  // card can show what the AI actually got back without hunting for the
  // block it produced.
  output?: string;
  exitCode?: number | null;
  // Which model said this, captured when it was said. Rendering from the
  // CURRENT model instead rewrote history on every swap — old answers
  // suddenly wore the new model's face, hiding that a switch happened.
  brandLabel?: string;
  brandProvider?: string;
  // The command this exchange was called about, stamped when it was
  // said so older transcripts keep their own context after the session
  // ends or a new one starts.
  ctx?: string;
  // Plan-first: the whole plan proposed for ONE approval. Steps carry
  // their own status as the plan executes.
  plan?: {
    summary: string;
    estimate: string;
    steps: {
      command: string;
      reason: string;
      status: 'pending' | 'running' | 'ran' | 'failed' | 'skipped' | 'blocked';
      blockedLabel?: string;
      output?: string;
      exitCode?: number | null;
      // Current-vs-proposed contents when this step writes a known file.
      path?: string;
      preview?: string;
      before?: string;
      beforeExists?: boolean;
    }[];
    state: 'awaiting' | 'running' | 'done' | 'cancelled';
  };
}

// What's on the user's terminal screens right now, capped so token cost
// stays sane. Mirrors the AI terminal's context collection.
const AI_TERMINAL_CONTEXT_CAP = 12000;
function collectAiTerminalContext(currentId: string): string {
  const snaps = snapshotTerminals(currentId).filter((s) => s.text);
  if (snaps.length === 0) return '';
  return snaps
    .map((s, i) => {
      const label = s.current ? `Terminal ${i + 1} (the one in front)` : `Terminal ${i + 1}`;
      return `[${label}]\n${s.text.slice(-4000)}`;
    })
    .join('\n\n')
    .slice(-AI_TERMINAL_CONTEXT_CAP);
}

// Mark the open block as AI-run (an accepted proposal's command).
function tagLastOpenAsAi(prev: TerminalBlockData[]): TerminalBlockData[] {
  const last = prev[prev.length - 1];
  if (!last || last.endedAt !== null || last.byAi) return prev;
  return prev.slice(0, -1).concat({ ...last, byAi: true });
}
import { PathPicker, type PathSelection } from './PathPicker';
import iconAnthropic from '../assets/providers/anthropic.png';
import iconOpenAI from '../assets/providers/openai.png';
import iconGoogle from '../assets/providers/google.png';
import iconMeta from '../assets/providers/meta.png';
import iconGrok from '../assets/providers/grok.png';
import iconDeepSeek from '../assets/providers/deepseek.png';
import iconQwen from '../assets/providers/qwen.png';

const BRAIN_PROVIDER_PNGS: Record<string, string> = {
  anthropic: iconAnthropic,
  openai: iconOpenAI,
  google: iconGoogle,
  meta: iconMeta,
  xai: iconGrok,
  deepseek: iconDeepSeek,
  qwen: iconQwen,
};

// Raw shows the live xterm surface; Blocks slices the same stream into
// Warp-style command/output cards. Persisted globally — if you prefer
// blocks, you prefer them in every tab and every session.
type OutputMode = 'raw' | 'blocks';
const OUTPUT_MODE_KEY = 'verlox-output-mode';

// Blocks is the default: it's the surface that carries the summaries, Fix
// this, Explain, and the vault links — the reason to pick Verlox over any
// other terminal. Landing in Raw made a new user's first impression
// identical to every other terminal. Raw stays one click away for
// interactive programs (vim, REPLs, other AI CLIs) and full-fidelity
// scrollback, and the choice persists once made.
function loadOutputMode(): OutputMode {
  try {
    return localStorage.getItem(OUTPUT_MODE_KEY) === 'raw' ? 'raw' : 'blocks';
  } catch {
    return 'blocks';
  }
}

interface TerminalViewProps {
  // The owning tab's id. Doubles as the PTY session key, so input, output,
  // resize and teardown all route to the right shell when several
  // terminal tabs are open at once.
  id: string;
  // Whether this tab is the visible one. A hidden tab measures as 0×0, so
  // we defer the first fit (and re-fit on show) until it's actually on
  // screen — otherwise the PTY would be sized to nothing.
  isActive: boolean;
  // Called once with the first command the user runs, so the tab can be
  // renamed from "Terminal" to that command.
  onFirstCommand?: (command: string) => void;
}

// In dev, React StrictMode mounts → unmounts → remounts each component in
// the same tick to surface side-effect bugs. A naive cleanup would kill the
// freshly-spawned shell on that throwaway unmount, and the remount a moment
// later would be left typing into a dead shell. So we don't kill on unmount
// immediately: we SCHEDULE the kill and let a remount (which arrives within
// microseconds) cancel it. A real tab close has no remount, so the scheduled
// kill still fires and the shell is torn down. Keyed by tab id so several
// terminals never cross wires. No-op effect in production (no double-mount).
const pendingKills = new Map<string, ReturnType<typeof setTimeout>>();

// A live interactive terminal tab. Renders an xterm.js surface and relays
// raw bytes to/from a node-pty process in the main process (see
// pty-manager.ts). Unlike the plan-execution flow, there's no AI in the
// loop here: the user types straight into a real shell, so interactive
// CLIs (Claude Code, vim, REPLs) work exactly as they would in any
// terminal. The approve-before-run layer sits on top of this, not inside it.
// Rewind / restore points now live in the sidebar, not over the terminal.
export function TerminalView({ id, isActive, onFirstCommand }: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // Becomes true once the PTY has been spawned, so a deferred first fit
  // (for a tab that mounts while hidden) knows whether to start it.
  const startedRef = useRef(false);
  // Title the tab from the first command run; ref so the once-only check and
  // latest callback survive across renders without re-running the mount effect.
  const titledRef = useRef(false);
  const onFirstCommandRef = useRef(onFirstCommand);
  onFirstCommandRef.current = onFirstCommand;
  // For surfacing long-running commands the user types directly (not just
  // agent-run ones) in the sidebar's Running section.
  const envShellRef = useRef<Shell>('powershell');
  const envHomeRef = useRef('');
  const termRunRef = useRef<{
    runId: string;
    timer: ReturnType<typeof setTimeout> | null;
    registered: boolean;
  } | null>(null);
  // Last cwd parsed from the prompt, so we only emit on an actual change.
  const lastCwdRef = useRef('');
  // Custom scrollbar that floats at the card's right edge (xterm's native one
  // is hidden via CSS, since it would sit at the narrow text-column edge). The
  // thumb's size/position mirror the terminal's scroll; dragging it scrolls.
  const scrollbarTrackRef = useRef<HTMLDivElement | null>(null);
  const lastSbRef = useRef('');
  const [sb, setSb] = useState<{ visible: boolean; topPct: number; heightPct: number }>({
    visible: false,
    topPct: 0,
    heightPct: 0,
  });

  // Raw vs Blocks output. Blocks accrue from terminal mount regardless of
  // the visible mode, so toggling later shows the history since open (shell
  // integration can't reconstruct scrollback it never saw).
  const [mode, setMode] = useState<OutputMode>(loadOutputMode);
  const [blocks, setBlocks] = useState<TerminalBlockData[]>([]);
  // Where the shell currently is, read off the prompt. Shown as a chip on
  // the folder browser so the command bar always says where you are.
  const [cwd, setCwd] = useState('');
  // True while a full-screen program owns the terminal (alternate screen
  // buffer). Blocks steps aside for it and comes back when it exits.
  const [altScreen, setAltScreen] = useState(false);
  // Mirror of altScreen for the PTY data listener, which is registered once
  // and would otherwise close over a stale value.
  const altScreenRef = useRef(false);

  // Surface a command the user runs in the Running board — but only if it's
  // still going after a beat, so quick commands (ls, cd) never flash in.
  // Defined at component scope (not inside the xterm effect) because BOTH
  // entry paths need it: keystrokes typed into the raw terminal, and
  // commands sent from the Blocks command bar, which never touch xterm.
  const beginTermRunRef = useRef((command: string) => {
    if (termRunRef.current?.timer) clearTimeout(termRunRef.current.timer);
    const runId = `term-${id}-${crypto.randomUUID()}`;
    const entry = {
      runId,
      timer: null as ReturnType<typeof setTimeout> | null,
      registered: false,
    };
    termRunRef.current = entry;
    entry.timer = setTimeout(() => {
      if (termRunRef.current === entry && !entry.registered) {
        entry.registered = true;
        registerProcess({
          stepId: runId,
          conversationId: id,
          command,
          cwd: lastCwdRef.current || envHomeRef.current,
          shell: envShellRef.current,
          source: 'terminal',
        });
      }
    }, 1500);
  });

  // Any output at all counts as the process still working, which is what
  // separates a busy row from one parked at a prompt.
  const touchTermRunRef = useRef(() => {
    const entry = termRunRef.current;
    if (entry?.registered) touchProcess(entry.runId);
  });

  // The command finished: drop it from the Running board. Called from the
  // shell-integration close event, which is definitive and shell-agnostic
  // (the raw path also has a prompt-watching fallback, see checkTermDone).
  const endTermRunRef = useRef((exitCode: number | null) => {
    const entry = termRunRef.current;
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.registered) finalizeProcess(entry.runId, { exitCode, signal: null });
    termRunRef.current = null;
  });

  // The live surface that renders the RUNNING command's bytes exactly —
  // colors, in-place menus, progress bars — inside its card, and freezes
  // to a styled snapshot when the command ends. One instance serves
  // whichever block is running; the text pipeline (blocks state) keeps
  // running unchanged underneath for summaries, chips and waiting logic.
  const surfaceRef = useRef<BlockSurface | null>(null);
  const getSurface = () => {
    if (!surfaceRef.current) {
      surfaceRef.current = new BlockSurface((data) =>
        window.api.ptyInput({ id, data }),
      );
    }
    return surfaceRef.current;
  };
  useEffect(
    () => () => {
      surfaceRef.current?.dispose();
      surfaceRef.current = null;
    },
    [],
  );
  // Stable identity: React calls a ref callback on every render if its
  // identity changes, which would bounce the live element between parents.
  const surfaceMount = useRef((node: HTMLDivElement | null) => {
    getSurface().mountInto(node);
  }).current;
  const surfaceFocus = useRef(() => {
    surfaceRef.current?.focus();
  }).current;

  // --- AI in the room -------------------------------------------------------
  // "Fix this" (and follow-up messages) run a real agent session INSIDE the
  // block timeline: the AI speaks in its own message cards, proposes
  // commands as approval cards, and accepted commands run in THIS terminal
  // — the resulting block wears the model icon and its real exit code +
  // output feed the next step. No side chat: the terminal is the room.
  const [aiItems, setAiItems] = useState<AiItem[]>([]);
  const [aiActive, setAiActive] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiDone, setAiDone] = useState(false);
  // The command the current session was called about. Held in a ref and
  // stamped onto each message as it's pushed, so every exchange in the
  // timeline keeps the context it was actually about.
  const aiContextRef = useRef('');
  // Same value, in state, so the bar can show what this session is
  // about before the first message exists to carry it.
  const [aiContext, setAiContext] = useState('');
  const aiGoalRef = useRef('');
  // The conversation itself. The planner API takes a single `goal` string,
  // so follow-ups used to be concatenated onto it — which made the model
  // treat one swollen task as the request and start auditing what was
  // asked when ("you already asked that in Turn 1"). Keeping the exchange
  // as turns and rendering it as a transcript restores normal chat sense.
  const aiChatRef = useRef<{ role: 'user' | 'assistant'; text: string }[]>([]);
  const aiHistoryRef = useRef<AgentStepHistory[]>([]);
  // Set while an accepted AI command is running; the block watcher below
  // resolves it with the block's real result.
  const aiAwaitRef = useRef<{ command: string; since: number } | null>(null);
  const nextBlockByAiRef = useRef(false);
  const aiAutoReadOnlyRef = useRef(false);
  // The user's per-capability rules (always / ask / never) from Settings.
  // A capability set to "never" must be refused here, not just in the AI
  // terminal — a rule that only applies in one surface isn't a rule.
  const aiPermsRef = useRef<CapabilityPermissions | undefined>(undefined);
  // The last command actually proposed, so a model stuck in a loop can't
  // re-offer it forever.
  const aiLastCommandRef = useRef<string | null>(null);
  // Command -> the id of the restore point representing the folder state
  // just BEFORE it ran. Captured at the time, because a checkpoint is a
  // calm no-op when nothing has changed since the last one (ok, but
  // created: false) — so searching for a point by label afterwards finds
  // nothing and undo appears broken. Whatever the newest point is at that
  // moment IS "before this command", created fresh or not.
  const [aiRestorePoints, setAiRestorePoints] = useState<Record<string, string>>({});
  // An attached image rides along with the NEXT step only (the backend and
  // provider calls accept it on the first turn of a goal).
  const aiImageRef = useRef<{ mediaType: string; base64Data: string } | null>(null);

  const pushAi = (item: Omit<AiItem, 'id' | 'at'>) => {
    // Stamp WHO is speaking at the moment of speaking, so a later model
    // swap can't repaint the past.
    const brain = readBrain();
    setAiItems((prev) => [
      ...prev,
      {
        ...item,
        id: `${Date.now()}-${prev.length}`,
        at: Date.now(),
        brandLabel: item.brandLabel ?? brain.label,
        brandProvider: item.brandProvider ?? brain.provider,
        ctx: item.ctx ?? aiContextRef.current,
      },
    ]);
  };

  // Same safety net the AI terminal runs before an agent command: deletes
  // are copied into the Recovery Vault first, and every changing command
  // gets a restore point. Both best-effort — a failed capture must never
  // block the command, since the Recycle Bin override is still underneath.
  const runAiCommand = async (command: string) => {
    const assessment = assessCommand(command);
    if (assessment.capability === 'delete' && assessment.files.length > 0) {
      try {
        await window.api.vaultCapture({
          command,
          cwd: cwd || lastCwdRef.current || envHomeRef.current,
          paths: assessment.files,
          retention: 'day',
        });
        window.dispatchEvent(new Event('verlox:vault-changed'));
      } catch {
        // Vault unavailable; the Recycle Bin still catches the delete.
      }
    }
    if (assessment.capability !== 'read') {
      try {
        // Adopt this folder as the guarded one FIRST. Auto-protection was
        // only wired to the agent-terminal's command path, so a Blocks
        // session never had a guarded folder and every checkpoint failed —
        // which is why "Undo this" had nothing to offer.
        const here = cwd || lastCwdRef.current || envHomeRef.current;
        if (here) await window.api.snapshotEnsureProtected(here);
        const res = await window.api.snapshotCheckpoint(`Before: ${command}`);
        if (res.ok) {
          // Whatever the newest point is now — the one just written, or
          // the existing one when nothing had changed — is the state to
          // come back to. Remember its id so undo never has to guess.
          const list = await window.api.snapshotList();
          if (list.length > 0) {
            const id = list[0].id;
            setAiRestorePoints((prev) => ({ ...prev, [command]: id }));
          }
        }
      } catch {
        // No guarded folder / git unavailable — undo simply isn't offered.
      }
    }
    aiAwaitRef.current = { command, since: Date.now() };
    aiLastCommandRef.current = command;
    nextBlockByAiRef.current = true;
    window.api.ptyRunCommand({ id, command, cwd: cwd || undefined });
  };

  // One step in flight at a time. A second message while the AI is
  // thinking queues a follow-up instead of racing a parallel call (which
  // produced two answers to one question).
  const aiStepRunningRef = useRef(false);
  const aiStepQueuedRef = useRef(false);
  // How many times this turn has been asked to try again after replying
  // with neither a command nor a completion. Reset on every real answer.
  const aiNudgedRef = useRef(0);

  // What gets sent as the planner's `goal`: the standing task (if the
  // session was seeded by Fix this / Ask AI), the conversation so far as a
  // transcript, and how to behave in a terminal that has no side panels.
  const buildAiGoal = (): string => {
    const chat = aiChatRef.current
      .map((m) => `${m.role === 'user' ? 'User' : 'You'}: ${m.text}`)
      .join('\n');
    const latest = [...aiChatRef.current].reverse().find((m) => m.role === 'user');
    return (
      (aiGoalRef.current ? `${aiGoalRef.current}\n\n` : '') +
      (chat ? `Conversation so far (most recent last):\n${chat}\n\n` : '') +
      (latest ? `Respond to the user's latest message: "${latest.text}"\n\n` : '') +
      `(You are talking with the user inside a terminal. This client has no file browser or ` +
      `output panel — running a shell command is the only way to show them anything, so when the ` +
      `answer has to come from the system, propose the command.\n` +
      `Talk like a helpful assistant in a conversation, never like documentation. After a command ` +
      `runs, read its output and answer the actual question in one short, friendly reply — ` +
      `"There are two files here: notes.txt and report.txt. Anything else you want to look at?" — ` +
      `instead of describing what the command does or narrating your plan.\n` +
      `If they decline or say they're done, just acknowledge it warmly in one line and offer to ` +
      `help whenever they need it. Never recap what they asked earlier, never number the turns, ` +
      `and never tell them the output is already on their screen.)`
    );
  };

  // --- Plan-first ---------------------------------------------------------
  // Instead of one step at a time, lay out the WHOLE plan for a single
  // approval. Same safety path on execution: permission rules, the local
  // risk veto, Vault capture and restore points all still apply per step.
  const [aiPlanMode, setAiPlanMode] = useState(false);
  const aiPlanRunningRef = useRef(false);

  const updatePlan = (
    itemId: string,
    fn: (p: NonNullable<AiItem['plan']>) => NonNullable<AiItem['plan']>,
  ) => {
    setAiItems((prev) =>
      prev.map((i) => (i.id === itemId && i.plan ? { ...i, plan: fn(i.plan) } : i)),
    );
  };

  const aiPlanAll = async () => {
    setAiBusy(true);
    const brain = readBrain();
    try {
      const env = await window.api.getEnvironment();
      const res = await window.api.agentPlanAll({
        goal: buildAiGoal(),
        priorSteps: aiHistoryRef.current,
        cwd: cwd || env.homeDir,
        platform: env.platform,
        shell: env.shell,
        engine: brain.engine as never,
        model: brain.model,
        providerId: brain.providerId || undefined,
        image: aiImageRef.current,
        terminalContext: collectAiTerminalContext(id),
      });
      aiImageRef.current = null;
      if (!res.ok) {
        pushAi({
          from: 'ai',
          kind: 'message',
          text:
            res.code === 'limit_reached'
              ? `You're out of credits for ${brain.label}. Switch to a free model with the picker, or upgrade to Pro.`
              : `That didn't go through: ${res.error}`,
        });
        setAiDone(true);
        return;
      }
      const plan = res.plan;
      // A pure question (or already-done goal) has no steps — that's just
      // an answer, so render it like any other reply.
      if (plan.done || plan.steps.length === 0) {
        pushAi({
          from: 'ai',
          kind: 'message',
          text: plan.summary || plan.message || 'Nothing to do.',
        });
        aiChatRef.current = [
          ...aiChatRef.current,
          { role: 'assistant', text: plan.summary || plan.message },
        ];
        setAiDone(true);
        return;
      }
      const steps = plan.steps.map((s) => {
        const cap = assessCommand(s.command).capability;
        const blocked = permissionFor(aiPermsRef.current, cap) === 'never';
        return {
          command: s.command,
          reason: s.reason,
          status: (blocked ? 'blocked' : 'pending') as 'blocked' | 'pending',
          blockedLabel: blocked
            ? (PERMISSION_CAPABILITIES.find((c) => c.capability === cap)?.label ?? cap)
            : undefined,
          path: s.path,
          preview: s.preview,
        };
      });
      // For steps that write a known file, fetch what's there NOW so the
      // card can show current-vs-proposed before anything is approved.
      const withBefore = await Promise.all(
        steps.map(async (s) => {
          if (!s.path || s.preview === undefined) return s;
          try {
            const cur = await window.api.previewFile(s.path, cwd || env.homeDir);
            return { ...s, before: cur.content, beforeExists: cur.exists };
          } catch {
            return s;
          }
        }),
      );
      pushAi({
        from: 'ai',
        kind: 'proposal',
        text: plan.message || '',
        plan: {
          summary: plan.summary,
          estimate: plan.estimate,
          steps: withBefore,
          state: 'awaiting',
        },
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      pushAi({ from: 'ai', kind: 'message', text: `I couldn't reach ${brain.label}: ${detail}` });
      setAiDone(true);
    } finally {
      setAiBusy(false);
    }
  };

  // Run an approved plan start to finish. Each step waits for its block to
  // close before the next begins, so output and exit codes are real.
  const runAiPlan = async (itemId: string) => {
    if (aiPlanRunningRef.current) return;
    const item = aiItems.find((i) => i.id === itemId);
    if (!item?.plan) return;
    aiPlanRunningRef.current = true;
    updatePlan(itemId, (p) => ({ ...p, state: 'running' }));
    const steps = item.plan.steps;
    const results: AgentStepHistory[] = [];
    for (let i = 0; i < steps.length; i++) {
      if (steps[i].status === 'blocked') continue;
      updatePlan(itemId, (p) => ({
        ...p,
        steps: p.steps.map((s, k) => (k === i ? { ...s, status: 'running' } : s)),
      }));
      const done = await runAiCommandAwait(steps[i].command);
      const failed = done.exitCode !== null && done.exitCode !== 0;
      updatePlan(itemId, (p) => ({
        ...p,
        steps: p.steps.map((s, k) =>
          k === i
            ? { ...s, status: failed ? 'failed' : 'ran', output: done.output, exitCode: done.exitCode }
            : s,
        ),
      }));
      results.push({
        command: steps[i].command,
        exitCode: done.exitCode,
        output: done.output,
      });
      // A failed step stops the plan: later steps usually assume it worked.
      if (failed) {
        updatePlan(itemId, (p) => ({
          ...p,
          steps: p.steps.map((s, k) =>
            k > i && s.status === 'pending' ? { ...s, status: 'skipped' } : s,
          ),
        }));
        break;
      }
    }
    updatePlan(itemId, (p) => ({ ...p, state: 'done' }));
    aiHistoryRef.current = [...aiHistoryRef.current, ...results];
    aiPlanRunningRef.current = false;
    // Let the model report on what happened, in its own words.
    void aiStep();
  };

  // The actual turn. Recursive (the nudge path calls it again), so the
  // in-flight guard lives in aiStep below rather than here.
  const aiStepInner = async () => {
    const brain = readBrain();
    try {
      const env = await window.api.getEnvironment();
      const res = await window.api.agentPlanStep({
        // The planner suppresses commands for intents it expects a client
        // PANEL to answer — a plain folder listing being the big one. This
        // client has no panels: a command block is the only way anything
        // reaches the user, so say so or those turns come back empty.
        goal: buildAiGoal(),
        priorSteps: aiHistoryRef.current,
        cwd: cwd || env.homeDir,
        platform: env.platform,
        shell: env.shell,
        engine: brain.engine as never,
        model: brain.model,
        providerId: brain.providerId || undefined,
        image: aiImageRef.current,
        // What's on screen right now, across tabs — the same context the AI
        // terminal sends, so the agent in the room isn't blind to the room.
        terminalContext: collectAiTerminalContext(id),
      });
      aiImageRef.current = null;
      if (!res.ok) {
        // Billing limits deserve the real reason and a way forward, not a
        // raw error string.
        const text =
          res.code === 'limit_reached'
            ? `You're out of credits for ${brain.label}. Switch to a free model with the picker, or upgrade to Pro.`
            : res.code === 'feature_capped'
              ? `${brain.label} isn't included on your plan. Pick a free model, or upgrade to Pro.`
              : `That didn't go through: ${res.error}`;
        pushAi({ from: 'ai', kind: 'message', text });
        return;
      }
      const step = res.step;
      // A turn that only TALKS ("I'll show you what's in the folder") with
      // no command and no done flag is an unfinished thought, not an
      // answer. Nudge once through the normal history channel rather than
      // printing the promise and stalling — smaller models do this often.
      if (!step.command && !step.done && aiNudgedRef.current < 1) {
        aiNudgedRef.current += 1;
        aiHistoryRef.current = [
          ...aiHistoryRef.current,
          {
            command: '(nothing proposed)',
            exitCode: null,
            output:
              'You replied without a command and without finishing. Answer again with the exact command to run next, or say the goal is complete.',
          },
        ];
        await aiStepInner();
        return;
      }
      aiNudgedRef.current = 0;
      // ONE reply per exchange. A turn that proposes a command says its
      // piece through the proposal (command + reason); narrating it first
      // and then answering afterwards read as two AIs talking. The message
      // is kept only when it IS the answer.
      if (step.message && !step.command) {
        pushAi({ from: 'ai', kind: 'message', text: step.message });
        aiChatRef.current = [
          ...aiChatRef.current,
          { role: 'assistant', text: step.message },
        ];
      }
      // Still nothing after the nudge: end the turn honestly rather than
      // sitting there looking alive forever.
      if (step.done || !step.command) setAiDone(true);
      if (step.command && !step.done) {
        const localCap = assessCommand(step.command).capability;

        // A capability the user set to "never" is refused outright — the
        // proposal is never even offered, and the model is told why so it
        // can find another route instead of asking again.
        if (permissionFor(aiPermsRef.current, localCap) === 'never') {
          const label =
            PERMISSION_CAPABILITIES.find((c) => c.capability === localCap)?.label ?? localCap;
          pushAi({
            from: 'ai',
            kind: 'message',
            text: `I can't run \`${step.command}\` — your settings never allow "${label}". Change that in Settings, or tell me another way to get there.`,
          });
          aiHistoryRef.current = [
            ...aiHistoryRef.current,
            {
              command: step.command,
              exitCode: null,
              output: `Refused by the user's permission rules: "${label}" is set to never. Do not propose this or any similar command; find another approach or stop.`,
            },
          ];
          setAiDone(true);
          return;
        }

        // A model re-proposing a command it ALREADY RAN is stuck in a
        // loop, not working. Keyed on what actually ran (not merely what
        // was offered) so declining a command and then asking for it
        // deliberately still works.
        if (step.command === aiLastCommandRef.current) {
          pushAi({
            from: 'ai',
            kind: 'message',
            text: `That would run \`${step.command}\` again, which I just did, so I stopped. Tell me how you'd like to continue.`,
          });
          setAiDone(true);
          return;
        }

        // Auto-run needs BOTH the model's word and our own reading of the
        // command. The model called `New-Item ... -Name a.txt` read-only,
        // which would have created files with no approval — its
        // self-assessment can be wrong or sloppy, so the local risk engine
        // gets a veto. Anything that isn't plainly a read waits for you.
        const trulyRead = localCap === 'read' || localCap === 'inspect';
        const auto =
          step.readOnly && trulyRead && !step.risk && aiAutoReadOnlyRef.current;
        pushAi({
          from: 'ai',
          kind: 'proposal',
          text: step.reason,
          command: step.command,
          risk: step.risk,
          status: auto ? 'accepted' : 'pending',
        });
        if (auto) void runAiCommand(step.command);
      }
    } catch (err) {
      // A thrown call (offline, model not ready, IPC failure) must SAY so.
      // Swallowing it left the session sitting there looking alive.
      const detail = err instanceof Error ? err.message : String(err);
      pushAi({
        from: 'ai',
        kind: 'message',
        text: `I couldn't reach ${brain.label}: ${detail}`,
      });
      setAiDone(true);
    }
  };

  // One turn in flight at a time. A message sent while the AI is thinking
  // queues a follow-up instead of racing a parallel call.
  const aiStep = async () => {
    if (aiStepRunningRef.current) {
      aiStepQueuedRef.current = true;
      return;
    }
    aiStepRunningRef.current = true;
    setAiBusy(true);
    try {
      await aiStepInner();
    } finally {
      aiStepRunningRef.current = false;
      setAiBusy(false);
      if (aiStepQueuedRef.current) {
        aiStepQueuedRef.current = false;
        void aiStep();
      }
    }
  };

  const onAiFix = (block: TerminalBlockData) => {
    aiGoalRef.current =
      `The user's terminal command failed and asked you to fix it. Diagnose from the output, then run what's needed to make it work, one step at a time.\n\n` +
      `Command: ${block.command}\nExit code: ${block.exitCode ?? 'unknown'}\nOutput:\n${block.lines.slice(-60).join('\n').slice(-2500)}`;
    // A new conversation resets what the MODEL remembers, but the visible
    // transcript is history and stays put — the same way earlier command
    // blocks stay when you run a new command.
    aiHistoryRef.current = [];
    aiChatRef.current = [];
    aiLastCommandRef.current = null;
    setAiDone(false);
    aiContextRef.current = block.command;
    setAiContext(block.command);
    setAiActive(true);
    pushAi({ from: 'user', kind: 'message', text: `Fix this: ${block.command}` });
    void window.api
      .settingsGet()
      .then((s) => {
        aiAutoReadOnlyRef.current = !!s.autoApproveReadonly;
        aiPermsRef.current = s.permissions;
      })
      .catch(() => {})
      .finally(() => void aiStep());
  };

  // "Call AI" on any card: the AI enters the room with its attention on
  // that block, and waits. No model call happens until the user actually
  // asks something — calling someone over isn't the same as making them
  // guess why.
  const onAiCall = (block: TerminalBlockData) => {
    aiGoalRef.current =
      `The user called you into their terminal about this command. Help with whatever they ask next; propose commands when action is needed.\n\n` +
      `Command: ${block.command}\nExit code: ${block.exitCode ?? 'unknown'}\nOutput:\n${block.lines.slice(-60).join('\n').slice(-2500)}`;
    // A new conversation resets what the MODEL remembers, but the visible
    // transcript is history and stays put — the same way earlier command
    // blocks stay when you run a new command.
    aiHistoryRef.current = [];
    aiChatRef.current = [];
    aiLastCommandRef.current = null;
    setAiDone(false);
    aiContextRef.current = block.command;
    setAiContext(block.command);
    setAiActive(true);
    void window.api
      .settingsGet()
      .then((s) => {
        aiAutoReadOnlyRef.current = !!s.autoApproveReadonly;
        aiPermsRef.current = s.permissions;
      })
      .catch(() => {});
  };

  // "Call AI" from the bar: the room opens with no block in particular —
  // the user picks the model first, then says what they want.
  const onAiStart = () => {
    aiGoalRef.current = '';
    // A new conversation resets what the MODEL remembers, but the visible
    // transcript is history and stays put — the same way earlier command
    // blocks stay when you run a new command.
    aiHistoryRef.current = [];
    aiChatRef.current = [];
    aiLastCommandRef.current = null;
    setAiDone(false);
    aiContextRef.current = '';
    setAiContext('');
    setAiActive(true);
    void window.api
      .settingsGet()
      .then((s) => {
        aiAutoReadOnlyRef.current = !!s.autoApproveReadonly;
        aiPermsRef.current = s.permissions;
      })
      .catch(() => {});
  };

  const onAiSend = (
    text: string,
    image?: { mediaType: string; base64Data: string } | null,
  ) => {
    aiChatRef.current = [...aiChatRef.current, { role: 'user', text }];
    // A fresh instruction clears the loop guard: asking for something
    // again on purpose is not the model repeating itself.
    aiLastCommandRef.current = null;
    if (image) aiImageRef.current = image;
    aiNudgedRef.current = 0;
    setAiDone(false);
    pushAi({
      from: 'user',
      kind: 'message',
      text: image ? `${text}\n(image attached)` : text,
    });
    void (aiPlanMode ? aiPlanAll() : aiStep());
  };

  const onAiProposal = (itemId: string, run: boolean) => {
    const item = aiItems.find((i) => i.id === itemId);
    if (!item || item.kind !== 'proposal' || item.status !== 'pending') return;
    setAiItems((prev) =>
      prev.map((i) =>
        i.id === itemId ? { ...i, status: run ? 'accepted' : 'skipped' } : i,
      ),
    );
    if (run && item.command) {
      void runAiCommand(item.command);
      return;
    }
    if (item.command) {
      // Skip means "no", not "try again". Asking the model for another step
      // right here made it re-propose the same command forever, so the
      // decline is recorded and the turn ends — the user says what's next.
      aiHistoryRef.current = [
        ...aiHistoryRef.current,
        {
          command: item.command,
          exitCode: null,
          output: 'The user declined to run this command and does not want it re-proposed.',
        },
      ];
      aiChatRef.current = [
        ...aiChatRef.current,
        { role: 'assistant', text: `(You offered to run \`${item.command}\`; the user declined.)` },
      ];
      setAiDone(true);
    }
  };

  // Rewind the guarded folder to the point captured just before a command
  // the AI ran. Resolves with what was put back, so the confirmation can
  // name it rather than saying "done".
  const onAiUndo = async (
    command: string,
  ): Promise<{ ok: boolean; message: string }> => {
    const id = aiRestorePoints[command];
    if (!id) {
      return {
        ok: false,
        message: 'There is no restore point for this command, so nothing was changed.',
      };
    }
    try {
      const res = await window.api.snapshotRestore(id);
      if (!res.ok) {
        return { ok: false, message: res.error ?? "That restore didn't go through." };
      }
      window.dispatchEvent(new Event('verlox:vault-changed'));
      // Name the files the command touched — "config.txt restored" beats
      // "done", and this is the moment the user most needs to be sure.
      const files = assessCommand(command).files.filter(Boolean);
      const what =
        files.length === 1
          ? `${files[0]} restored`
          : files.length > 1
            ? `${files.length} files restored`
            : 'Folder restored';
      return {
        ok: true,
        message: `${what} to how it was before this command ran.`,
      };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  };

  // Drop the block reference without leaving AI mode.
  const onAiClearContext = () => {
    aiContextRef.current = '';
    setAiContext('');
  };

  const onAiEnd = () => {
    // Leaving AI mode hands the bar back to the shell. It does NOT erase
    // what was said — those exchanges are part of this terminal's history.
    setAiActive(false);
    setAiDone(false);
    aiContextRef.current = '';
    setAiContext('');
    aiAwaitRef.current = null;
  };

  // One line for the session card's header: what the AI is doing right now.
  const aiPhase: 'thinking' | 'approval' | 'running' | 'done' | 'idle' = aiBusy
    ? 'thinking'
    : aiAwaitRef.current
      ? 'running'
      : aiItems.some((i) => i.kind === 'proposal' && i.status === 'pending')
        ? 'approval'
        : aiDone
          ? 'done'
          : 'idle';

  // Plan execution awaits each command rather than being driven by the
  // watcher's auto-continue, so the loop can sequence steps itself.
  const aiAwaitResolveRef = useRef<
    ((r: { output: string; exitCode: number | null }) => void) | null
  >(null);
  const runAiCommandAwait = (command: string) =>
    new Promise<{ output: string; exitCode: number | null }>((resolve) => {
      aiAwaitResolveRef.current = resolve;
      void runAiCommand(command);
    });

  // The watcher: when the block the AI started closes, its REAL result
  // (exit code, output as the user saw it) becomes the next step's input.
  useEffect(() => {
    const waiting = aiAwaitRef.current;
    if (!waiting) return;
    const done = [...blocks]
      .reverse()
      .find((b) => b.byAi && b.endedAt !== null && b.endedAt >= waiting.since);
    if (!done) return;
    aiAwaitRef.current = null;
    const tail = done.lines.slice(-40).join('\n').slice(-1500);
    // A plan step is awaited by its runner, which owns sequencing and
    // history for the whole plan — hand it the result and stop here.
    const resolve = aiAwaitResolveRef.current;
    if (resolve) {
      aiAwaitResolveRef.current = null;
      resolve({ output: tail, exitCode: done.exitCode });
      return;
    }
    aiHistoryRef.current = [
      ...aiHistoryRef.current,
      { command: waiting.command, exitCode: done.exitCode, output: tail },
    ];
    // Hang the result on the proposal that started it, so the card can
    // show what the AI saw without the user hunting for the block.
    setAiItems((prev) => {
      const idx = [...prev]
        .reverse()
        .findIndex(
          (i) =>
            i.kind === 'proposal' &&
            i.status === 'accepted' &&
            i.command === waiting.command &&
            i.output === undefined,
        );
      if (idx === -1) return prev;
      const at = prev.length - 1 - idx;
      const next = prev.slice();
      next[at] = { ...next[at], output: tail, exitCode: done.exitCode };
      return next;
    });
    void aiStep();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks]);

  // Blocks is shown when the user is in Blocks mode AND no full-screen
  // program is running. vim/top take the terminal for as long as they
  // need it, then Blocks returns on its own.
  const showBlocks = mode === 'blocks' && !altScreen;

  // Focus the terminal the moment a full-screen program appears, so typing
  // reaches it without a click.
  useEffect(() => {
    if (altScreen) termRef.current?.focus();
  }, [altScreen]);

  const switchMode = (next: OutputMode) => {
    setMode(next);
    try {
      localStorage.setItem(OUTPUT_MODE_KEY, next);
    } catch {
      /* private mode etc. — preference just won't stick */
    }
    if (next === 'raw') {
      // The xterm box was visually hidden (opacity 0, geometry intact), so
      // a fit is cheap insurance and the scroll position snaps to live.
      requestAnimationFrame(() => {
        try {
          fitRef.current?.fit();
        } catch {
          /* hidden-measure race — next resize refits */
        }
        termRef.current?.scrollToBottom();
        termRef.current?.focus();
      });
    }
  };

  // Blocks come from OSC 133 shell integration, parsed in the main process:
  // block-start opens a running card, raw pty:data streams live output into
  // it, and block (the 'D' mark) closes it with the shell's real exit code.
  // Nothing here parses the prompt, so this works on any shell that emits
  // the marks — PowerShell today, zsh/bash when their hooks land.
  useEffect(() => {
    // True once any OSC 133 mark arrives. Until then we can't assume shell
    // integration loaded, so raw data also feeds the prompt-reading fallback
    // — otherwise a shell that never emits marks would show no blocks at all.
    let oscActive = false;
    const fallback = new PromptFallbackParser();

    // Whether the live surface is collecting the current command's bytes.
    // Begins on block open (either path), ends when the block closes; the
    // closing freeze attaches the snapshot to the block.
    let surfaceActive = false;
    const surfaceBegin = (command: string) => {
      getSurface().beginCommand(termRef.current?.cols ?? 120, command);
      surfaceActive = true;
    };
    const surfaceFreeze = () => {
      if (!surfaceActive) return;
      surfaceActive = false;
      const html = surfaceRef.current?.snapshot() ?? '';
      if (html) setBlocks((prev) => attachSnapshotToLastClosed(prev, html));
    };

    const titleFrom = (command: string) => {
      if (titledRef.current || !command) return;
      titledRef.current = true;
      onFirstCommandRef.current?.(command);
    };

    const offStart = window.api.onPtyBlockStart((event) => {
      if (event.id !== id) return;
      oscActive = true;
      const command = event.command.trim();
      if (!command || isSafetyBanner(command)) return;
      titleFrom(command);
      // Commands sent from the Blocks command bar bypass xterm's onData, so
      // this is where they get surfaced in the Running board.
      beginTermRunRef.current(command);
      setBlocks((prev) => openBlock(prev, command, Date.now()));
      if (nextBlockByAiRef.current) {
        nextBlockByAiRef.current = false;
        setBlocks((prev) => tagLastOpenAsAi(prev));
      }
      surfaceBegin(command);
    });

    const offData = window.api.onPtyData((event) => {
      if (event.id !== id) return;
      // While a full-screen program owns the terminal, its output is cursor
      // painting meant for the screen, not scrollback. xterm renders it; the
      // block ignores it.
      if (altScreenRef.current) return;
      touchTermRunRef.current();
      if (oscActive) {
        if (surfaceActive) getSurface().feed(event.data);
        setBlocks((prev) => appendToOpenBlock(prev, event.data));
        return;
      }
      const events = fallback.feed(event.data);
      // The Running board has to be fed from BOTH paths. When the shell
      // marks never arrive this is the only place a command's start and end
      // are observed, so a REPL launched here would otherwise never appear.
      for (const ev of events) {
        if (ev.type === 'start') {
          titleFrom(ev.text);
          beginTermRunRef.current(ev.text);
        } else if (ev.type === 'end') {
          endTermRunRef.current(null);
        }
      }
      // Surface sequencing. One chunk can end command A AND start command
      // B, and the grid must freeze for A before it resets for B — so the
      // chunk feeds the CURRENT grid when an end is present, and only a
      // pure start feeds the fresh one (echo included; snapshots trim
      // prompt rows either way).
      const hasEnd = events.some((ev) => ev.type === 'end');
      const started = events.some(
        (ev) => ev.type === 'start' && !isSafetyBanner(ev.text),
      );
      if ((hasEnd || !started) && surfaceActive) getSurface().feed(event.data);
      if (events.length > 0)
        setBlocks((prev) => applyFallbackEvents(prev, events, Date.now()));
      if (started && nextBlockByAiRef.current) {
        nextBlockByAiRef.current = false;
        setBlocks((prev) => tagLastOpenAsAi(prev));
      }
      if (hasEnd) surfaceFreeze();
      if (started) {
        const startEv = events.find(
          (ev) => ev.type === 'start' && !isSafetyBanner(ev.text),
        );
        surfaceBegin(startEv?.text ?? '');
        if (!hasEnd) getSurface().feed(event.data);
      }
    });

    const offBlock = window.api.onPtyBlock((event) => {
      if (event.id !== id) return;
      oscActive = true;
      endTermRunRef.current(event.exitCode);
      setBlocks((prev) =>
        closeBlock(prev, event.command.trim(), event.output, event.exitCode, Date.now()),
      );
      surfaceFreeze();
    });

    return () => {
      offStart();
      offData();
      offBlock();
    };
  }, [id]);

  const onScrollbarThumbDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const t = termRef.current;
    const track = scrollbarTrackRef.current;
    if (!t || !track) return;
    const startY = e.clientY;
    const startViewportY = t.buffer.active.viewportY;
    const maxScroll = t.buffer.active.baseY;
    const heightFrac = Math.max(t.rows / t.buffer.active.length, 0.05);
    const travelPx = track.clientHeight * (1 - heightFrac);
    const onMove = (ev: MouseEvent) => {
      const tt = termRef.current;
      if (!tt) return;
      const dy = ev.clientY - startY;
      const dLines = travelPx > 0 ? (dy / travelPx) * maxScroll : 0;
      const target = Math.max(0, Math.min(maxScroll, Math.round(startViewportY + dLines)));
      tt.scrollLines(target - tt.buffer.active.viewportY);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  // Mount the terminal once. Tabs stay mounted across switches (so a
  // long-running shell survives), so this effect runs a single time per
  // terminal tab for its whole lifetime.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // If this is a StrictMode remount, a kill from the throwaway unmount is
    // sitting in the queue — cancel it so the shell we're about to reuse
    // survives instead of being torn down a beat later.
    const pendingKill = pendingKills.get(id);
    if (pendingKill) {
      clearTimeout(pendingKill);
      pendingKills.delete(id);
    }

    const term = new Terminal({
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 15,
      lineHeight: 1.2,
      cursorBlink: true,
      // A calm, light terminal that belongs to the white app surface
      // instead of dropping a black box into it. The ANSI palette is tuned
      // for a near-white background — xterm's defaults are built for dark
      // terminals, so their yellow/green/cyan are garish and low-contrast
      // here (e.g. PowerShell's PSReadLine paints the command token bright
      // yellow). These are muted, darker variants that stay legible on white.
      theme: {
        background: '#FFFFFF',
        foreground: '#3A3A3A',
        cursor: '#3A3A3A',
        cursorAccent: '#FBFBFA',
        selectionBackground: '#D8E6F2',
        black: '#3A3A3A',
        red: '#B4322B',
        green: '#3E7A53',
        yellow: '#9A7D2E',
        blue: '#2E5FA3',
        magenta: '#8A4D9E',
        cyan: '#2C7A7A',
        white: '#9A9A9A',
        brightBlack: '#6A6A6A',
        brightRed: '#C0392B',
        brightGreen: '#2E8B57',
        brightYellow: '#B07A1E',
        brightBlue: '#3B73C4',
        brightMagenta: '#A05BB5',
        brightCyan: '#2C9C9C',
        brightWhite: '#4A4A4A',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;
    // Register this terminal so the agent panel can read its on-screen
    // content (always-on terminal awareness, across tabs).
    registerTerminal(id, term);

    // Keep the custom scrollbar in sync with the terminal's scroll position
    // and content height. Throttled to one update per frame; only commits to
    // state when the values actually change, so heavy output / cursor blinks
    // don't cause a flood of re-renders.
    let sbRaf = 0;
    const updateSb = () => {
      if (sbRaf) return;
      sbRaf = requestAnimationFrame(() => {
        sbRaf = 0;
        const b = term.buffer.active;
        let next: { visible: boolean; topPct: number; heightPct: number };
        if (b.length <= term.rows) {
          next = { visible: false, topPct: 0, heightPct: 0 };
        } else {
          const heightFrac = Math.max(term.rows / b.length, 0.05);
          const posFrac = b.baseY > 0 ? b.viewportY / b.baseY : 1;
          next = {
            visible: true,
            topPct: posFrac * (1 - heightFrac) * 100,
            heightPct: heightFrac * 100,
          };
        }
        const key = `${next.visible}|${next.topPct.toFixed(2)}|${next.heightPct.toFixed(2)}`;
        if (key !== lastSbRef.current) {
          lastSbRef.current = key;
          setSb(next);
        }
      });
    };
    // Know the shell/home for labelling user-typed running commands.
    void window.api
      .getEnvironment()
      .then((e) => {
        envShellRef.current = e.shell;
        envHomeRef.current = e.homeDir;
      })
      .catch(() => {});

    const beginTermRun = beginTermRunRef.current;
    const checkTermDone = () => {
      const entry = termRunRef.current;
      if (!entry) return;
      const buf = term.buffer.active;
      const cursorLine =
        buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true)?.trim() ?? '';
      // A fresh PowerShell prompt with nothing typed after it = shell is idle,
      // so the typed command has finished.
      if (/^PS .*>$/.test(cursorLine)) {
        if (entry.timer) clearTimeout(entry.timer);
        if (entry.registered) finalizeProcess(entry.runId, { exitCode: 0, signal: null });
        termRunRef.current = null;
      }
    };

    // Track the shell's directory from the prompt (PS <path>>), and tell the
    // agent panel when it changes so its working folder follows the terminal.
    const checkCwd = () => {
      const buf = term.buffer.active;
      const cursorLine =
        buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true)?.trim() ?? '';
      const m = cursorLine.match(/^PS (.+?)>$/);
      if (!m) return;
      const cwd = m[1].trim();
      if (cwd && cwd !== lastCwdRef.current) {
        lastCwdRef.current = cwd;
        // Drives the folder chip in the Blocks command bar, and seeds the
        // folder browser so it opens where the shell actually is.
        setCwd(cwd);
        window.dispatchEvent(new CustomEvent('verlox:cwd-changed', { detail: { id, cwd } }));
      }
    };

    // Full-screen programs (vim, less, top, htop, REPL TUIs, other AI CLIs)
    // switch the terminal to its ALTERNATE screen buffer. When that happens
    // the Blocks overlay steps aside and the live terminal takes over, so
    // interactive programs work exactly as they do in Raw — then Blocks
    // returns when the program exits. The user never toggles a mode.
    const sbBuffer = term.buffer.onBufferChange(() => {
      const alt = term.buffer.active.type === 'alternate';
      altScreenRef.current = alt;
      setAltScreen(alt);
      // Tag the block that launched it, so when the program exits the block
      // reads "(interactive session)" instead of pages of screen painting.
      if (alt) setBlocks((prev) => markOpenBlockInteractive(prev));
    });

    const sbScroll = term.onScroll(() => updateSb());
    const sbRender = term.onRender(() => {
      updateSb();
      checkTermDone();
      checkCwd();
    });

    const start = () => {
      if (startedRef.current) return;
      try {
        fit.fit();
      } catch {
        // Host not measurable yet; a later resize will fit + start.
      }
      const { cols, rows } = term;
      if (cols < 2 || rows < 2) return; // not laid out yet — wait
      startedRef.current = true;
      window.api.ptyStart({ id, cols, rows });
      // Grab keyboard focus the moment the shell is live, so the user can
      // type straight away without a click. Without this the focus often
      // sits on the "New terminal" button that opened the tab.
      term.focus();
    };

    // Forward keystrokes / pastes straight to the PTY.
    const dataSub = term.onData((data) => {
      window.api.ptyInput({ id, data });
      // On Enter, read the command on the prompt line. First one names the tab;
      // every one feeds the long-running-command detector.
      if (data.includes('\r')) {
        const buf = term.buffer.active;
        const line =
          buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true) ?? '';
        const cmd = line.split('> ').pop()?.trim() ?? '';
        if (cmd) {
          if (!titledRef.current) {
            titledRef.current = true;
            onFirstCommandRef.current?.(cmd);
          }
          beginTermRun(cmd);
        }
      }
    });

    // PTY output → screen. Filter by id so each terminal only renders
    // its own shell's bytes.
    const offData = window.api.onPtyData((event) => {
      if (event.id === id) term.write(event.data);
    });

    const offExit = window.api.onPtyExit((event) => {
      if (event.id !== id) return;
      term.write(`\r\n\x1b[90m[process exited: ${event.exitCode}]\x1b[0m\r\n`);
    });

    // Keep the PTY sized to the viewport.
    const resize = () => {
      const f = fitRef.current;
      const t = termRef.current;
      if (!f || !t) return;
      // A hidden tab's container measures near zero. Fitting then would
      // shrink the PTY to a sliver and every program would hard-wrap its
      // output at that width — and the wrapping is baked into the stream,
      // so it survives the tab becoming visible again. Only fit real
      // geometry; the observer fires again when the tab returns.
      if (host.clientWidth < 200 || host.clientHeight < 80) return;
      try {
        f.fit();
      } catch {
        return;
      }
      if (!startedRef.current) {
        start();
        return;
      }
      window.api.ptyResize({ id, cols: t.cols, rows: t.rows });
    };

    const observer = new ResizeObserver(() => resize());
    observer.observe(host);

    // Attempt an initial start (works when the tab mounts visible).
    start();

    return () => {
      observer.disconnect();
      dataSub.dispose();
      sbBuffer.dispose();
      sbScroll.dispose();
      sbRender.dispose();
      if (sbRaf) cancelAnimationFrame(sbRaf);
      // Clear any pending/registered terminal-run tracking for this tab.
      if (termRunRef.current?.timer) clearTimeout(termRunRef.current.timer);
      if (termRunRef.current?.registered) {
        finalizeProcess(termRunRef.current.runId, { exitCode: null, signal: 'closed' });
      }
      termRunRef.current = null;
      offData();
      offExit();
      unregisterTerminal(id);
      // Defer the kill so a StrictMode remount can cancel it (see the note on
      // pendingKills above). A real close has no remount, so this fires.
      pendingKills.set(
        id,
        setTimeout(() => {
          pendingKills.delete(id);
          window.api.ptyKill(id);
        }, 250),
      );
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [id]);

  // When this tab becomes visible (or the window resizes it), re-fit and
  // focus. A tab that first mounted while hidden gets its PTY started here.
  useEffect(() => {
    if (!isActive) return;
    const t = termRef.current;
    const f = fitRef.current;
    if (!t || !f) return;
    // Defer to the next frame so layout has settled before we measure.
    const raf = requestAnimationFrame(() => {
      try {
        f.fit();
      } catch {
        return;
      }
      if (!startedRef.current) {
        if (t.cols >= 2 && t.rows >= 2) {
          startedRef.current = true;
          window.api.ptyStart({ id, cols: t.cols, rows: t.rows });
        }
      } else {
        window.api.ptyResize({ id, cols: t.cols, rows: t.rows });
      }
      t.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [isActive, id]);

  // Clicking anywhere in the pane focuses the terminal, so a click after
  // the terminal has lost focus (e.g. to DevTools or another tab) always
  // restores typing. mousedown (not click) so focus lands before the
  // browser's default selection handling runs.
  return (
    <div className="flex h-full w-full overflow-hidden bg-white">
      {/* Left: the terminal column (chrome bar + raw/blocks content). */}
      <div className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden">
        {/* Raw / Blocks toggle — floats over the top-right corner of the
            terminal, no chrome strip behind it. */}
        {/* Hidden while a full-screen program is running: switching modes
            mid-vim would be meaningless, and the toggle would overlap it. */}
        {!altScreen && (
          <div className="absolute right-4 top-2.5 z-20">
            <OutputModeToggle mode={mode} onChange={switchMode} />
          </div>
        )}

        {/* The outer box owns the padding + width cap; the INNER box is the
            xterm mount and carries NO padding, so FitAddon measures a clean
            box and fits the rows exactly — no clipped/unreachable last line.
            In Blocks mode the xterm box stays mounted at full size (it keeps
            consuming the PTY stream, and hiding via opacity rather than
            display:none keeps FitAddon's geometry valid) with BlocksView
            layered over it.
            That always-mounted terminal is what lets Blocks host interactive
            programs: when one takes the alternate screen, we simply stop
            hiding the terminal instead of asking the user to switch modes. */}
        <div className="relative min-h-0 w-full flex-1">
          <div
            aria-hidden={showBlocks}
            className={`h-full w-full max-w-[1200px] overflow-hidden px-6 pb-6 pt-3 transition-opacity duration-200 ${
              showBlocks ? 'pointer-events-none opacity-0' : 'opacity-100'
            }`}
          >
            <div
              ref={hostRef}
              onMouseDown={() => termRef.current?.focus()}
              className="h-full w-full overflow-hidden"
            />
          </div>
          {showBlocks && (
            <BlocksView
              terminalId={id}
              blocks={blocks}
              cwd={cwd}
              onStopped={(stopped) =>
                setBlocks((prev) => markOpenBlockStopped(prev, stopped))
              }
              surfaceMount={surfaceMount}
              surfaceFocus={surfaceFocus}
              aiItems={aiItems}
              aiActive={aiActive}
              aiPhase={aiPhase}
              aiContext={aiContext}
              onAiClearContext={onAiClearContext}
              aiPlanMode={aiPlanMode}
              onAiPlanMode={setAiPlanMode}
              onAiUndo={onAiUndo}
              aiRestorePoints={aiRestorePoints}
              onAiRunPlan={(itemId) => void runAiPlan(itemId)}
              onAiCancelPlan={(itemId) => {
                updatePlan(itemId, (p) => ({ ...p, state: 'cancelled' }));
                setAiDone(true);
              }}
              onAiProposal={onAiProposal}
              onAiSend={onAiSend}
              onAiEnd={onAiEnd}
              onAiFix={onAiFix}
              onAiCall={onAiCall}
              onAiStart={onAiStart}
            />
          )}
        </div>

        {/* Custom premium scrollbar — floats at the column's right edge (not
            the text-column edge) and mirrors the terminal's scroll. Raw mode
            only; BlocksView scrolls natively. */}
        {sb.visible && !showBlocks && (
          <div
            ref={scrollbarTrackRef}
            className="absolute right-1.5 top-3 bottom-3 z-[7] w-1.5"
          >
            <div
              onMouseDown={onScrollbarThumbDown}
              className="absolute left-0 w-full cursor-pointer rounded-full bg-black/15 transition-colors hover:bg-black/30"
              style={{ top: `${sb.topPct}%`, height: `${sb.heightPct}%` }}
            />
          </div>
        )}
      </div>

    </div>
  );
}

// Raw vs Blocks output toggle. Raw is the live xterm surface; Blocks slices
// the same stream into one card per command (Warp-style). A future AI mode
// (explain each command's output in plain English) can join as a third pill.
function OutputModeToggle({
  mode,
  onChange,
}: {
  mode: OutputMode;
  onChange: (mode: OutputMode) => void;
}) {
  const pill = (m: OutputMode, label: string) => (
    <button
      type="button"
      onClick={() => onChange(m)}
      aria-pressed={mode === m}
      className={`rounded-full px-2.5 py-0.5 transition-colors ${
        mode === m
          ? 'bg-[#15161A] text-white'
          : 'text-ink-hint hover:text-[#3A3A3A]'
      }`}
    >
      {label}
    </button>
  );
  return (
    <div
      role="group"
      aria-label="Output mode"
      className="flex select-none items-center gap-0.5 rounded-full border border-black/[0.08] p-0.5 text-[10.5px] font-medium"
      style={{ background: SHEEN_BG, boxShadow: SHEEN_SHADOW }}
    >
      {pill('raw', 'Raw')}
      {pill('blocks', 'Blocks')}
    </div>
  );
}

function getCommandSuggestions(command: string): string[] {
  const cmd = command.trim().toLowerCase().replace(/^['"]+|['"]+$/g, '');
  if (/^npm (install|i)(\s|$)/.test(cmd) || cmd === 'npm install' || cmd === 'npm i')
    return ['npm start', 'npm run build', 'npm test'];
  if (/^npm start/.test(cmd)) return ['npm run build', 'npm test'];
  if (/^git add/.test(cmd)) return ['git commit -m ""', 'git status', 'git diff --staged'];
  if (/^git commit/.test(cmd)) return ['git push', 'git log --oneline -5'];
  if (/^git status/.test(cmd)) return ['git add .', 'git diff', 'git log --oneline -5'];
  if (/^git clone/.test(cmd)) return ['ls', 'npm install'];
  if (/^git pull/.test(cmd)) return ['git log --oneline -5', 'git status'];
  if (/^cd /.test(cmd)) return ['ls', 'dir', 'code .'];
  if (/^(ls|dir)/.test(cmd)) return ['cd', 'code .'];
  if (/^python/.test(cmd)) return ['pip install -r requirements.txt', 'python -m pytest'];
  if (/^pip install/.test(cmd)) return ['python -m pytest', 'pip list'];
  if (/^docker build/.test(cmd)) return ['docker run', 'docker ps'];
  if (/^docker run/.test(cmd)) return ['docker ps', 'docker logs'];
  return [];
}

// Signatures of a failed command, used ONLY when the shell gave us no exit
// code. Deliberately broad: missing a failure is worse than a false positive,
// because a wrongly-green block tells the user everything is fine when we
// genuinely don't know.
const ERROR_RE =
  /\b(error|failed|failure|not recognized|not found|no such file|exception|cannot|can't|unable to|denied|refused|fatal|traceback|bad option|unknown option|invalid|unexpected|missing|abort(ed)?|panic)\b|^usage:/i;

// Plain-English summary of what a command did and how it turned out. No AI
// call — this is a fast local read of the command + its output, which is why
// the panel never claims a token cost for a plain shell command.
//
// Success/failure comes from the shell's real exit code (OSC 133) whenever we
// have one. When the shell didn't report a code, we do NOT assume success —
// unknown is not the same as fine — so we fall back to scanning the output for
// an error signature, which is the old heuristic used only as a safety net.
function summarizeBlock(block: TerminalBlockData): {
  headline: string;
  status: 'ok' | 'error' | 'stopped' | 'partial';
} {
  const cmd = block.command.trim();
  const word = cmd.split(/\s+/)[0]?.replace(/^['"]+|['"]+$/g, '') ?? cmd;

  // A deliberate stop is its own outcome. Judging it by exit code would
  // brand every stopped command a failure (force-kills exit non-zero), and
  // calling it success would be just as wrong.
  if (block.stopped) {
    const name = word || 'The command';
    if (block.stopped.reason === 'replaced') {
      const next = (block.stopped.next ?? '').split(/\s+/)[0] || 'the next command';
      const state = block.stopped.waiting
        ? `${name} was waiting for your input`
        : `${name} was still running`;
      return {
        headline: `${state}, so Verlox stopped it to run ${next}. Nothing failed.`,
        status: 'stopped',
      };
    }
    return {
      headline: `You stopped ${name}. Nothing failed.`,
      status: 'stopped',
    };
  }

  // Verlox's own safe-delete prints structured reports, so deletes can be
  // summarized by counting real outcomes instead of pattern-guessing. This
  // runs before the generic error scan because a delete that half-worked
  // ("moved b.txt, '/P' wasn't found") is a partial outcome, not a plain
  // error — calling it error hides that a file actually moved.
  const moved = block.lines.filter((l) =>
    /Verlox: moved '.+' to the Recycle Bin/.test(l),
  ).length;
  const missing = block.lines
    .map((l) => /Verlox: '(.+?)' was not found\. Nothing deleted\./.exec(l))
    .filter((m): m is RegExpExecArray => m !== null);
  const kept = block.lines.filter((l) =>
    /Verlox: couldn't safely delete/.test(l),
  ).length;
  if (moved > 0 || missing.length > 0 || kept > 0) {
    const movedText =
      moved === 1
        ? 'Moved 1 item to the Recycle Bin (recoverable)'
        : `Moved ${moved} items to the Recycle Bin (recoverable)`;
    const missingText =
      missing.length === 1
        ? `'${missing[0][1]}' wasn't found`
        : `${missing.length} paths weren't found`;
    const keptText =
      kept === 1 ? '1 item couldn’t be moved and stayed put' : `${kept} items stayed put`;
    const problems = [
      ...(missing.length > 0 ? [missingText] : []),
      ...(kept > 0 ? [keptText] : []),
    ].join('; ');
    if (moved > 0 && problems) {
      return { headline: `${movedText}. Also: ${problems}.`, status: 'partial' };
    }
    if (moved > 0) {
      return {
        headline: `${movedText}. Restore ${moved === 1 ? 'it' : 'them'} from the Recycle Bin if you change your mind.`,
        status: 'ok',
      };
    }
    return { headline: `Nothing was deleted: ${problems}.`, status: 'error' };
  }

  const errLineFound = block.lines.find((l) => ERROR_RE.test(l)) ?? '';
  const failed =
    block.exitCode !== null ? block.exitCode !== 0 : errLineFound !== '';

  // A chained line ("mkdir x; cd x; echo y > z") reports the exit code of
  // its LAST command, so a failure earlier in the chain can land on a zero
  // exit. Calling that plain success while the card shows a red error
  // record is exactly the kind of lie this panel exists to prevent — so a
  // real PowerShell error record in a "successful" block reads as partial.
  // Keyed on error-record scaffolding, which nothing else prints, rather
  // than the broad word scan.
  if (!failed) {
    const atLine = block.lines.findIndex((l) => /^At line:\d+ char:\d+/.test(l.trim()));
    const hasRecord =
      atLine !== -1 ||
      block.lines.some((l) => /^\s*\+\s*(CategoryInfo|FullyQualifiedErrorId)\s*:/.test(l));
    if (hasRecord) {
      // The line above "At line:N" is the human-readable complaint.
      const detail =
        atLine > 0 ? block.lines[atLine - 1].trim().slice(0, 90) : '';
      return {
        headline: detail
          ? `Finished, but part of it reported an error: ${detail}`
          : 'Finished, but part of the command reported an error.',
        status: 'partial',
      };
    }
  }

  if (failed) {
    // A spinner frame can end up glued to the front of the line the error
    // scan picked ("-npm error code E404"); the headline drops it.
    const errLine = errLineFound.replace(/^[\s\\|/-]+(?=\w)/, '');
    if (/not recognized/i.test(errLine))
      return { headline: `“${word}” isn’t a recognized command. Check the spelling.`, status: 'error' };
    if (/not found|no such file/i.test(errLine))
      return { headline: 'A file or path in the command could not be found.', status: 'error' };
    if (/denied|permission/i.test(errLine))
      return { headline: 'Permission was denied. The command needs higher access.', status: 'error' };
    if (/^usage:/i.test(errLine.trim()))
      return {
        headline: `“${word}” needs arguments to do anything. Its usage guide is in the output above.`,
        status: 'error',
      };
    if (errLine.trim())
      return { headline: `Command failed: ${errLine.trim().slice(0, 80)}`, status: 'error' };
    return { headline: `Command failed with exit code ${block.exitCode}.`, status: 'error' };
  }
  const lc = cmd.toLowerCase();
  if (/^(ls|dir|gci|get-childitem)/.test(lc))
    return { headline: `Listed ${block.lines.length} line${block.lines.length === 1 ? '' : 's'} of directory contents.`, status: 'ok' };
  if (/^cd /.test(lc)) return { headline: 'Changed the working directory.', status: 'ok' };
  if (/^git commit/.test(lc)) return { headline: 'Committed staged changes.', status: 'ok' };
  if (/^git push/.test(lc)) return { headline: 'Pushed commits to the remote.', status: 'ok' };
  if (/^git status/.test(lc)) return { headline: 'Reported the working-tree status.', status: 'ok' };
  if (/^npm (install|i)/.test(lc)) return { headline: 'Installed npm dependencies.', status: 'ok' };
  if (/^(npm run|npm start)/.test(lc)) return { headline: 'Ran an npm script.', status: 'ok' };
  const out = block.lines.length;
  if (out === 0) return { headline: 'Completed with no output.', status: 'ok' };
  return { headline: `Completed and produced ${out} line${out === 1 ? '' : 's'} of output.`, status: 'ok' };
}

// One shiny tone for the whole insight surface: a cool platinum gradient with
// an inset top highlight so it reads as glass, not flat grey. The gradient
// ends deep enough — and the card shadow lifts enough — that the surface
// separates clearly from the app's white background.
const SHEEN_BG = 'linear-gradient(180deg, #fafbfe 0%, #eff2f8 55%, #e8ecf4 100%)';
const SHEEN_SHADOW = 'inset 0 1px 0 rgba(255,255,255,0.9), 0 1px 2px rgba(16,24,40,0.05)';
// Elevation for whole cards (blocks, command bar): visible hairline + a soft
// two-layer drop so the card floats off the white instead of dissolving in.
const CARD_SHADOW =
  'inset 0 1px 0 rgba(255,255,255,0.9), 0 1px 3px rgba(16,24,40,0.07), 0 6px 16px rgba(16,24,40,0.06)';

function readBrain(): {
  label: string;
  provider: string;
  engine: string;
  model: string;
  providerId: string;
} {
  try {
    return {
      label: localStorage.getItem('verlox-brain-label') || 'AI',
      provider: localStorage.getItem('verlox-brain-provider') || 'anthropic',
      engine: localStorage.getItem('verlox-brain-engine') || 'verlox',
      model: localStorage.getItem('verlox-brain-model') || 'sonnet',
      providerId: localStorage.getItem('verlox-brain-provider-id') || '',
    };
  } catch {
    return { label: 'AI', provider: 'anthropic', engine: 'verlox', model: 'sonnet', providerId: '' };
  }
}

// `aiUsed` is false for plain shell commands (the user typed straight into the
// PTY, no model in the loop) — no token line, no model badge. When the AI ran
// the step, pass aiUsed + tokens and the model icon + token count appear.
function BlockInsights({
  block,
  onSendCommand,
  onAiFix,
  aiUsed = false,
  tokens = 0,
}: {
  block: TerminalBlockData;
  onSendCommand: (cmd: string) => void;
  // Starts an AI session in the block timeline seeded with this block's
  // failure — the agent enters the room instead of writing an essay here.
  onAiFix: () => void;
  aiUsed?: boolean;
  tokens?: number;
}) {
  const [open, setOpen] = useState(false);
  // In-block AI explanation ("Explain" chip). Generated on demand with the
  // same brain the chat panel uses; rendered right here in the block, with
  // the model that wrote it credited underneath.
  const [explain, setExplain] = useState<{
    state: 'loading' | 'done' | 'error';
    text: string;
    brainLabel: string;
    brainProvider: string;
  } | null>(null);
  const runExplain = async (fix = false) => {
    if (explain?.state === 'loading') return;
    const brain = readBrain();
    setExplain({ state: 'loading', text: '', brainLabel: brain.label, brainProvider: brain.provider });
    try {
      const env = await window.api.getEnvironment();
      const res = await window.api.agentPlanStep({
        goal:
          (fix
            ? `This terminal command failed. Explain in plain English what went wrong and give the corrected command to run. Reply with the explanation and the fix only; do not run anything.\n\n`
            : `Explain in plain English what this terminal command did, based on its output. ` +
              `Reply with the explanation only. Do NOT propose, suggest, or run any commands.\n\n`) +
          `Command: ${block.command}\nOutput:\n${block.lines.slice(-60).join('\n').slice(-2500)}`,
        priorSteps: [],
        cwd: env.homeDir,
        platform: env.platform,
        shell: env.shell,
        engine: brain.engine as never,
        model: brain.model,
        providerId: brain.providerId || undefined,
      });
      if (res.ok) {
        setExplain({
          state: 'done',
          text: res.step.message || 'No explanation came back. Try again.',
          brainLabel: brain.label,
          brainProvider: brain.provider,
        });
      } else {
        setExplain({ state: 'error', text: res.error, brainLabel: brain.label, brainProvider: brain.provider });
      }
    } catch {
      setExplain({
        state: 'error',
        text: 'The explanation could not be generated. Try again.',
        brainLabel: brain.label,
        brainProvider: brain.provider,
      });
    }
  };
  // Real Recovery Vault entries captured while this block ran. Checked once
  // on expand (not per render) — the panel only appears when something is
  // genuinely restorable, never as a vague "may be recoverable".
  const [vaultHits, setVaultHits] = useState<VaultEntry[]>([]);
  const vaultCheckedRef = useRef(false);
  useEffect(() => {
    if (!open || vaultCheckedRef.current || block.endedAt === null) return;
    vaultCheckedRef.current = true;
    void window.api
      .vaultList()
      .then((entries) => {
        const ended = block.endedAt ?? Date.now();
        setVaultHits(
          entries.filter(
            (e) => e.capturedAt >= block.startedAt - 2000 && e.capturedAt <= ended + 2000,
          ),
        );
      })
      .catch(() => {});
  }, [open, block.startedAt, block.endedAt]);

  if (block.endedAt === null) return null;

  const { headline, status } = summarizeBlock(block);
  const ok = status !== 'error';
  const durationMs = Math.max(0, block.endedAt - block.startedAt);
  const durationText = durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`;
  const suggestions = getCommandSuggestions(block.command).slice(0, 3);
  const brain = aiUsed ? readBrain() : null;
  const brainPng = brain ? BRAIN_PROVIDER_PNGS[brain.provider] : undefined;

  return (
    <div className="border-t border-black/[0.04]">
      {/* The disclosure has to read as one thing: the caret sits WITH the
          label (not stranded in the far corner), and while collapsed the
          summary itself previews inline — seeing the sentence start is what
          tells you there's more to open, far better than any glyph. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? 'Hide details' : headline}
        className="group/ins flex w-full items-center gap-1.5 px-3 py-1.5 text-left transition-colors hover:bg-black/[0.025]"
      >
        <span
          className="shrink-0 text-[8px] text-ink-micro transition-transform duration-200 group-hover/ins:text-ink-label"
          style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}
          aria-hidden="true"
        >
          ▶
        </span>
        <span className="shrink-0 text-[10px] text-ink-label" aria-hidden="true">✦</span>
        <span className="shrink-0 text-[11px] font-medium text-ink-label">
          What happened
        </span>
        <span
          className={`shrink-0 text-[10px] ${
            status === 'ok'
              ? 'text-[#3E7A53]'
              : status === 'stopped'
                ? 'text-[#2E5FA3]'
                : status === 'partial'
                  ? 'text-amber-600'
                  : 'text-[#B4322B]'
          }`}
        >
          {status === 'ok'
            ? '● success'
            : status === 'stopped'
              ? '● stopped'
              : status === 'partial'
                ? '● partial'
                : '● error'}
        </span>
        <span className="shrink-0 text-[10px] text-ink-micro">{durationText}</span>
        {!open && (
          <span className="min-w-0 flex-1 truncate text-[11px] text-ink-hint">
            {headline}
          </span>
        )}
        <span className="ml-auto shrink-0 pl-2 text-[10px] text-ink-micro opacity-0 transition-opacity group-hover/ins:opacity-100">
          {open ? 'Hide' : 'Details'}
        </span>
      </button>
      <div
        className="overflow-hidden transition-all duration-300 ease-out"
        style={{ maxHeight: open ? (explain ? '680px' : '300px') : '0px' }}
      >
        <div className="px-3 pb-3 pt-1">
          {/* Summary line */}
          <p className="mb-2.5 text-[12px] leading-snug text-[#3A3A3A]">{headline}</p>

          {/* Recovery Vault — only when something from this block is actually
              held in the vault and restorable. */}
          {vaultHits.length > 0 && (
            <div
              className="mb-2.5 rounded-lg border border-white/60 px-2.5 py-2"
              style={{ background: 'rgba(255,255,255,0.55)', boxShadow: SHEEN_SHADOW }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-ink-label">
                  {vaultHits.length === 1
                    ? `${vaultHits[0].name} is in the Recovery Vault.`
                    : `${vaultHits.length} items from this command are in the Recovery Vault.`}
                </span>
                <button
                  type="button"
                  onClick={() => window.dispatchEvent(new Event('verlox:open-vault'))}
                  className="shrink-0 rounded-md border border-hairline bg-white px-2 py-0.5 text-[10.5px] font-medium text-ink-label transition-colors hover:border-ink/20 hover:text-ink"
                >
                  Restore
                </button>
              </div>
            </div>
          )}

          {/* Actions: try again + suggested next commands, one shiny chip style. */}
          <div className="flex flex-wrap gap-1">
            <button
              type="button"
              onClick={() => onSendCommand(block.command)}
              className="rounded-lg border border-white/70 px-2 py-1 font-mono text-[10.5px] font-medium text-ink transition-all hover:brightness-[0.97]"
              style={{ background: 'rgba(255,255,255,0.7)', boxShadow: SHEEN_SHADOW }}
            >
              ↻ Try again
            </button>
            {/* Both answer inline, right in the block: Explain on success,
                a what-went-wrong + corrected-command answer on failure. */}
            {ok ? (
              <button
                type="button"
                onClick={() => void runExplain()}
                disabled={explain?.state === 'loading'}
                className="rounded-lg border border-white/70 px-2 py-1 text-[10.5px] font-medium text-ink-label transition-all hover:brightness-[0.97] hover:text-ink disabled:opacity-60"
                style={{ background: 'rgba(255,255,255,0.7)', boxShadow: SHEEN_SHADOW }}
              >
                {explain?.state === 'loading' ? '✦ Explaining' : '✦ Explain'}
              </button>
            ) : (
              <button
                type="button"
                onClick={onAiFix}
                className="rounded-lg border border-white/70 px-2 py-1 text-[10.5px] font-medium text-[#B4322B] transition-all hover:brightness-[0.97]"
                style={{ background: 'rgba(255,255,255,0.7)', boxShadow: SHEEN_SHADOW }}
              >
                ✦ Fix this
              </button>
            )}
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => onSendCommand(s)}
                className="rounded-lg border border-white/70 px-2 py-1 font-mono text-[10.5px] text-ink-label transition-all hover:brightness-[0.97] hover:text-ink"
                style={{ background: 'rgba(255,255,255,0.7)', boxShadow: SHEEN_SHADOW }}
              >
                {s}
              </button>
            ))}
          </div>

          {/* In-block AI explanation, with the model that wrote it credited. */}
          {explain && (
            <div
              className="mt-2.5 rounded-lg border border-white/60 px-2.5 py-2"
              style={{ background: 'rgba(255,255,255,0.55)', boxShadow: SHEEN_SHADOW }}
            >
              {explain.state === 'loading' ? (
                <p className="text-[11.5px] text-ink-hint">Reading the output.</p>
              ) : (
                <>
                  <p
                    className={`whitespace-pre-wrap text-[12px] leading-relaxed ${
                      explain.state === 'error' ? 'text-[#B4322B]' : 'text-[#3A3A3A]'
                    }`}
                  >
                    {explain.text}
                  </p>
                  {explain.state === 'done' && (
                    <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-ink-micro">
                      {BRAIN_PROVIDER_PNGS[explain.brainProvider] ? (
                        <img
                          src={BRAIN_PROVIDER_PNGS[explain.brainProvider]}
                          alt=""
                          aria-hidden="true"
                          className="h-3 w-3 object-contain opacity-80"
                        />
                      ) : null}
                      <span>{explain.brainLabel}</span>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Footer: model icon + tokens only when the AI ran this step. */}
          {aiUsed && brain && (
            <div className="mt-2 flex items-center gap-1.5 text-[10px] text-ink-micro">
              {brainPng ? (
                <img src={brainPng} alt="" aria-hidden="true" className="h-3.5 w-3.5 object-contain opacity-80" />
              ) : null}
              <span>{brain.label}</span>
              <span>· {tokens} tokens</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// The Blocks view: every command the shell ran since this tab opened, one
// card each, newest at the bottom, with a command bar that types into the
// same PTY. Reading is the point; the Raw view stays a toggle away for
// full-fidelity scrollback and interactive CLIs (vim, REPLs).
function BlocksView({
  terminalId,
  blocks,
  cwd,
  onStopped,
  surfaceMount,
  surfaceFocus,
  aiItems,
  aiActive,
  aiPhase,
  aiContext,
  onAiClearContext,
  aiPlanMode,
  onAiPlanMode,
  onAiUndo,
  aiRestorePoints,
  onAiRunPlan,
  onAiCancelPlan,
  onAiProposal,
  onAiSend,
  onAiEnd,
  onAiFix,
  onAiCall,
  onAiStart,
}: {
  terminalId: string;
  blocks: TerminalBlockData[];
  // Absolute path the shell is in, or '' before the first prompt is read.
  cwd: string;
  // Records WHY the open block is being ended (Stop button / replaced by a
  // new command) so its summary can say so instead of guessing.
  onStopped: (stopped: NonNullable<TerminalBlockData['stopped']>) => void;
  // The live terminal surface for the running card: a STABLE ref callback
  // that reparents the shared grid element in/out, and a click-to-focus so
  // keystrokes go to the program.
  surfaceMount: (node: HTMLDivElement | null) => void;
  surfaceFocus: () => void;
  // The AI session: one consolidated card above the bar, the bar routes to
  // it while active, and Fix this starts it.
  aiItems: AiItem[];
  aiActive: boolean;
  aiPhase: 'thinking' | 'approval' | 'running' | 'done' | 'idle';
  // Plan-first: lay out the whole plan for one approval instead of
  // approving each step as it comes.
  // What this session was called about, shown as a reference above the
  // input, and the way to drop it.
  aiContext: string;
  onAiClearContext: () => void;
  aiPlanMode: boolean;
  onAiPlanMode: (on: boolean) => void;
  // Rewinds the guarded folder to just before an AI command ran.
  onAiUndo: (command: string) => Promise<{ ok: boolean; message: string }>;
  // Commands that actually have a restore point captured.
  aiRestorePoints: Record<string, string>;
  onAiRunPlan: (itemId: string) => void;
  onAiCancelPlan: (itemId: string) => void;
  onAiProposal: (itemId: string, run: boolean) => void;
  onAiSend: (text: string, image?: { mediaType: string; base64Data: string } | null) => void;
  onAiEnd: () => void;
  onAiFix: (block: TerminalBlockData) => void;
  onAiCall: (block: TerminalBlockData) => void;
  // Opens the room from the bar, with no block in particular. Called only
  // after the user has chosen which model should join.
  onAiStart: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState('');
  // Home directory, for collapsing the cwd chip to `~`. Fetched once.
  const [home, setHome] = useState('');
  useEffect(() => {
    void window.api
      .getEnvironment()
      .then((env) => setHome(env.homeDir))
      .catch(() => {});
  }, []);
  const label = shortenPath(cwd, home);
  // Folder browser for the command bar: picking a folder cd's the shell
  // there, picking a file cd's to its parent. Saves typing long paths.
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerWrapRef = useRef<HTMLDivElement | null>(null);

  // A running block going quiet is a state change with no event behind it,
  // so a slow tick re-renders to let "running" become "waiting for input".
  // Only ticks while something is actually running.
  const anyRunning = blocks.some((b) => b.endedAt === null);
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => setTick(Date.now()), 500);
    return () => clearInterval(t);
  }, [anyRunning]);

  // A NEW command card always scrolls fully into view — submitting a
  // command and then having to hunt for its card defeats the point.
  const lastBlockId = blocks.length > 0 ? blocks[blocks.length - 1].id : null;
  const lastAiId = aiItems.length > 0 ? aiItems[aiItems.length - 1].id : null;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || (!lastBlockId && !lastAiId)) return;
    // After paint: a new card's height (and the AI card's growing log)
    // isn't in scrollHeight yet on the same tick, which left the newest
    // card half-off screen.
    const raf = requestAnimationFrame(() =>
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }),
    );
    return () => cancelAnimationFrame(raf);
  }, [lastBlockId, lastAiId]);

  // Stick to the bottom while output streams in, unless the user has
  // scrolled up to read something (then leave them alone). Runs on the
  // waiting tick too, because the live surface grows its height outside
  // React and block state alone doesn't see it.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [blocks, tick]);

  // Close the picker on an outside click or Escape.
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      if (pickerWrapRef.current && !pickerWrapRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
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

  // Send a real `cd` through the shell rather than tracking cwd ourselves —
  // the shell stays the single source of truth for where the terminal is.
  const goToFolder = (selection: PathSelection) => {
    const target = selection.isDirectory ? selection.path : selection.dir;
    setPickerOpen(false);
    window.api.ptyInput({ id: terminalId, data: `cd "${target}"\r` });
  };

  // A command submitted while another is still running: main stops the old
  // one and runs the new one once it's actually gone (ptyRunCommand). The
  // sequencing lives in the main process on purpose — gating it on block
  // state here once deadlocked on a block that was stuck open. `pending` is
  // only a short-lived hint plus a debounce against Enter-mashing while the
  // handoff (~1s) is in flight.
  const [pending, setPending] = useState<{ cmd: string; at: number } | null>(null);

  // Called by the form's submit and by Enter in the textarea, so it takes
  // anything with preventDefault rather than a FormEvent specifically.
  const send = (e: { preventDefault: () => void }) => {
    e.preventDefault();
    const cmd = draft.trim();
    if (!cmd) return;
    // While the AI is in the room, the bar is the conversation. End the
    // session to type shell commands yourself again.
    if (aiActive) {
      onAiSend(cmd, attachment ? { mediaType: attachment.mediaType, base64Data: attachment.base64Data } : null);
      setAttachment(null);
      setDraft('');
      setCompletion(null);
      return;
    }
    historyAppend(cmd);
    historyRef.current = historyLoad();
    histPosRef.current = null;
    setCompletion(null);
    const last = blocks[blocks.length - 1];
    if (last && last.endedAt === null) {
      // Covers the worst-case handoff: kill sweep + shell respawn + resend.
      if (pending && Date.now() - pending.at < 4500) return;
      window.api.ptyRunCommand({ id: terminalId, command: cmd, cwd: cwd || undefined });
      onStopped({
        reason: 'replaced',
        next: cmd,
        waiting: Date.now() - last.lastOutputAt > WAITING_AFTER_MS,
      });
      setPending({ cmd, at: Date.now() });
    } else {
      // Each line of a multi-line command is submitted like a real Enter
      // press (\r, not \n) — that's what a shell expects, and what lets a
      // pasted here-string or a multi-line block parse the way it would
      // if you had typed it.
      window.api.ptyInput({ id: terminalId, data: `${cmd.replace(/\r?\n/g, '\r')}\r` });
    }
    setDraft('');
  };

  // --- Bar keyboard memory: history (Up/Down) and Tab completion ----------
  // A textarea, not an input: pasting a multi-line command (a commit
  // message, a heredoc, a SQL block) used to collapse onto one line and
  // break the paste. Enter still submits; Shift+Enter adds a line.
  const barRef = useRef<HTMLTextAreaElement | null>(null);
  // Height follows the content up to a ceiling, then the textarea scrolls.
  // Measured from scrollHeight after each change so a paste is sized in the
  // same frame it lands.
  const [barHeight, setBarHeight] = useState<number>(20);
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    el.style.height = '0px';
    const next = Math.min(Math.max(el.scrollHeight, 20), 220);
    el.style.height = `${next}px`;
    setBarHeight(next);
  }, [draft]);
  const historyRef = useRef<string[]>(historyLoad());
  // Where Up/Down is in history, and the in-progress draft stashed when
  // the user first pressed Up so Down past the newest entry restores it.
  const histPosRef = useRef<number | null>(null);
  const histStashRef = useRef('');
  const [completion, setCompletion] = useState<{
    original: string;
    span: TokenSpan;
    dirPart: string;
    // Path candidates get quoted when they contain spaces; command-line
    // candidates are whole commands and never are.
    kind: 'command' | 'path';
    candidates: string[];
    index: number;
  } | null>(null);
  const completionSeq = useRef(0);

  const placeCaret = (at: number) => {
    requestAnimationFrame(() => barRef.current?.setSelectionRange(at, at));
  };

  const applyCompletion = (
    c: NonNullable<typeof completion>,
    index: number,
  ) => {
    const { next, caret } = applyCandidate(
      c.original,
      c.span,
      c.dirPart,
      c.candidates[index],
      c.kind === 'path',
    );
    setDraft(next);
    placeCaret(caret);
    setCompletion(c.candidates.length > 1 ? { ...c, index } : null);
  };

  // Compute and apply completion for `value` at `caret`. Shared by the Tab
  // key and the quick buttons beside the bar.
  const beginTabCompletion = (value: string, caret: number) => {
    const span = currentToken(value, caret);
    // An empty token is meaningful AFTER a command ("cd " Tab = list the
    // folders, "git checkout " Tab = list the branches). Only a fully
    // empty bar has nothing to complete.
    if (!span.text && value.slice(0, span.start).trim() === '') return;
    const start = (
      candidates: string[],
      dirPart: string,
      kind: 'command' | 'path',
    ) => {
      if (candidates.length === 0) return;
      applyCompletion(
        { original: value, span, dirPart, kind, candidates, index: 0 },
        0,
      );
    };
    const before = value.slice(0, span.start).trim();
    const words = before.split(/\s+/).filter(Boolean).map((w) => w.toLowerCase());
    const isFirst = words.length === 0;
    const plan = planCompletion(span.text, isFirst);

    // Context-aware sources: the token's MEANING beats its shape. A bare
    // token after `git checkout` is a branch, after `npm run` a script —
    // things only the machine knows, fetched from main.
    const bare = span.text.startsWith('"') ? span.text.slice(1) : span.text;
    const plainToken = !/[\\/~:]/.test(bare);
    const contextKind: 'git-branches' | 'npm-scripts' | null =
      !plainToken || words.length !== 2
        ? null
        : words[0] === 'git' &&
            ['checkout', 'switch', 'merge', 'rebase', 'branch', 'log', 'diff', 'push', 'pull'].includes(words[1])
          ? 'git-branches'
          : words[0] === 'npm' && words[1] === 'run'
            ? 'npm-scripts'
            : null;
    if (contextKind) {
      const seq = ++completionSeq.current;
      void window.api
        .completionContext({ kind: contextKind, cwd: cwd || home || '' })
        .then((list) => {
          if (seq !== completionSeq.current) return;
          const p = bare.toLowerCase();
          start(
            list.filter((c) => c.toLowerCase().startsWith(p)).slice(0, 24),
            '',
            'command',
          );
        });
      return;
    }

    if (plan.kind === 'command') {
      start(commandCandidates(plan.prefix, historyRef.current), plan.dirPart, 'command');
      return;
    }
    // Path tokens hit the filesystem; a newer keystroke or Tab makes an
    // in-flight listing stale. After `cd`, only folders make sense.
    const seq = ++completionSeq.current;
    const dp = plan.dirPart;
    const base = /^[A-Za-z]:[\\/]/.test(dp)
      ? dp
      : dp.startsWith('~')
        ? (home || '') + dp.slice(1)
        : `${cwd || home || '.'}\\${dp}`;
    const dirsOnly = words[0] === 'cd' || words[0] === 'pushd';
    void window.api.listDir(base).then((res) => {
      if (seq !== completionSeq.current || res.error) return;
      start(pathCandidates(plan.prefix, res.entries, dirsOnly), dp, 'path');
    });
  };

  // Model picker for the AI presence chip. Same list the AI terminal's
  // picker builds; selecting writes the shared brain keys so every AI call
  // (session steps, Explain) uses the new model immediately.
  // 'switch' = changing models mid-session; 'start' = the bar's Call AI,
  // where choosing a model is what actually opens the room.
  const [brainMenu, setBrainMenu] = useState<'closed' | 'switch' | 'start'>('closed');
  const [, setBrainRev] = useState(0);
  const [brains, setBrains] = useState<Brain[]>(() => buildBrains(null, []));
  const loadBrains = () => {
    void Promise.all([
      window.api.settingsGet().catch(() => null),
      window.api.listOllama().catch(() => null),
    ]).then(([s, o]) => {
      const models = (o as { models?: { name: string }[] } | null)?.models ?? [];
      setBrains(buildBrains(s, models));
    });
  };
  const toggleBrainMenu = () => {
    setBrainMenu((m) => (m === 'closed' ? 'switch' : 'closed'));
    loadBrains();
  };
  const openCallAi = () => {
    setBrainMenu((m) => (m === 'start' ? 'closed' : 'start'));
    loadBrains();
  };
  const pickBrain = (b: Brain) => {
    try {
      localStorage.setItem('verlox-brain-label', b.label);
      localStorage.setItem('verlox-brain-provider', b.provider);
      localStorage.setItem('verlox-brain-engine', b.engine);
      localStorage.setItem('verlox-brain-model', b.model);
      localStorage.setItem('verlox-brain-provider-id', b.providerId ?? '');
    } catch {
      // Private mode; the pick just won't persist.
    }
    setBrainRev((r) => r + 1);
    // Choosing the model IS the act of calling the AI in.
    if (brainMenu === 'start') {
      onAiStart();
      barRef.current?.focus();
    }
    setBrainMenu('closed');
  };

  // An image attached to the next AI message (a screenshot of a failing UI,
  // a photo of an error on another screen). Cleared once it's sent.
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [attachment, setAttachment] = useState<
    { mediaType: string; base64Data: string; dataUrl: string; name: string } | null
  >(null);
  const attachFile = async (file: File) => {
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () =>
          typeof reader.result === 'string'
            ? resolve(reader.result)
            : reject(new Error('bad read'));
        reader.onerror = () => reject(reader.error ?? new Error('read failed'));
        reader.readAsDataURL(file);
      });
      const comma = dataUrl.indexOf(',');
      setAttachment({
        mediaType: file.type,
        base64Data: dataUrl.slice(comma + 1),
        dataUrl,
        name: file.name,
      });
    } catch {
      // Unreadable file; nothing attached.
    }
  };

  // Ctrl+R's engine, shared with the `recent` quick button: the current
  // draft is the query, matches open in the panel.
  const openHistorySearch = () => {
    const matches = historySearch(draft, historyRef.current);
    if (matches.length === 0) return;
    applyCompletion(
      {
        original: draft,
        span: { start: 0, end: draft.length, text: draft },
        dirPart: '',
        kind: 'command',
        candidates: matches,
        index: 0,
      },
      0,
    );
  };

  // The quick buttons: same act as typing the text and pressing Tab, for
  // users who'd rather click than learn the key. They toggle — pressing
  // again while the panel is open closes it.
  const quickComplete = (insert: string) => {
    if (completion) {
      setCompletion(null);
      return;
    }
    barRef.current?.focus();
    if (insert === '') {
      openHistorySearch();
      return;
    }
    setDraft(insert);
    beginTabCompletion(insert, insert.length);
  };

  // What each button types-and-Tabs. A trailing space completes the EMPTY
  // token after the word: folders for cd, package.json scripts for npm run.
  const QUICK_BUTTONS: { label: string; insert: string }[] = [
    { label: 'git', insert: 'git' },
    { label: 'cd', insert: 'cd ' },
    { label: 'npm run', insert: 'npm run ' },
    { label: 'recent', insert: '' },
  ];

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // A textarea would otherwise insert a newline on Enter. Enter submits,
    // Shift+Enter (or Alt+Enter) writes a second line — the convention
    // every chat input uses.
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      send(e);
      return;
    }
    // Ctrl+C with nothing typed stops the running command for real — the
    // same stop the button does. With a draft present, the browser keeps
    // its copy/clear behavior.
    if (e.ctrlKey && e.key === 'c' && draft === '') {
      const last = blocks[blocks.length - 1];
      if (last && last.endedAt === null) {
        e.preventDefault();
        onStopped({ reason: 'stop' });
        window.api.ptyStopForeground({ id: terminalId, cwd: cwd || undefined });
      }
      return;
    }

    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const hist = historyRef.current;
      if (hist.length === 0) return;
      // In a multi-line draft the arrows belong to the text: only step
      // through history from the very start (Up) or very end (Down), so
      // editing a pasted block doesn't yank it away.
      const el = barRef.current;
      if (el && draft.includes('\n')) {
        const atStart = el.selectionStart === 0 && el.selectionEnd === 0;
        const atEnd =
          el.selectionStart === draft.length && el.selectionEnd === draft.length;
        if (e.key === 'ArrowUp' ? !atStart : !atEnd) return;
      }
      e.preventDefault();
      setCompletion(null);
      let pos = histPosRef.current;
      if (e.key === 'ArrowUp') {
        if (pos === null) {
          histStashRef.current = draft;
          pos = hist.length - 1;
        } else if (pos > 0) pos--;
        histPosRef.current = pos;
        setDraft(hist[pos]);
        placeCaret(hist[pos].length);
      } else {
        if (pos === null) return;
        pos++;
        if (pos >= hist.length) {
          histPosRef.current = null;
          setDraft(histStashRef.current);
          placeCaret(histStashRef.current.length);
        } else {
          histPosRef.current = pos;
          setDraft(hist[pos]);
          placeCaret(hist[pos].length);
        }
      }
      return;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      if (completion) {
        const n = completion.candidates.length;
        const next = (completion.index + (e.shiftKey ? -1 : 1) + n) % n;
        applyCompletion(completion, next);
        return;
      }
      beginTabCompletion(draft, barRef.current?.selectionStart ?? draft.length);
      return;
    }

    // Ctrl+R: search history by substring — what's typed is the query,
    // matches open in the same panel, Ctrl+R (or Tab) cycles older ones.
    if (e.ctrlKey && (e.key === 'r' || e.key === 'R')) {
      e.preventDefault();
      if (completion) {
        const n = completion.candidates.length;
        applyCompletion(completion, (completion.index + 1) % n);
        return;
      }
      openHistorySearch();
      return;
    }

    if (e.key === 'Escape') {
      if (completion) {
        e.preventDefault();
        setDraft(completion.original);
        setCompletion(null);
      } else if (aiActive) {
        // The other way out of AI mode, symmetric with the chip's End.
        e.preventDefault();
        onAiEnd();
      }
    }
  };

  const running = blocks.length > 0 && blocks[blocks.length - 1].endedAt === null;
  // The running program's name, for the placeholder and the held-command
  // hint ("Stopping node, then running python").
  const runningName = running
    ? (blocks[blocks.length - 1].command.trim().split(/\s+/)[0] ?? '').slice(0, 24)
    : '';

  // The hint clears itself; main owns the actual handoff.
  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(() => setPending(null), 4500);
    return () => clearTimeout(t);
  }, [pending]);
  const fmtTime = (ms: number) =>
    new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="absolute inset-0 flex flex-col">
      <div
        ref={scrollRef}
        className={`min-h-0 w-full max-w-[1200px] flex-1 px-6 ${
          blocks.length === 0 ? 'overflow-hidden' : 'overflow-y-auto pt-3'
        }`}
      >
        {blocks.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center pb-16">
            {/* A quiet hero: glyph, one line, and starter commands so the
                empty board invites a first run instead of sitting blank. */}
            <div
              className="flex h-12 w-12 items-center justify-center rounded-2xl border border-black/[0.08]"
              style={{ background: SHEEN_BG, boxShadow: CARD_SHADOW }}
            >
              <span className="font-mono text-[18px] text-[#3E7A53]" aria-hidden="true">
                ❯
              </span>
            </div>
            <p className="mt-4 text-[13.5px] font-medium text-ink">
              Every command becomes a block.
            </p>
            <p className="mt-1 max-w-[340px] text-center text-[12px] leading-relaxed text-ink-hint">
              Output, a summary of what happened, and one-click next steps,
              all in one card.
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-1.5">
              {['ls', 'git status', 'node -v'].map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => window.api.ptyInput({ id: terminalId, data: `${c}\r` })}
                  className="rounded-lg border border-black/[0.08] px-2.5 py-1 font-mono text-[11px] text-ink-label transition-all hover:brightness-[0.98] hover:text-ink"
                  style={{ background: SHEEN_BG, boxShadow: SHEEN_SHADOW }}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="space-y-2.5 pb-3">
          {buildTimeline().map((row) =>
            row.kind === 'ai' ? (
              <AiSessionCard
                key={`ai-${row.turn.id}`}
                items={row.turn.items}
                phase={row.turn.live ? aiPhase : 'done'}
                context={row.turn.items.find((i) => i.ctx)?.ctx ?? ''}
                live={row.turn.live}
                onDecide={onAiProposal}
                onEnd={onAiEnd}
                onUndo={onAiUndo}
                restorePoints={aiRestorePoints}
                onRunPlan={onAiRunPlan}
                onCancelPlan={onAiCancelPlan}
              />
            ) : (
              row.node
            ),
          )}
        </div>
      </div>


      {/* Command bar — types into the same shell the Raw view shows. The
          bottom margin keeps it above the floating chat panel. */}
      <form onSubmit={send} className="w-full max-w-[1200px] px-6 pb-4 pt-1">
        {pending && (
          <p className="px-3 pb-1 text-[11px] text-ink-hint">
            Stopping {runningName || 'the running command'}, then running{' '}
            <span className="font-mono">{pending.cmd}</span>
          </p>
        )}
        {/* ONE board. In command mode it's just the input row; when the AI
            is called, the session (header, log) and the input share this
            single surface — one interface, one identity. */}
        <div
          className="relative rounded-xl border border-black/[0.08]"
          style={{ background: SHEEN_BG, boxShadow: CARD_SHADOW }}
        >
          {/* Tab-completion candidates: a frosted panel floating above the
              bar (no layout shift), easing in. Tab cycles, Esc restores,
              click picks. Only shown while there's a real choice. */}
          {completion && completion.candidates.length > 1 && (
            <div
              className="absolute bottom-full left-0 right-0 z-30 mb-2 animate-pane-in rounded-xl border border-black/[0.08] px-2.5 py-2"
              style={{
                background: 'rgba(255,255,255,0.72)',
                backdropFilter: 'blur(12px)',
                boxShadow: CARD_SHADOW,
              }}
            >
              <div className="flex flex-wrap items-center gap-1">
                {completion.candidates.map((c, i) => (
                  <button
                    key={c}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      applyCompletion(completion, i);
                    }}
                    className={`max-w-[340px] truncate rounded-md border px-2 py-1 font-mono text-[11px] transition-colors ${
                      i === completion.index
                        ? 'border-[#2E5FA3]/40 bg-white text-ink'
                        : 'border-transparent text-ink-label hover:bg-white/70 hover:text-ink'
                    }`}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>
          )}
          {/* The model menu for the AI chip: same list as the AI terminal's
              picker, floating in the same frosted style. */}
          {brainMenu !== 'closed' && (
            <div
              // Anchored to whichever control opened it: the Call AI button
              // on the right in command mode, the model pill on the left
              // once the AI is in.
              className={`absolute bottom-full z-30 mb-2 max-h-72 w-64 animate-pane-in overflow-y-auto rounded-xl border border-black/[0.08] p-1.5 ${
                brainMenu === 'start' ? 'right-0' : 'left-0'
              }`}
              style={{
                background: 'rgba(255,255,255,0.85)',
                backdropFilter: 'blur(12px)',
                boxShadow: CARD_SHADOW,
              }}
            >
              <p className="px-2 pb-1 pt-0.5 text-[9px] font-semibold uppercase tracking-wide text-ink-micro">
                {brainMenu === 'start' ? 'Pick who joins' : 'Choose a model'}
              </p>
              {brains.map((b) => {
                const cur = readBrain();
                const active = cur.model === b.model && cur.engine === b.engine;
                return (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => pickBrain(b)}
                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11.5px] transition-colors ${
                      active
                        ? 'bg-[#7A4FA3]/10 text-ink'
                        : 'text-ink-label hover:bg-black/[0.04] hover:text-ink'
                    }`}
                  >
                    {BRAIN_PROVIDER_PNGS[b.provider] ? (
                      <img
                        src={BRAIN_PROVIDER_PNGS[b.provider]}
                        alt=""
                        aria-hidden="true"
                        className="h-3.5 w-3.5 rounded-sm"
                      />
                    ) : (
                      <span className="h-3.5 w-3.5 rounded-sm bg-black/10" aria-hidden="true" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{b.label}</span>
                    <span className="text-[9px] uppercase tracking-wide text-ink-micro">
                      {b.tier}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {/* The block this conversation is about, shown the moment Ask AI
              is pressed — before anything is typed — so it's obvious which
              command the AI is looking at, and that you're in that mode.
              Clearing it keeps the AI here but drops the reference. */}
          {aiActive && aiContext && (
            <div className="flex items-start gap-2 border-b border-black/[0.05] px-3 py-2">
              <span
                aria-hidden="true"
                className="mt-[3px] h-3.5 w-[2px] shrink-0 rounded-full bg-[#7A4FA3]/50"
              />
              <div className="min-w-0 flex-1">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-micro">
                  Asking about
                </div>
                <div className="truncate font-mono text-[11.5px] text-[#3A3A3A]">
                  {aiContext}
                </div>
              </div>
              <button
                type="button"
                onClick={onAiClearContext}
                aria-label="Stop asking about this command"
                title="Stop asking about this command"
                className="mt-[1px] flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-ink-label transition-colors hover:bg-black/[0.05] hover:text-ink"
              >
                <svg
                  viewBox="0 0 14 14"
                  className="h-3 w-3"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="M3 3l8 8M11 3l-8 8" />
                </svg>
              </button>
            </div>
          )}
          {/* What's attached to the next message. */}
          {aiActive && attachment && (
            <div className="flex items-center gap-2 border-b border-black/[0.05] px-3 py-1.5">
              <img
                src={attachment.dataUrl}
                alt=""
                className="h-8 w-8 rounded-md border border-hairline object-cover"
              />
              <span className="min-w-0 flex-1 truncate text-[11px] text-ink-label">
                {attachment.name}
              </span>
              <button
                type="button"
                onClick={() => setAttachment(null)}
                className="text-[10px] text-ink-hint transition-colors hover:text-ink"
              >
                Remove
              </button>
            </div>
          )}
          <div className="flex items-center gap-2 px-3 py-2">
          {/* Folder browser — jumps the shell to any folder without typing
              the path. Wrapper is relative so the picker floats above it. */}
          <div ref={pickerWrapRef} className="relative z-20 shrink-0">
            {pickerOpen && <PathPicker initialPath={cwd || null} onPick={goToFolder} />}
            <button
              type="button"
              onClick={() => setPickerOpen((o) => !o)}
              aria-label={cwd ? `Browse folders. Currently in ${cwd}` : 'Browse folders'}
              aria-expanded={pickerOpen}
              title={cwd || 'Browse folders'}
              className={`flex h-6 max-w-[200px] items-center gap-1.5 rounded-md px-1.5 font-mono text-[11.5px] transition-colors ${
                pickerOpen
                  ? 'bg-black/[0.06] text-ink'
                  : 'text-ink-label hover:bg-black/[0.05] hover:text-ink'
              }`}
            >
              <svg
                viewBox="0 0 18 18"
                className="h-4 w-4 shrink-0"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M2 4.5h5l1.7 2H16v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
              </svg>
              {label && <span className="truncate">{label}</span>}
            </button>
          </div>
          {/* The AI presence chip: while a session is active the bar
              belongs to the conversation, and this says so — model icon,
              a working/settled dot, and the way out. */}
          {/* In AI mode the SAME bar gains two controls: which model is
              answering, and an attachment. Everything else stays put. */}
          {aiActive && (
            <>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  toggleBrainMenu();
                }}
                title="Change model"
                className="flex shrink-0 items-center gap-1.5 rounded-md border border-hairline bg-white/70 px-2 py-1 text-[10.5px] font-medium text-ink transition-colors hover:border-[#7A4FA3]/40 hover:bg-white"
              >
                {BRAIN_PROVIDER_PNGS[readBrain().provider] && (
                  <img
                    src={BRAIN_PROVIDER_PNGS[readBrain().provider]}
                    alt=""
                    aria-hidden="true"
                    className="h-3.5 w-3.5 rounded-sm"
                  />
                )}
                <span className="max-w-[120px] truncate">{readBrain().label}</span>
                <svg
                  viewBox="0 0 10 6"
                  className="h-1.5 w-2.5 text-ink-hint"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M1 1l4 4 4-4" />
                </svg>
              </button>
              {/* Plan first: one approval for the whole job instead of a
                  decision per step. */}
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onAiPlanMode(!aiPlanMode);
                }}
                aria-pressed={aiPlanMode}
                title={
                  aiPlanMode
                    ? 'Plan first: the whole plan is shown for one approval'
                    : 'Plan first: see every step before anything runs'
                }
                className={`shrink-0 rounded-md border px-2 py-0.5 text-[10.5px] font-medium transition-colors ${
                  aiPlanMode
                    ? 'border-[#7A4FA3]/40 bg-white text-ink'
                    : 'border-hairline text-ink-hint hover:bg-white/70 hover:text-ink'
                }`}
              >
                Plan
              </button>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  fileInputRef.current?.click();
                }}
                aria-label="Attach an image"
                title="Attach an image"
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors ${
                  attachment
                    ? 'bg-[#7A4FA3]/10 text-[#7A4FA3]'
                    : 'text-ink-label hover:bg-black/[0.05] hover:text-ink'
                }`}
              >
                <svg
                  viewBox="0 0 18 18"
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M13.5 8.5l-4.6 4.6a3 3 0 0 1-4.2-4.2l5.6-5.6a2 2 0 0 1 2.8 2.8l-5.6 5.6a1 1 0 0 1-1.4-1.4l5-5" />
                </svg>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void attachFile(file);
                }}
              />
            </>
          )}
          <span
            aria-hidden="true"
            className={`font-mono text-[13px] ${aiActive ? 'text-[#7A4FA3]' : 'text-[#3E7A53]'}`}
          >
            ❯
          </span>
          <textarea
            ref={barRef}
            rows={1}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              // Typing invalidates completion cycling, history position,
              // and any in-flight directory listing.
              setCompletion(null);
              completionSeq.current++;
              histPosRef.current = null;
            }}
            onKeyDown={onKeyDown}
            placeholder={
              aiActive
                ? `Message ${readBrain().label}`
                : running
                  ? `Run a command (stops ${runningName || 'the current one'} first). Reply to it inside its card.`
                  : 'Run a command'
            }
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            // Grows with the text (capped), so one-liners look exactly as
            // they did and a pasted block is fully visible.
            style={{ height: barHeight, resize: 'none' }}
            className="min-w-0 flex-1 overflow-y-auto bg-transparent font-mono text-[13px] leading-[1.5] text-[#3A3A3A] outline-none placeholder:text-ink-micro"
          />
          {/* One-click completion for the things everyone reaches for:
              each is identical to typing the text and pressing Tab (or
              Ctrl+R for `recent`). Always visible, and TOGGLES: pressing
              again while the panel is open closes it. Hidden while the AI
              has the bar. */}
          {/* Call the AI into the terminal. Choosing a model in the menu
              this opens is what actually starts the session. */}
          {!aiActive && (
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                openCallAi();
              }}
              aria-pressed={brainMenu === 'start'}
              title="Call the AI into this terminal"
              className={`flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-[10.5px] font-medium transition-colors duration-200 ${
                brainMenu === 'start'
                  ? 'border-[#7A4FA3]/40 bg-white text-ink'
                  : 'border-hairline text-[#7A4FA3] hover:bg-white/70'
              }`}
            >
              <span aria-hidden="true">✦</span>
              Call AI
            </button>
          )}
          {/* Leaving AI mode: same place the quick buttons sit in command
              mode, so the row's shape never jumps. */}
          {aiActive && (
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onAiEnd();
              }}
              aria-label="End the AI session"
              title="End the AI session (Esc)"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-label transition-colors hover:bg-black/[0.05] hover:text-ink"
            >
              <svg
                viewBox="0 0 14 14"
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M3 3l8 8M11 3l-8 8" />
              </svg>
            </button>
          )}
          {!aiActive && QUICK_BUTTONS.map((b) => (
            <button
              key={b.label}
              type="button"
              aria-pressed={!!completion}
              onMouseDown={(e) => {
                e.preventDefault();
                quickComplete(b.insert);
              }}
              title={
                completion
                  ? 'Close suggestions'
                  : b.insert === ''
                    ? 'Browse recent commands (Ctrl+R)'
                    : `Complete ${b.label}`
              }
              className={`shrink-0 rounded-md border px-1.5 py-0.5 font-mono text-[10.5px] transition-colors duration-200 ${
                completion
                  ? 'border-[#2E5FA3]/40 bg-white text-ink'
                  : 'border-hairline text-ink-hint hover:bg-white/70 hover:text-ink'
              }`}
            >
              {b.label}
            </button>
          ))}
          </div>
        </div>
      </form>
    </div>
  );

  // One command card. Unchanged from when it lived inline in the map —
  // only its home moved, so the timeline can interleave it with AI turns.
  function renderBlock(b: TerminalBlockData) {
            const isRunning = b.endedAt === null;
            // A running command that has gone quiet is waiting on the user,
            // not working. Saying which is the difference between "is this
            // stuck?" and "oh, it wants something from me".
            const isWaiting = isRunning && tick - b.lastOutputAt > WAITING_AFTER_MS;
            const replies = isWaiting ? suggestedReplies(b.lines, b.partial) : [];
            // Keystroke tables ([Y] Yes [A] Yes to All ...) are instructions
            // for typing letters. The buttons ARE the choices, so the table
            // never renders. Menus can arrive glued to real content (echoed
            // answers, reprints), so each line is stripped, not just hidden;
            // lines that were only menu disappear, genuine blanks stay.
            const cleaned: string[] = [];
            for (const l of b.lines) {
              const s = stripChoiceGuide(l);
              if (s !== '' || l.trim() === '') cleaned.push(s);
            }
            const output = cleaned.join('\n');
            const shownPartial = stripChoiceGuide(b.partial);
            return (
              <div
                key={b.id}
                className="group overflow-hidden rounded-xl border border-black/[0.08]"
                style={{ background: SHEEN_BG, boxShadow: CARD_SHADOW }}
              >
                <div className="flex items-center gap-2 border-b border-black/[0.04] px-3 py-1.5">
                  {/* Who typed this into the shared terminal: the model's
                      icon when the AI did, the plain prompt glyph when the
                      user did. */}
                  {b.byAi ? (
                    <img
                      src={BRAIN_PROVIDER_PNGS[readBrain().provider]}
                      alt="Run by the AI"
                      title="Run by the AI"
                      className="h-3.5 w-3.5 shrink-0 rounded-sm"
                    />
                  ) : (
                    <span aria-hidden="true" className="font-mono text-[12px] text-[#3E7A53]">
                      ❯
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] font-medium text-[#3A3A3A]">
                    {b.command}
                  </span>
                  {isRunning ? (
                    <>
                      {isWaiting ? (
                        <span className="flex items-center gap-1 font-mono text-[10px] text-[#2E5FA3]">
                          <span className="h-1.5 w-1.5 rounded-full bg-[#2E5FA3]" aria-hidden="true" />
                          waiting for input
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 font-mono text-[10px] text-amber-600">
                          <span
                            className="h-1.5 w-1.5 animate-flicker rounded-full bg-amber-500"
                            aria-hidden="true"
                          />
                          running
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          onStopped({ reason: 'stop' });
                          window.api.ptyStopForeground({
                            id: terminalId,
                            cwd: cwd || undefined,
                          });
                        }}
                        className="rounded-md border border-hairline px-2 py-0.5 text-[10px] font-medium text-ink-hint hover:text-[#3A3A3A]"
                      >
                        Stop
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="font-mono text-[10px] text-ink-micro">
                        {fmtTime(b.startedAt)}
                      </span>
                      <span className="opacity-0 transition-opacity group-hover:opacity-100">
                        <CopyButton
                          text={output || b.command}
                          variant="inline"
                          label="Copy"
                        />
                      </span>
                      {/* Call the AI into the room about THIS command —
                          always visible, wearing the current model's icon. */}
                      <button
                        type="button"
                        onClick={() => onAiCall(b)}
                        title="Ask the AI about this command"
                        className="flex shrink-0 items-center gap-1.5 rounded-md border border-hairline px-2 py-0.5 text-[10.5px] font-medium text-ink-label transition-colors hover:border-[#7A4FA3]/40 hover:bg-white hover:text-ink"
                      >
                        {BRAIN_PROVIDER_PNGS[readBrain().provider] && (
                          <img
                            src={BRAIN_PROVIDER_PNGS[readBrain().provider]}
                            alt=""
                            aria-hidden="true"
                            className="h-3.5 w-3.5 rounded-sm"
                          />
                        )}
                        Ask AI
                      </button>
                    </>
                  )}
                </div>
                {(output || isRunning || !b.truncated) && (
                  <div className="max-h-96 overflow-y-auto px-3 py-2 font-mono text-[12px] leading-[1.55] text-[#3A3A3A]">
                    {/* Output, best source first: the LIVE grid while the
                        command runs (exact rendering, click to type), the
                        frozen colored snapshot once it's done, and the
                        plain-text pipeline as the fallback for blocks
                        that predate the surface or went interactive. */}
                    {isRunning && !b.interactive ? (
                      <div
                        onMouseDown={surfaceFocus}
                        className="cursor-text overflow-x-auto rounded-md"
                      >
                        <div ref={surfaceMount} className="overflow-hidden" />
                      </div>
                    ) : b.snapshotHtml && !isRunning ? (
                      <pre
                        className="overflow-x-auto whitespace-pre font-mono"
                        // Built by our own serializer from terminal cells,
                        // content HTML-escaped there.
                        dangerouslySetInnerHTML={{ __html: b.snapshotHtml }}
                      />
                    ) : (
                      <>
                        {b.truncated && (
                          <p className="text-ink-micro">… earlier output trimmed</p>
                        )}
                        {output ? (
                          <pre className="whitespace-pre-wrap break-words font-mono">{output}</pre>
                        ) : !isRunning ? (
                          <span className="text-ink-micro">(no output)</span>
                        ) : null}
                        {isRunning && shownPartial && (
                          <p className="whitespace-pre-wrap break-words text-ink-hint">{shownPartial}</p>
                        )}
                      </>
                    )}
                    {/* Talking to the running program happens INSIDE its
                        card: chips for replies it offered, and a free-form
                        input. The bottom bar always means "run a command". */}
                    {isWaiting && (
                      <div className="mt-2 flex flex-wrap items-center gap-1">
                        {replies.map((r) => (
                          <button
                            key={r.label}
                            type="button"
                            onClick={() =>
                              window.api.ptyInput({ id: terminalId, data: r.send })
                            }
                            className={`rounded-lg border px-2 py-1 text-[10.5px] transition-all hover:brightness-[0.97] ${
                              r.recommended
                                ? 'border-[#2E5FA3]/30 font-medium text-ink'
                                : 'border-white/70 text-ink-label hover:text-ink'
                            }`}
                            style={{ background: 'rgba(255,255,255,0.7)', boxShadow: SHEEN_SHADOW }}
                          >
                            {r.label}
                            {r.recommended && (
                              <span className="ml-1 text-[9px] font-normal text-[#2E5FA3]">
                                recommended
                              </span>
                            )}
                          </button>
                        ))}
                        <BlockReplyInput
                          programName={b.command.trim().split(/\s+/)[0] ?? ''}
                          onSend={(text) =>
                            window.api.ptyInput({ id: terminalId, data: `${text}\r` })
                          }
                          onSendRaw={(data) =>
                            window.api.ptyInput({ id: terminalId, data })
                          }
                        />
                      </div>
                    )}
                  </div>
                )}
                <BlockInsights
                  block={b}
                  onSendCommand={(cmd) => {
                    window.api.ptyInput({ id: terminalId, data: `${cmd}\r` });
                  }}
                  onAiFix={() => onAiFix(b)}
                />
              </div>
            );
  }

  function buildTimeline() {
    const turns: { id: string; at: number; items: AiItem[]; first: boolean; live: boolean }[] = [];
    for (const it of aiItems) {
      const startsTurn = it.from === 'user' || turns.length === 0;
      if (startsTurn) {
        turns.push({
          id: it.id,
          at: it.at,
          items: [it],
          first: turns.length === 0,
          live: false,
        });
      } else {
        turns[turns.length - 1].items.push(it);
      }
    }
    // Only the newest exchange is live, and only while the AI still has
    // the bar — once you leave AI mode every card is settled history.
    if (aiActive && turns.length > 0) turns[turns.length - 1].live = true;
    return [
      // A command the AI ran belongs to its exchange, not beside it: its
      // output is on the proposal row's toggle, so showing the block too
      // duplicated every answer. It still runs in the real shell.
      ...blocks
        .filter((b) => !b.byAi)
        .map((b) => ({ kind: 'block' as const, at: b.startedAt, node: renderBlock(b) })),
      ...turns.map((t) => ({ kind: 'ai' as const, at: t.at, turn: t })),
    ].sort((a, z) => a.at - z.at);
  }
}

// The way back from a command that changed things. Verlox saves a restore
// point before every such command the AI runs; this spends it. Asks once
// before rewinding, because a rewind moves the whole guarded folder.
function UndoStep({
  command,
  available,
  onUndo,
}: {
  command: string;
  // False when no restore point was captured (no guarded folder, or git
  // unavailable). Offering undo we can't honour is worse than not offering.
  available: boolean;
  onUndo: (command: string) => Promise<{ ok: boolean; message: string }>;
}) {
  const [state, setState] = useState<'idle' | 'confirm' | 'working' | 'done' | 'error'>(
    'idle',
  );
  const [message, setMessage] = useState('');
  if (!available && state === 'idle') return null;

  if (state === 'done') {
    return (
      <div
        className="mt-1.5 flex items-start gap-2 rounded-lg border border-[#3E7A53]/25 px-2.5 py-1.5"
        style={{ background: 'rgba(255,255,255,0.7)' }}
      >
        <span
          className="mt-[1px] flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[#3E7A53] text-[9px] font-bold text-white"
          aria-hidden="true"
        >
          ✓
        </span>
        <p className="text-[11.5px] leading-snug text-[#3A3A3A]">
          <span className="font-medium text-[#3E7A53]">{message}</span>{' '}
          <span className="text-ink-hint">
            The rewind is itself a restore point, so you can put it back from the
            Timeline.
          </span>
        </p>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div
        className="mt-1.5 flex items-start gap-2 rounded-lg border border-[#B4322B]/25 px-2.5 py-1.5"
        style={{ background: 'rgba(255,255,255,0.7)' }}
      >
        <span
          className="mt-[1px] flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[#B4322B] text-[9px] font-bold text-white"
          aria-hidden="true"
        >
          !
        </span>
        <p className="text-[11.5px] leading-snug text-[#3A3A3A]">{message}</p>
      </div>
    );
  }

  if (state === 'working') {
    return (
      <p className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-ink-hint">
        <span
          className="h-1.5 w-1.5 animate-flicker rounded-full bg-[#B4632F]"
          aria-hidden="true"
        />
        Putting everything back…
      </p>
    );
  }

  if (state === 'confirm') {
    return (
      <div
        className="mt-1.5 rounded-lg border border-[#B4632F]/25 px-2.5 py-2"
        style={{ background: 'rgba(255,255,255,0.7)' }}
      >
        <p className="text-[11.5px] leading-snug text-[#3A3A3A]">
          Put the protected folder back to how it was before this command?
        </p>
        <p className="mt-0.5 text-[11px] leading-snug text-ink-hint">
          Everything that changed since then is undone. This is reversible.
        </p>
        <div className="mt-1.5 flex gap-1.5">
          <button
            type="button"
            onClick={async () => {
              setState('working');
              const res = await onUndo(command);
              setMessage(res.message);
              setState(res.ok ? 'done' : 'error');
            }}
            className="rounded-md border border-[#B4632F]/40 px-2.5 py-1 text-[11px] font-semibold text-[#B4632F] transition-all hover:brightness-[0.97]"
            style={{ background: 'rgba(255,255,255,0.9)', boxShadow: SHEEN_SHADOW }}
          >
            Yes, undo it
          </button>
          <button
            type="button"
            onClick={() => setState('idle')}
            className="rounded-md border border-hairline px-2.5 py-1 text-[11px] text-ink-label transition-all hover:text-ink"
            style={{ background: 'rgba(255,255,255,0.6)' }}
          >
            Keep changes
          </button>
        </div>
      </div>
    );
  }

  // Undo is the promise the whole product rests on — it reads as a real
  // control, not a footnote.
  return (
    <button
      type="button"
      onClick={() => setState('confirm')}
      title="Put the protected folder back to how it was before this command"
      className="mt-1.5 flex items-center gap-1.5 rounded-md border border-[#B4632F]/25 px-2 py-1 text-[10.5px] font-medium text-[#B4632F] transition-all hover:brightness-[0.97]"
      style={{ background: 'rgba(255,255,255,0.75)', boxShadow: SHEEN_SHADOW }}
    >
      <svg
        viewBox="0 0 16 16"
        className="h-3.5 w-3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M3 8a5 5 0 1 0 1.6-3.7M3 3v3h3" />
      </svg>
      Undo this
    </button>
  );
}

// The whole plan, laid out for one approval. Every step is visible before
// anything runs, with its file diff when it writes one, and each step
// reports its own outcome as the plan executes.
function PlanCard({
  item,
  onRun,
  onCancel,
  onUndo,
  restorePoints,
}: {
  item: AiItem;
  onRun: () => void;
  onCancel: () => void;
  onUndo: (command: string) => Promise<{ ok: boolean; message: string }>;
  restorePoints: Record<string, string>;
}) {
  const plan = item.plan;
  const [openStep, setOpenStep] = useState<Record<number, boolean>>({});
  if (!plan) return null;
  const awaiting = plan.state === 'awaiting';
  const runnable = plan.steps.filter((s) => s.status !== 'blocked').length;
  const blocked = plan.steps.filter((s) => s.status === 'blocked');
  return (
    <div className="rounded-lg border border-black/[0.06] bg-white/50 p-2.5">
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-micro">
          Plan
        </span>
        <span className="text-[10px] text-ink-hint">
          {plan.steps.length} step{plan.steps.length === 1 ? '' : 's'}
          {plan.estimate ? ` · ${plan.estimate}` : ''}
        </span>
        {plan.state === 'running' && (
          <span className="flex items-center gap-1 text-[10px] text-[#7A4FA3]">
            <span className="h-1.5 w-1.5 animate-flicker rounded-full bg-[#7A4FA3]" aria-hidden="true" />
            running
          </span>
        )}
        {plan.state === 'cancelled' && (
          <span className="text-[10px] text-ink-micro">cancelled</span>
        )}
      </div>
      {plan.summary && (
        <p className="mb-2 text-[12px] leading-relaxed text-[#3A3A3A]">{plan.summary}</p>
      )}
      <ol className="space-y-1.5">
        {plan.steps.map((s, i) => (
          <li key={`${s.command}-${i}`} className="flex gap-2">
            <span className="mt-0.5 w-4 shrink-0 text-right font-mono text-[10px] text-ink-micro">
              {i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <code
                  className={`rounded bg-white/70 px-1.5 py-0.5 font-mono text-[11.5px] ${
                    s.status === 'blocked' || s.status === 'skipped'
                      ? 'text-ink-micro line-through'
                      : 'text-[#3A3A3A]'
                  }`}
                >
                  {s.command}
                </code>
                {s.status === 'running' && (
                  <span className="text-[10px] text-[#7A4FA3]">running</span>
                )}
                {s.status === 'ran' && <span className="text-[10px] text-[#3E7A53]">ran</span>}
                {s.status === 'failed' && (
                  <span className="text-[10px] text-[#B4322B]">
                    failed{s.exitCode != null ? ` (exit ${s.exitCode})` : ''}
                  </span>
                )}
                {s.status === 'skipped' && (
                  <span className="text-[10px] text-ink-micro">not reached</span>
                )}
                {s.status === 'blocked' && (
                  <span className="text-[10px] text-[#B4632F]">
                    blocked — “{s.blockedLabel}” is set to never
                  </span>
                )}
                {(s.output !== undefined || s.before !== undefined) && (
                  <button
                    type="button"
                    onClick={() => setOpenStep((o) => ({ ...o, [i]: !o[i] }))}
                    className="text-[10px] text-ink-hint transition-colors hover:text-ink"
                  >
                    {openStep[i] ? 'hide' : s.output !== undefined ? 'output' : 'changes'}
                  </button>
                )}
              </div>
              {s.reason && awaiting && (
                <p className="mt-0.5 text-[11px] leading-snug text-ink-hint">{s.reason}</p>
              )}
              {openStep[i] && s.output !== undefined && (
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-white/70 px-2 py-1.5 font-mono text-[11px] leading-[1.5] text-[#3A3A3A]">
                  {s.output.trim() || '(no output)'}
                </pre>
              )}
              {/* Same restore point every changing command saves, spendable
                  from the plan too. */}
              {s.status === 'ran' &&
                assessCommand(s.command).capability !== 'read' &&
                assessCommand(s.command).capability !== 'inspect' && (
                  <UndoStep
                    command={s.command}
                    available={!!restorePoints[s.command]}
                    onUndo={onUndo}
                  />
                )}
              {/* Current-vs-proposed for a step that writes a known file. */}
              {(openStep[i] || awaiting) && s.preview !== undefined && s.path && (
                <div className="mt-1 overflow-hidden rounded-md border border-black/[0.06]">
                  <div className="flex items-center gap-1.5 border-b border-black/[0.05] bg-white/60 px-2 py-1">
                    <span className="font-mono text-[10px] text-ink-label">{s.path}</span>
                    <span className="text-[9px] uppercase tracking-wide text-ink-micro">
                      {s.beforeExists ? 'changes' : 'new file'}
                    </span>
                  </div>
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words px-2 py-1.5 font-mono text-[11px] leading-[1.5] text-[#3E7A53]">
                    {s.preview}
                  </pre>
                  {s.beforeExists && s.before ? (
                    <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words border-t border-black/[0.05] px-2 py-1.5 font-mono text-[11px] leading-[1.5] text-ink-micro line-through">
                      {s.before}
                    </pre>
                  ) : null}
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
      {blocked.length > 0 && awaiting && (
        <p className="mt-2 text-[11px] leading-snug text-[#B4632F]">
          {blocked.length} step{blocked.length === 1 ? '' : 's'} won’t run: your settings
          never allow them. The rest can still go ahead.
        </p>
      )}
      {awaiting && (
        <div className="mt-2.5 flex gap-1.5">
          <button
            type="button"
            onClick={onRun}
            disabled={runnable === 0}
            className="rounded-md border border-[#3E7A53]/30 px-2.5 py-1 text-[11px] font-medium text-[#3E7A53] transition-all hover:brightness-[0.97] disabled:opacity-50"
            style={{ background: 'rgba(255,255,255,0.85)', boxShadow: SHEEN_SHADOW }}
          >
            Run {runnable} step{runnable === 1 ? '' : 's'}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-hairline px-2.5 py-1 text-[11px] text-ink-label transition-all hover:text-ink"
            style={{ background: 'rgba(255,255,255,0.6)', boxShadow: SHEEN_SHADOW }}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

// Wall-clock stamp for a settled exchange, matching the command cards.
function fmtClock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

// --- The AI transcript -----------------------------------------------------
// The conversation, rendered INSIDE the command bar's own board: a compact
// activity log, each proposal's Run/Skip inline, and the closing summary
// set apart when the work is done. The bar's controls (model picker,
// status, attach, close) live in the input row, so this is only the talk.
function AiSessionCard({
  items,
  phase,
  context,
  live,
  onDecide,
  onEnd,
  onUndo,
  restorePoints,
  onRunPlan,
  onCancelPlan,
}: {
  items: AiItem[];
  phase: 'thinking' | 'approval' | 'running' | 'done' | 'idle';
  context: string;
  // True for the newest exchange — the only one whose status can still
  // change, and the only one that offers a way out of the session.
  live: boolean;
  onDecide: (itemId: string, run: boolean) => void;
  onEnd: () => void;
  onUndo: (command: string) => Promise<{ ok: boolean; message: string }>;
  restorePoints: Record<string, string>;
  onRunPlan: (itemId: string) => void;
  onCancelPlan: (itemId: string) => void;
}) {
  // Whoever spoke in THIS exchange — not whoever is selected right now.
  const current = readBrain();
  const spoke = items.find((i) => i.from === 'ai' && i.brandLabel);
  const brain = {
    label: spoke?.brandLabel ?? current.label,
    provider: spoke?.brandProvider ?? current.provider,
  };
  const png = BRAIN_PROVIDER_PNGS[brain.provider];
  // The user's face in the conversation, same mark the sidebar shows.
  const { user } = useAuth();
  const userInitial = (user?.email?.charAt(0) ?? '?').toUpperCase();
  const summary =
    phase === 'done'
      ? [...items].reverse().find((i) => i.from === 'ai' && i.kind === 'message')
      : undefined;
  const log = summary ? items.filter((i) => i.id !== summary.id) : items;
  const statusText =
    phase === 'thinking'
      ? 'thinking'
      : phase === 'approval'
        ? 'waiting for your go-ahead'
        : phase === 'running'
          ? 'running a command'
          : phase === 'done'
            ? 'finished'
            : 'listening';
  // Which ran commands have their output expanded.
  const [openOutputs, setOpenOutputs] = useState<Record<string, boolean>>({});
  // The log grows downward but the card is docked; keep the newest visible.
  const logRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items.length, phase]);
  return (
    // A card in the timeline, same language as the command blocks around
    // it, with a live status header — so "is it working or did it stop?"
    // is never a question.
    <div
      className="overflow-hidden rounded-xl border border-black/[0.08]"
      style={{ background: SHEEN_BG, boxShadow: CARD_SHADOW }}
    >
      <div className="flex items-center gap-2 border-b border-black/[0.04] px-3 py-1.5">
        {png && <img src={png} alt="" className="h-3.5 w-3.5 shrink-0 rounded-sm" aria-hidden="true" />}
        <span className="shrink-0 text-[12px] font-medium text-[#3A3A3A]">{brain.label}</span>
        {context && (
          <span className="max-w-[280px] truncate rounded-md bg-white/60 px-1.5 py-0.5 font-mono text-[10px] text-ink-label">
            on {context}
          </span>
        )}
        {/* Only the newest exchange has a status that can still change, or
            a session to end. Older ones are settled history. */}
        {live ? (
          <>
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  phase === 'thinking' || phase === 'running'
                    ? 'animate-flicker bg-[#7A4FA3]'
                    : phase === 'approval'
                      ? 'bg-[#2E5FA3]'
                      : 'bg-[#3E7A53]'
                }`}
                aria-hidden="true"
              />
              <span className="font-mono text-[10px] text-ink-hint">{statusText}</span>
            </span>
            <button
              type="button"
              onClick={onEnd}
              className="shrink-0 rounded-md border border-hairline px-2 py-0.5 text-[10px] font-medium text-ink-hint transition-colors hover:text-[#3A3A3A]"
            >
              End
            </button>
          </>
        ) : (
          <span className="ml-auto shrink-0 font-mono text-[10px] text-ink-micro">
            {fmtClock(items[0]?.at ?? 0)}
          </span>
        )}
      </div>
      <div ref={logRef} className="max-h-[420px] space-y-2 overflow-y-auto px-3.5 py-2.5">
        {log.map((it) =>
          it.plan ? (
            <PlanCard
              key={it.id}
              item={it}
              onRun={() => onRunPlan(it.id)}
              onCancel={() => onCancelPlan(it.id)}
              onUndo={onUndo}
              restorePoints={restorePoints}
            />
          ) : it.kind === 'proposal' ? (
            <div key={it.id} className="py-0.5">
              <div className="flex flex-wrap items-center gap-1.5">
                {/* A ran command is a disclosure: open it to see exactly
                    what came back, without hunting for its block. */}
                {it.output !== undefined ? (
                  <button
                    type="button"
                    onClick={() =>
                      setOpenOutputs((o) => ({ ...o, [it.id]: !o[it.id] }))
                    }
                    aria-expanded={!!openOutputs[it.id]}
                    className="flex items-center gap-1.5 rounded bg-white/70 px-1.5 py-0.5 font-mono text-[11.5px] text-[#3A3A3A] transition-colors hover:bg-white"
                  >
                    <span
                      className="text-[8px] text-ink-micro transition-transform duration-200"
                      style={{
                        transform: openOutputs[it.id] ? 'rotate(90deg)' : 'rotate(0deg)',
                      }}
                      aria-hidden="true"
                    >
                      ▶
                    </span>
                    {it.command}
                  </button>
                ) : (
                  <code className="rounded bg-white/70 px-1.5 py-0.5 font-mono text-[11.5px] text-[#3A3A3A]">
                    {it.command}
                  </code>
                )}
                {it.status === 'accepted' && (
                  <span
                    className={`text-[10px] ${
                      it.exitCode !== undefined && it.exitCode !== null && it.exitCode !== 0
                        ? 'text-[#B4322B]'
                        : 'text-[#3E7A53]'
                    }`}
                  >
                    {it.output === undefined
                      ? 'running'
                      : it.exitCode !== null && it.exitCode !== 0
                        ? `failed (exit ${it.exitCode})`
                        : 'ran'}
                  </span>
                )}
                {it.status === 'skipped' && (
                  <span className="text-[10px] text-ink-micro">skipped</span>
                )}
                {it.status === 'pending' && (
                  <>
                    <button
                      type="button"
                      onClick={() => onDecide(it.id, true)}
                      className="rounded-md border border-[#3E7A53]/30 px-2 py-0.5 text-[10.5px] font-medium text-[#3E7A53] transition-all hover:brightness-[0.97]"
                      style={{ background: 'rgba(255,255,255,0.8)', boxShadow: SHEEN_SHADOW }}
                    >
                      Run
                    </button>
                    <button
                      type="button"
                      onClick={() => onDecide(it.id, false)}
                      className="rounded-md border border-hairline px-2 py-0.5 text-[10.5px] text-ink-label transition-all hover:text-ink"
                      style={{ background: 'rgba(255,255,255,0.6)', boxShadow: SHEEN_SHADOW }}
                    >
                      Skip
                    </button>
                  </>
                )}
              </div>
              {(it.text || it.risk) && it.status === 'pending' && (
                <p className={`mt-0.5 text-[11px] leading-snug ${it.risk ? 'text-[#B4632F]' : 'text-ink-hint'}`}>
                  {it.risk || it.text}
                </p>
              )}
              {openOutputs[it.id] && it.output !== undefined && (
                <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-white/60 px-2 py-1.5 font-mono text-[11px] leading-[1.5] text-[#3A3A3A]">
                  {it.output.trim() || '(no output)'}
                </pre>
              )}
              {/* A command that changed things saved a restore point first,
                  so there's a way back. */}
              {it.status === 'accepted' &&
                it.output !== undefined &&
                it.command &&
                assessCommand(it.command).capability !== 'read' &&
                assessCommand(it.command).capability !== 'inspect' && (
                  <UndoStep
                    command={it.command}
                    available={!!restorePoints[it.command]}
                    onUndo={onUndo}
                  />
                )}
            </div>
          ) : (
            // Speech, not log lines: the speaker is shown by face — your
            // avatar, the model's mark — and the words get room to read as
            // conversation.
            <div key={it.id} className="py-0.5">
              <div className="mb-1 flex items-center gap-1.5">
                {it.from === 'user' ? (
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[#3A3A3A] text-[8px] font-semibold text-white">
                    {userInitial}
                  </span>
                ) : (
                  BRAIN_PROVIDER_PNGS[it.brandProvider ?? brain.provider] && (
                    <img
                      src={BRAIN_PROVIDER_PNGS[it.brandProvider ?? brain.provider]}
                      alt=""
                      aria-hidden="true"
                      className="h-4 w-4 shrink-0 rounded-sm"
                    />
                  )
                )}
                <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-micro">
                  {it.from === 'user' ? 'You' : (it.brandLabel ?? brain.label)}
                </span>
              </div>
              <p
                className={`whitespace-pre-wrap text-[13px] leading-relaxed ${
                  it.from === 'user' ? 'text-ink-label' : 'text-[#3A3A3A]'
                }`}
              >
                {it.text}
              </p>
            </div>
          ),
        )}
        {summary && (
          <div className="mt-1 border-t border-black/[0.05] pt-2">
            {/* Still the model talking — the label says who, not what, so
                its opening remark and its conclusion read as one voice. */}
            <div className="mb-1 flex items-center gap-1.5">
              {png && (
                <img src={png} alt="" aria-hidden="true" className="h-4 w-4 shrink-0 rounded-sm" />
              )}
              <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-micro">
                {brain.label}
              </span>
              <span className="text-[9px] uppercase tracking-wide text-[#3E7A53]">
                answer
              </span>
            </div>
            <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-[#3A3A3A]">
              {summary.text}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// Free-form stdin for a waiting program, living inside its card so replying
// to node is visually distinct from running a shell command in the bottom
// bar. Sits alongside the reply chips.
//
// While EMPTY it also forwards arrow keys and bare Enter as raw bytes.
// That's the bridge into inquirer-style menus: the first arrow press makes
// the menu repaint, the repaint trips the in-place TUI detector, and the
// live terminal takes over with focus for the rest of the interaction.
const ARROW_BYTES: Record<string, string> = {
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
};

function BlockReplyInput({
  programName,
  onSend,
  onSendRaw,
}: {
  programName: string;
  onSend: (text: string) => void;
  onSendRaw: (data: string) => void;
}) {
  const [text, setText] = useState('');
  return (
    <input
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const t = text.trim();
          if (t) onSend(t);
          else onSendRaw('\r');
          setText('');
          return;
        }
        if (text === '' && ARROW_BYTES[e.key]) {
          e.preventDefault();
          onSendRaw(ARROW_BYTES[e.key]);
        }
      }}
      placeholder={programName ? `Reply to ${programName}` : 'Reply'}
      spellCheck={false}
      autoCapitalize="off"
      autoComplete="off"
      className="min-w-[140px] flex-1 rounded-lg border border-white/70 bg-white/50 px-2 py-1 font-mono text-[10.5px] text-ink outline-none placeholder:text-ink-micro focus:bg-white/80"
    />
  );
}
