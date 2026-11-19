import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { AutomationStore } from './store.ts';
import { ScheduleRunner } from './schedule-runner.ts';
import type { ScheduleAutomationDefinition } from './types.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const schedule = { type: 'daily' as const, hour: 16 };
const input = { name: 'Shared', kind: 'schedule' as const, enabled: true, schedule,
  schedules: [schedule, { type: 'daily' as const, hour: 9 }], task: { prompt: 'Check the repo' } };
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'cez1818-redgreen-')); dirs.push(dir);
  return AutomationStore.open(dir);
}

it('#1818 an old client replacing schedule cannot leave hidden extra times firing', () => {
  const store = setup(); store.create(input, 'a');
  const { schedules: _, ...legacy } = input;
  const updated = store.update('a', 1, { ...legacy, schedule: { type: 'daily', hour: 12 } });
  expect(updated.schedules).toBeUndefined();
  expect(store.get('a')?.schedules).toBeUndefined();
});

it('#1818 the first due time includes an earlier secondary schedule', () => {
  const store = setup(); const definition = store.create(input, 'a') as ScheduleAutomationDefinition;
  const runner = new ScheduleRunner({ projectId: 'p', store, timeZone: 'UTC', now: () => Date.parse('2026-10-30T08:00:00Z') });
  expect(runner.dueAt(definition)).toBe(Date.parse('2026-10-30T09:00:00Z'));
});
