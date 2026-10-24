import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { resolveDeferredExecution } from '../automations/deferred-start.ts';
import { RunStore } from '../runs/store.ts';
import { loadWorkflows } from './load.ts';
import { RunManager } from './run.ts';

const exec = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

let root: string;
let store: RunStore;
let manager: RunManager | undefined;

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cez-node-model-')));
  vi.stubEnv('CEZ_DRY_RUN', '1');
  vi.stubEnv('CEZ_AGENT_MODELS_LOCKED', '0');
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: root });
  writeFileSync(join(root, '.gitignore'), '.ai/\n');
  await exec('git', ['add', '-A'], { cwd: root });
  await exec('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: root });
  mkdirSync(join(root, '.ai/cezar/workflows'), { recursive: true });
  store = RunStore.open(join(root, '.ai/cezar'));
});

afterEach(async () => {
  if (manager) {
    for (const { id } of store.listRuns()) manager.cancel(id);
    await expect.poll(() => store.listRuns().some(({ id }) => manager?.isActive(id)), { timeout: 10_000 }).toBe(false);
    manager.dispose();
    manager = undefined;
  }
  vi.unstubAllEnvs();
  store.flush();
  rmSync(root, { recursive: true, force: true });
});

function write(name: string, definition: object) {
  writeFileSync(join(root, '.ai/cezar/workflows', `${name}.yaml`), stringify({ name, ...definition }));
}

/**
 * A `workflow` graph node launches its child with the model the automation preview bound for it.
 * The node schema has no `model` of its own (a YAML one is stripped on load), so both sides take
 * the parent's model under dispatch()'s same-runner rule (43bdda11) — pinned here so the two stay
 * one answer.
 */
it('a workflow node launches its child on the model the preview bound', async () => {
  write('parent', {
    version: 2,
    nodes: [{ id: 'start', type: 'start' }, { id: 'sub', type: 'workflow', workflow: 'child', prompt: 'mock:done child', model: 'haiku' }],
    edges: [{ from: 'start', to: 'sub' }],
  });
  write('child', { steps: [{ id: 'work', prompt: '{{task}}' }] });
  const { workflows, issues } = await loadWorkflows(root);
  expect(issues).toEqual([]);
  const parent = workflows.find((w) => w.name === 'parent')!;

  const preview = await resolveDeferredExecution(root, { task: 'x', workflow: 'parent', runner: 'claude', model: 'opus' });
  const bound = preview.binding.models?.find((m) => m.step === 'sub/work');
  expect(bound).toMatchObject({ runner: 'claude', model: 'opus' });

  manager = new RunManager(store, root);
  const record = manager.startRun(parent, { task: 'x', runner: 'claude', model: 'opus', worktree: false });
  await expect.poll(() => store.listRuns().some((r) => r.dispatch?.parentRunId === record.id), { timeout: 20_000 }).toBe(true);
  const launched = store.listRuns().find((r) => r.dispatch?.parentRunId === record.id)!;
  expect({ runner: launched.runner, model: launched.model }).toEqual({ runner: bound!.runner, model: bound!.model });
}, 40_000);
