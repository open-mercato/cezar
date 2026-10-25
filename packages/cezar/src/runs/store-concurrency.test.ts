import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { RunStore } from './store.ts';

const fixture = fileURLToPath(new URL('./fixtures/index-writer.mjs', import.meta.url));
const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function wait(dir: string, name: string) {
  for (let i = 0; i < 1000; i++) {
    if (existsSync(join(dir, name))) return;
    await sleep(10);
  }
  throw Error(`Timed out waiting for ${name}`);
}
function start(dir: string, id: string, operation: string, barrier: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', fixture, dir, id, operation, barrier], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let output = '';
  child.stdout!.on('data', chunk => { output += chunk; });
  child.stderr!.on('data', chunk => { output += chunk; });
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(Error(`writer ${id}: ${code}\n${output}`)));
  });
  // Attach immediately so a failed fixture does not cause an unhandled rejection.
  void done.catch(() => {});
  return { child, done };
}
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'cez-index-race-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'runs.json'), '[]');
  return dir;
}
const signal = (dir: string, name: string) => writeFileSync(join(dir, name), '');
const result = (dir: string, id: string) => JSON.parse(readFileSync(join(dir, `${id}-result.json`), 'utf8'));

for (const barrier of ['rename', 'read']) {
  for (const operation of ['strict', 'ordinary']) {
    it(`serializes ${operation} writers paused after ${barrier}, preserving both acknowledged runs`, async () => {
      const dir = setup();
      const a = start(dir, 'A', 'strict', barrier);
      const b = start(dir, 'B', operation, barrier);
      await Promise.all([wait(dir, 'A-ready'), wait(dir, 'B-ready')]);
      signal(dir, 'A-start');
      await wait(dir, 'A-paused');
      signal(dir, 'B-start');
      await wait(dir, 'B-attempt');
      // Give B time to reach the critical section while A is stopped at actual I/O.
      // Old code finishes B here. Fixed code cannot read/replace the index until A releases.
      await sleep(300);
      signal(dir, 'A-release');
      await a.done;
      signal(dir, 'B-release');
      await b.done;
      expect(result(dir, 'A').error).toBeUndefined();
      expect(result(dir, 'A').ids).toContain('A');
      expect(result(dir, 'B').error).toBeUndefined();
      expect(result(dir, 'B').ids).toContain('B');
      expect(JSON.parse(readFileSync(join(dir, 'runs.json'), 'utf8')).map((r: { id: string }) => r.id).sort()).toEqual(['A', 'B']);
    }, 20000);
  }
}

it('keeps a newer persisted record when a stale store flushes an unrelated change', () => {
  const dir = setup();
  const a = RunStore.open(dir, { keepLive: true });
  const first = a.createRun({ title: 'first', workflow: 'test', task: 'test', steps: [] });
  a.flush();
  const b = RunStore.open(dir, { keepLive: true });
  b.updateRun(first.id, { title: 'newer title' });
  b.flush();
  a.createRun({ title: 'second', workflow: 'test', task: 'test', steps: [] });
  a.flush();
  expect(RunStore.open(dir, { keepLive: true }).getRun(first.id)?.title).toBe('newer title');
});

it('reclaims a killed writer without stealing a live paused writer', async () => {
  const dir = setup();
  const a = start(dir, 'A', 'strict', 'rename');
  await wait(dir, 'A-ready');
  signal(dir, 'A-start');
  await wait(dir, 'A-paused');
  const b = start(dir, 'B', 'strict', 'rename');
  await wait(dir, 'B-ready');
  signal(dir, 'B-start');
  signal(dir, 'B-release');
  await sleep(150);
  expect(existsSync(join(dir, 'B-result.json'))).toBe(false);
  a.child.kill('SIGKILL');
  await a.done.catch(() => {});
  await b.done;
  expect(result(dir, 'B').error).toBeUndefined();
  expect(result(dir, 'B').ids).toContain('B');
}, 20000);

it('fails strictly on bounded contention and rolls back only the unpublished run', async () => {
  const dir = setup();
  const a = start(dir, 'A', 'strict', 'rename');
  const b = start(dir, 'B', 'strict', 'rename');
  await Promise.all([wait(dir, 'A-ready'), wait(dir, 'B-ready')]);
  signal(dir, 'A-start');
  await wait(dir, 'A-paused');
  // Even an ancient ticket belonging to a live PID must not be stolen (including PID reuse).
  const tickets = join(dir, 'runs', '.index-writers');
  if (existsSync(tickets)) {
    for (const ticket of readdirSync(tickets)) utimesSync(join(tickets, ticket), 1, 1);
  }
  signal(dir, 'B-start');
  signal(dir, 'B-release');
  await b.done;
  expect(result(dir, 'B').error).toContain('Could not persist');
  expect(result(dir, 'B').retained).toBe(false);
  signal(dir, 'A-release');
  await a.done;
  expect(result(dir, 'A').error).toBeUndefined();
  expect(result(dir, 'A').ids).toEqual(['A']);
}, 20000);

