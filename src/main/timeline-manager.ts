import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assessCommand } from '@shared/risk';
import type { TimelineEvent, TimelineRecordInput } from '@shared/types';

// Timeline replay — an append-only, chronological log of every action the
// agent actually ran. The renderer sends the raw command/exit/cwd just after a
// step executes; we classify it (risk engine) + timestamp it here and persist
// to userData/timeline.json (capped to the most recent MAX_EVENTS).

const MAX_EVENTS = 500;

function filePath(): string {
  return join(app.getPath('userData'), 'timeline.json');
}

async function read(): Promise<TimelineEvent[]> {
  try {
    const raw = await fs.readFile(filePath(), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TimelineEvent[]) : [];
  } catch {
    return [];
  }
}

async function write(events: TimelineEvent[]): Promise<void> {
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(filePath(), JSON.stringify(events, null, 2), 'utf8');
}

export async function recordTimeline(input: TimelineRecordInput): Promise<void> {
  const a = assessCommand(input.command);
  const event: TimelineEvent = {
    id: randomUUID(),
    ts: Date.now(),
    command: input.command,
    capability: a.capability,
    level: a.level,
    label: a.label,
    files: a.files,
    exitCode: input.exitCode,
    cwd: input.cwd,
  };
  const events = await read();
  events.push(event);
  // Keep only the most recent MAX_EVENTS.
  await write(events.slice(-MAX_EVENTS));
}

export async function listTimeline(): Promise<TimelineEvent[]> {
  const events = await read();
  return events.sort((a, b) => b.ts - a.ts); // newest first
}

export async function clearTimeline(): Promise<void> {
  await write([]);
}
