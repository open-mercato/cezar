import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';

let dir: string;
let store: RunStore;
let manager: RunManager;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cez-error-cost-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  vi.stubEnv('CEZ_HOME', join(dir, 'home'));
  vi.stubEnv('CEZ_AUTONAME', '0');
  vi.stubEnv('CEZ_FOLLOWUPS', '0');
  vi.stubEnv('CEZ_DRY_RUN', '0');
  store = RunStore.open(join(dir, '.ai/cezar'));
  manager = new RunManager(store, dir, {
    semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 1 } }),
  });
});

afterEach(() => {
  manager?.dispose();
  store?.flush();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

it.each([
  ['initial', 2.5], ['continue', 2.5],
  ['initial', 0], ['continue', 0],
  ['initial', undefined], ['continue', undefined],
] as const)('preserves a reported cost of %s/%s after failure without completing the run', async (path, cost) => {
  const bin = join(dir, 'claude-fixture.mjs');
  writeFileSync(bin, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
emit({ type: 'system', subtype: 'init' });
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const failing = ${JSON.stringify(path)} === 'initial' || process.argv.includes('--resume');
  if (!failing) emit({type:'assistant',message:{content:[{type:'text',text:'Finished.\\nCEZ:DONE'}]}});
  emit({ type: 'result', subtype: 'success', is_error: failing,
    result: failing ? 'Provider failed after doing work' : 'Finished.',
    usage: { input_tokens: 10, output_tokens: 2 },
    ...(failing ? ${JSON.stringify(cost === undefined ? {} : { total_cost_usd: cost })} : { total_cost_usd: 1 }) });
  break;
}
`, { mode: 0o700 });
  vi.stubEnv('CEZ_CLAUDE_BIN', bin);
  const run = manager.startRun(
    { name: 'cost-test', source: 'built-in', steps: [{ id: 'task', name: 'Task', prompt: '{{task}}', runner: 'claude' }] },
    { task: 'work', worktree: false, runner: 'claude' },
  );
  if (path === 'continue') {
    await vi.waitFor(() => expect(run.status).toBe('done'), { timeout: 10000 });
    expect(run.costUsd).toBe(1);
    expect(manager.continueRun(run.id, { text: 'continue' })).toEqual({ ok: true });
  }
  await vi.waitFor(() => expect(run.status).toBe('failed'), { timeout: 10000 });
  const step = run.steps.at(-1);
  if (!step) throw new Error('Expected an executed step');
  expect(step.error).toContain('Provider failed after doing work');
  expect(step.costUsd).toBe(cost);
  const expected = path === 'continue' ? 1 + (cost ?? 0) : cost;
  expect(run.costUsd).toBe(expected);
  store.flush();
  expect(RunStore.open(join(dir, '.ai/cezar')).getRun(run.id)?.costUsd).toBe(expected);
  if (cost !== undefined) {
    const events = readFileSync(join(dir, '.ai/cezar/runs', `${run.id}.ndjson`), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line)).filter(event => event.stepId === step.id);
    expect(events.findIndex(event => event.type === 'error')).toBeLessThan(
      events.findIndex(event => event.type === 'cost'),
    );
  }
}, 20000);