it('rolls back a strict rename failure, then permits a later writer', async () => {
  const dir = setup();
  const a = start(dir, 'A', 'fail', 'rename');
  await wait(dir, 'A-ready');
  signal(dir, 'A-start');
  signal(dir, 'A-release');
  await a.done;
  expect(result(dir, 'A').error).toContain('Could not persist');
  expect(result(dir, 'A').retained).toBe(false);
  const b = start(dir, 'B', 'strict', 'rename');
  await wait(dir, 'B-ready');
  signal(dir, 'B-start');
  signal(dir, 'B-release');
  await b.done;
  expect(result(dir, 'B').error).toBeUndefined();
  expect(result(dir, 'B').ids).toEqual(['B']);
}, 20000);

it('serializes simultaneous ticket selection by several real processes', async () => {
  const dir = setup();
  const ids = ['A', 'B', 'C', 'D', 'E', 'F'];
  const writers = ids.map(id => start(dir, id, 'strict', 'none'));
  await Promise.all(ids.map(id => wait(dir, `${id}-ready`)));
  for (const id of ids) signal(dir, `${id}-start`);
  await Promise.all(writers.map(writer => writer.done));
  for (const id of ids) {
    expect(result(dir, id).error).toBeUndefined();
    expect(result(dir, id).ids).toContain(id);
  }
  expect(JSON.parse(readFileSync(join(dir, 'runs.json'), 'utf8')).map((r: { id: string }) => r.id).sort()).toEqual(ids);
}, 20000);

it('keeps ordinary contention failures best effort without rolling back local state', async () => {
  const dir = setup();
  const a = start(dir, 'A', 'strict', 'rename');
  const b = start(dir, 'B', 'ordinary', 'rename');
  await Promise.all([wait(dir, 'A-ready'), wait(dir, 'B-ready')]);
  signal(dir, 'A-start');
  await wait(dir, 'A-paused');
  signal(dir, 'B-start');
  signal(dir, 'B-release');
  await b.done;
  expect(result(dir, 'B').error).toBeUndefined();
  expect(result(dir, 'B').retained).toBe(true);
  expect(result(dir, 'B').ids).not.toContain('B');
  signal(dir, 'A-release');
  await a.done;
  expect(result(dir, 'A').ids).toEqual(['A']);
}, 20000);

it('merges disjoint local fields and propagates field removal', () => {
  const dir = setup();
  const a = RunStore.open(dir, { keepLive: true });
  const run = a.createRun({ title: 'first', workflow: 'test', task: 'test', steps: [] });
  a.updateRun(run.id, { error: 'old error' });
  a.flush();
  const b = RunStore.open(dir, { keepLive: true });
  b.updateRun(run.id, { title: 'new title', error: undefined });
  b.flush();
  a.updateRun(run.id, { status: 'done' });
  a.flush();
  const saved = RunStore.open(dir, { keepLive: true }).getRun(run.id);
  expect(saved?.title).toBe('new title');
  expect(saved?.error).toBeUndefined();
  expect(saved?.status).toBe('done');
});

for (const failure of ['release', 'acquire']) {
  for (const nextWriter of ['owner', 'peer']) {
    it(`recovers ${nextWriter} writes after one transient ${failure} cleanup EIO`, async () => {
      const dir = setup();
      const a = start(dir, 'A', `${failure}-${nextWriter}`, 'none');
      await wait(dir, 'A-ready');
      signal(dir, 'A-start');
      await wait(dir, 'A-fault.json');
      const fault = JSON.parse(readFileSync(join(dir, 'A-fault.json'), 'utf8'));
      expect(fault.injected).toBe(true);
      expect(fault.tickets).toHaveLength(1);
      if (failure === 'release') {
        expect(result(dir, 'A').error).toBeUndefined();
        expect(result(dir, 'A').ids).toContain('A');
      } else {
        expect(result(dir, 'A').error).toContain('Could not persist');
        expect(result(dir, 'A').retained).toBe(false);
      }
      if (nextWriter === 'owner') {
        await a.done;
        expect(JSON.parse(readFileSync(join(dir, 'A-retry.json'), 'utf8')).error).toBeUndefined();
      } else {
        const b = start(dir, 'B', 'strict', 'none');
        await wait(dir, 'B-ready');
        signal(dir, 'B-start');
        await b.done;
        expect(result(dir, 'B').error).toBeUndefined();
        expect(a.child.exitCode).toBeNull();
        signal(dir, 'A-stop');
        await a.done;
      }
      const ids = JSON.parse(readFileSync(join(dir, 'runs.json'), 'utf8')).map((r: { id: string }) => r.id).sort();
      expect(ids).toEqual([
        ...(failure === 'release' ? ['A'] : []),
        nextWriter === 'owner' ? 'recovered' : 'B',
      ].sort());
      expect(readdirSync(join(dir, 'runs', '.index-writers'))).toEqual([]);
    }, 20000);
  }
}
