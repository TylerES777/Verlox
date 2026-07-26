// Live-run store for the AI Terminal's activity pane. useCommands emits
// events as a confirmed plan executes; LiveActivityPane subscribes and
// renders the narration (during) and the summary (after). Module-level so
// the emitter (a hook) and the pane (a component) need no prop plumbing.
// One run at a time per app window — a new run replaces the last.
import { assessCommand, type RiskLevel } from '@shared/risk';

export interface LiveStep {
  title: string;
  command: string;
  // The model's own stated reason for this step (PlanStep.description) —
  // the narration text is the AI's real intent, not something invented.
  reason: string;
  risk: RiskLevel;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  exitCode: number | null;
  outputTail: string;
}

export interface TouchedFile {
  path: string;
  // Best-effort outcome from the step's risk capability + exit status.
  outcome: 'created' | 'edited' | 'moved' | 'deleted' | 'read' | 'touched';
  stepIndex: number;
}

export interface LiveRunState {
  // 'idle' = no pane. 'running' = narration layer. 'done' = summary layer
  // (stays until dismissed or a new run starts).
  phase: 'idle' | 'running' | 'done';
  goal: string;
  conversationId: string | null;
  steps: LiveStep[];
  currentIndex: number;
  files: TouchedFile[];
  startedAt: number;
  endedAt: number | null;
  // True when any step failed/cancelled (summary header wording).
  clean: boolean;
}

const initial: LiveRunState = {
  phase: 'idle',
  goal: '',
  conversationId: null,
  steps: [],
  currentIndex: -1,
  files: [],
  startedAt: 0,
  endedAt: null,
  clean: true,
};

let state: LiveRunState = initial;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

export function subscribeLiveRun(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getLiveRun(): LiveRunState {
  return state;
}

function outcomeFor(command: string, failed: boolean): TouchedFile['outcome'] {
  if (failed) return 'touched';
  const cap = assessCommand(command).capability;
  if (cap === 'delete') return 'deleted';
  if (cap === 'write') return /move-item|\bmv\b|\bmove\b|rename/i.test(command) ? 'moved' : 'edited';
  if (cap === 'config') return 'edited';
  if (cap === 'read' || cap === 'inspect') return 'read';
  return 'touched';
}

export function liveRunBegin(
  conversationId: string,
  goal: string,
  steps: { title: string; command: string; description: string }[],
): void {
  state = {
    phase: 'running',
    goal,
    conversationId,
    steps: steps.map((s) => ({
      title: s.title,
      command: s.command,
      reason: s.description,
      risk: assessCommand(s.command).level,
      status: 'queued',
      exitCode: null,
      outputTail: '',
    })),
    currentIndex: -1,
    files: [],
    startedAt: Date.now(),
    endedAt: null,
    clean: true,
  };
  notify();
}

export function liveRunStepStart(index: number): void {
  if (state.phase !== 'running' || !state.steps[index]) return;
  const steps = state.steps.slice();
  steps[index] = { ...steps[index], status: 'running' };
  state = { ...state, steps, currentIndex: index };
  notify();
}

export function liveRunStepDone(
  index: number,
  status: 'done' | 'failed' | 'cancelled',
  exitCode: number | null,
  output: string,
): void {
  if (state.phase !== 'running' || !state.steps[index]) return;
  const step = state.steps[index];
  const steps = state.steps.slice();
  steps[index] = { ...step, status, exitCode, outputTail: output.slice(-600) };
  const failed = status !== 'done';
  const newFiles = assessCommand(step.command)
    .files.filter((p) => !state.files.some((f) => f.path === p))
    .map((p) => ({ path: p, outcome: outcomeFor(step.command, failed), stepIndex: index }));
  state = {
    ...state,
    steps,
    files: [...state.files, ...newFiles],
    clean: state.clean && !failed,
  };
  notify();
}

export function liveRunEnd(): void {
  if (state.phase !== 'running') return;
  state = { ...state, phase: 'done', endedAt: Date.now() };
  notify();
}

export function liveRunDismiss(): void {
  state = initial;
  notify();
}

// The full record the "Explain what happened" model call narrates from.
export function liveRunRecord(): string {
  const lines: string[] = [`User's request: ${state.goal}`, ''];
  state.steps.forEach((s, i) => {
    lines.push(
      `Step ${i + 1}: ${s.title}`,
      `  Reason: ${s.reason}`,
      `  Command: ${s.command}`,
      `  Risk: ${s.risk} | Result: ${s.status}${s.exitCode !== null ? ` (exit ${s.exitCode})` : ''}`,
    );
    if (s.outputTail.trim()) lines.push(`  Output tail: ${s.outputTail.trim().slice(0, 300)}`);
  });
  if (state.files.length > 0) {
    lines.push('', 'Files/paths referenced:');
    for (const f of state.files) lines.push(`  ${f.path} (${f.outcome})`);
  }
  return lines.join('\n');
}
