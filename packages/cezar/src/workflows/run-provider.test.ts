import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { putAgentFallbackPolicy } from '../workspace/agent-fallback.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';
import { readAgentProviderKey, readAgentProviders, type StoredAgentProviders } from '../workspace/agent-providers.ts';

vi.mock('../workspace/agent-providers.ts', () => ({ readAgentProviders: vi.fn(), readAgentProviderKey: vi.fn() }));
const gateway = { kind: 'custom' as const, addedAt: '', keyHint: '…1234', baseUrl: 'https://gateway.example',
  models: { fetchedAt: '', ids: [{ id: 'vendor/model' }] } };
const workflow: WorkflowDef = { name: 'provider-fixture', source: 'built-in', steps: [
  { id: 'first', name: 'First', prompt: '{{task}}' },
  { id: 'second', name: 'Second', runner: 'codex', prompt: '{{task}}' },
] };
let repo: string;
let store: RunStore;
let manager: RunManager;
let metadata: StoredAgentProviders;

beforeEach(() => {
  vi.stubEnv('CEZ_DRY_RUN', '1');
  vi.stubEnv('CEZ_AUTONAME', '0');
  repo = mkdtempSync(join(tmpdir(), 'cez-provider-workflow-'));
  for (const name of ['HOME', 'CEZ_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']) vi.stubEnv(name, repo);
  store = RunStore.open(join(repo, '.ai', 'cezar'));
  metadata = { agents: {} };
  vi.mocked(readAgentProviders).mockImplementation(async () => metadata);
  manager = new RunManager(store, repo);
});
afterEach(async () => {
  for (const run of store.listRuns()) if (manager.isActive(run.id)) manager.cancel(run.id);
  await vi.waitFor(() => expect(store.listRuns().some(run => manager.isActive(run.id))).toBe(false), { timeout: 5000 });
  manager.dispose();
  store.flush();
  rmSync(repo, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it('parks a mixed workflow before the unavailable step and retries that checkpoint after a restart', async () => {
  metadata.agents = { claude: { active: 'subscription', methods: {} }, codex: { active: null, methods: {} } };
  const { id } = manager.startRun(workflow, { task: 'mock:done', worktree: false, runner: 'claude', agentMethod: 'subscription' });
  await vi.waitFor(() => expect(store.getRun(id)).toMatchObject({ status: 'waiting', idleClosedAt: expect.any(String), currentStepId: 'second' }), { timeout: 10000 });
  const before = store.getRun(id)!;
  expect(before.error).toMatch(/No provider selected/);
  expect(before.agentMethod).toBe('subscription');
  expect(before.steps[0]).toMatchObject({ status: 'done', agentMethod: 'subscription' });
  expect(before.steps[1]?.sessionId).toBeUndefined();
  await vi.waitFor(() => expect(manager.isActive(id)).toBe(false));
  manager.dispose();
  store.flush();
  store = RunStore.open(join(repo, '.ai', 'cezar'));
  manager = new RunManager(store, repo);
  metadata.agents.codex = { active: 'custom', methods: { custom: gateway } };
  expect(manager.continueRun(id).ok).toBe(true);
  await vi.waitFor(() => expect(store.getRun(id)?.steps[1]?.agentMethod).toBe('custom'), { timeout: 10000 });
  expect(store.getRun(id)?.steps[0]?.iterations).toBe(1);
  expect(store.getRun(id)?.steps[1]?.modelIdentity).toBe('custom/vendor/model');
  expect(store.getRun(id)?.agentMethod).toBe('subscription');
}, 25000);

it('replays the saved gateway after active changes, then parks when it is removed', async () => {
  const entry = { active: 'custom', methods: { custom: gateway } };
  metadata.agents.claude = entry;
  const { id } = manager.startRun({ ...workflow, steps: workflow.steps.slice(0, 1) }, {
    task: 'mock:done', runner: 'claude', worktree: false, model: 'vendor/model',
  });
  const settled = () => vi.waitFor(() => expect(manager.isActive(id) || store.getRun(id)?.status === 'queued').toBe(false), { timeout: 10000 });
  await settled();
  expect(store.getRun(id)?.agentMethod).toBe('custom');
  entry.active = 'subscription';
  expect(manager.continueRun(id, { text: 'mock:done' }).ok).toBe(true);
  await settled();
  expect(store.getRun(id)?.steps.at(-1)?.agentMethod).toBe('custom');
  metadata.agents.claude = { active: 'subscription', methods: {} };
  expect(manager.continueRun(id, { text: 'mock:done' }).ok).toBe(true);
  await settled();
  expect(store.getRun(id)).toMatchObject({ status: 'waiting', idleClosedAt: expect.any(String), error: expect.stringContaining('provider was removed') });
}, 25000);

it('parks before spawning on a locked store and keeps the selected method through a retry', async () => {
  vi.stubEnv('CEZ_DRY_RUN', '0');
  vi.stubEnv('CEZ_CLAUDE_BIN', join(repo, 'never-spawn'));
  metadata.agents.claude = { active: 'custom', methods: { custom: gateway } };
  vi.mocked(readAgentProviderKey).mockRejectedValue(new Error('fixture-sensitive-error'));
  const { id } = manager.startRun({ ...workflow, steps: workflow.steps.slice(0, 1) }, {
    task: 'fixture', runner: 'claude', worktree: false,
  });
  await vi.waitFor(() => expect(store.getRun(id)?.error).toMatch(/unlock the OS keychain/i), { timeout: 10000 });
  expect(store.getRun(id)?.steps[0]).toMatchObject({ status: 'waiting', agentMethod: 'custom' });
  expect(JSON.stringify([store.getRun(id), store.readEvents(id)])).not.toContain('fixture-sensitive-error');
  await vi.waitFor(() => expect(manager.isActive(id)).toBe(false));
  metadata.agents.claude.active = 'subscription';
  vi.stubEnv('CEZ_DRY_RUN', '1');
  expect(manager.continueRun(id).ok).toBe(true);
  await vi.waitFor(() => expect(store.getRun(id)?.steps[0]?.sessionId).toBeTruthy(), { timeout: 10000 });
  expect(store.getRun(id)?.steps[0]?.agentMethod).toBe('custom');
}, 25000);

it('switches to the active destination method and admits only the exact catalog-validated foreign model', async () => {
  const model = 'opus';
  metadata.agents = { claude: { active: 'subscription', methods: {} }, codex: { active: 'custom', methods: {
    custom: { ...gateway, models: { fetchedAt: '', ids: [{ id: model }] } },
  } } };
  const { id } = manager.startRun({ ...workflow, steps: workflow.steps.slice(0, 1) }, {
    task: 'mock:done', runner: 'claude', worktree: false,
  });
  const settled = (phase: string) => vi.waitFor(() => {
    expect({ phase, active: manager.isActive(id), queued: store.getRun(id)?.status === 'queued' }).toEqual({ phase, active: false, queued: false });
  }, { timeout: 10000 });
  await settled('initial Claude turn');
  const input = { runner: 'codex' as const, agentProfile: 'default', model, changedBy: 'fixture' };
  expect(manager.switchAgent(id, { ...input, providerModel: 'wrong' })).toHaveProperty('error');
  expect(manager.switchAgent(id, { ...input, providerModel: model })).toHaveProperty('summary');
  // The Codex mock leaves an ordinary interactive turn waiting for the user's Finish.
  await vi.waitFor(() => expect(store.getRun(id)).toMatchObject({ status: 'waiting', runner: 'codex', agentMethod: 'custom' }), { timeout: 10000 });
  expect(manager.finish(id)).toBe(true);
  await settled('switched Codex turn');
  expect(store.getRun(id)).toMatchObject({ runner: 'codex', agentMethod: 'custom', modelIdentity: 'custom/opus' });
  expect(manager.continueRun(id, { model, providerModel: 'wrong' }).ok).toBe(false);
  expect(manager.continueRun(id, { text: 'next fixture turn', model, providerModel: model }).ok).toBe(true);
  await vi.waitFor(() => expect(store.getRun(id)).toMatchObject({ status: 'waiting', currentStepId: 'continue-2' }), { timeout: 10000 });
  expect(manager.finish(id)).toBe(true);
  await settled('continued Codex turn');
  expect(store.getRun(id)?.steps.at(-1)).toMatchObject({ agentMethod: 'custom', modelIdentity: 'custom/opus' });
}, 30000);

it('launches the fallback on its own gateway when its catalog offers a foreign native preset', async () => {
  metadata.agents = { claude: { active: 'subscription', methods: {} }, codex: { active: 'custom', methods: {
    custom: { ...gateway, keyRef: '73676b99-07db-4d7c-ab28-612e0839ab49', models: { fetchedAt: '', ids: [{ id: 'opus' }] } },
  } } };
  await putAgentFallbackPolicy(repo, { expectedRevision: 0, expectedIncarnation: null, enabled: true,
    candidates: [{ provider: 'codex', profileId: 'default', model: 'opus' }] });
  const { id } = manager.startRun({ ...workflow, steps: workflow.steps.slice(0, 1) }, {
    task: 'mock:limit', runner: 'claude', agentMethod: 'subscription', worktree: false,
  });
  await vi.waitFor(() => expect(store.getRun(id)).toMatchObject({
    runner: 'codex', agentMethod: 'custom', modelIdentity: 'custom/opus',
  }), { timeout: 10000 });
  expect(store.getRun(id)?.steps[0]).toMatchObject({ backend: 'claude', agentMethod: 'subscription' });
}, 20000);

it('runs the remaining required check when Continue supplies an override at a provider checkpoint', async () => {
  metadata.agents.claude = { active: null, methods: {} };
  const { id } = manager.startRun({ ...workflow, steps: [workflow.steps[0]!, { id: 'check', command: 'exit 1' }] }, {
    task: 'mock:done', runner: 'claude', worktree: false,
  });
  await vi.waitFor(() => expect(store.getRun(id)?.status === 'waiting' && !manager.isActive(id)).toBe(true), { timeout: 10000 });
  metadata.agents.claude = { active: 'custom', methods: { custom: gateway } };
  expect(manager.continueRun(id, { model: 'vendor/model', text: 'mock:done' }).ok).toBe(true);
  await vi.waitFor(() => expect(store.getRun(id)?.steps.find(s => s.id === 'check')?.status).toBe('failed'), { timeout: 10000 });
  expect(store.getRun(id)?.steps[0]?.modelIdentity).toBe('custom/vendor/model');
}, 20000);

it('keeps the effective gateway model on same-session Continue after the catalog is reordered', async () => {
  const ids = [{ id: 'team/small' }, { id: 'team/large' }];
  metadata.agents.claude = { active: 'custom', methods: { custom: { ...gateway, models: { fetchedAt: '', ids } } } };
  const { id } = manager.startRun({ ...workflow, steps: workflow.steps.slice(0, 1) }, {
    task: 'mock:done', runner: 'claude', worktree: false,
  });
  const settled = () => vi.waitFor(() => expect(store.getRun(id)?.status === 'done' && !manager.isActive(id)).toBe(true), { timeout: 10000 });
  await settled();
  ids.reverse();
  expect(manager.continueRun(id, { text: 'mock:done' }).ok).toBe(true);
  await settled();
  expect(store.getRun(id)?.steps.at(-1)?.modelIdentity).toBe('custom/team/small');
}, 25000);

it('holds the limited gateway while letting the same runner use its subscription', async () => {
  metadata.agents.claude = { active: 'custom', methods: { custom: gateway } };
  await putAgentFallbackPolicy(repo, { expectedRevision: 0, expectedIncarnation: null, enabled: true,
    candidates: [{ provider: 'codex', profileId: 'default' }] });
  const flow = { ...workflow, steps: workflow.steps.slice(0, 1) };
  const start = (task: string) => manager.startRun(flow, { task, runner: 'claude', worktree: false }).id;
  const limited = start('mock:limit');
  await vi.waitFor(() => expect(store.getRun(limited)?.usageLimitHolds?.length).toBe(1), { timeout: 10000 });
  expect(manager.accountHolds().deadline.has('claude:default')).toBe(false);
  manager.cancel(limited);
  const next = start('mock:done');
  await vi.waitFor(() => expect(store.getRun(next)?.queueWaitReason?.kind).toBe('usage-reset'), { timeout: 10000 });
  manager.cancel(next);
  metadata.agents.claude.active = 'subscription';
  const subscription = start('mock:done');
  await vi.waitFor(() => expect(store.getRun(subscription)?.status).toBe('done'), { timeout: 10000 });
  expect(store.getRun(subscription)?.steps[0]?.agentMethod).toBe('subscription');
}, 25000);


it('retries a provider-blocked repair through the check that requested it', async () => {
  metadata.agents.claude = { active: 'subscription', methods: {} };
  const { id } = manager.startRun({ ...workflow, steps: [workflow.steps[0]!, { id: 'verify', command: 'exit 1' }] },
    { task: 'mock:done', runner: 'claude', worktree: false });
  const wait = (status: string) => vi.waitFor(() => {
    expect(store.getRun(id)?.status).toBe(status);
    expect(manager.isActive(id)).toBe(false);
  }, { timeout: 10000 });
  await wait('failed');
  metadata.agents.claude.active = null;
  expect(manager.switchAgent(id, { runner: 'claude', agentProfile: 'default', model: 'vendor/model', changedBy: 'fixture' })).toHaveProperty('summary');
  await wait('waiting');
  metadata.agents.claude = { active: 'custom', methods: { custom: gateway } };
  expect(manager.continueRun(id, { model: 'vendor/model', text: 'mock:done' }).ok).toBe(true);
  await wait('failed');
  expect(store.getRun(id)?.steps.find(step => step.id === 'verify')).toMatchObject({ status: 'failed', iterations: 2 });
}, 35000);
