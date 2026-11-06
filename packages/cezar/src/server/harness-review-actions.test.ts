import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLedger, loadLedger, saveLedger } from '../harness/ledger.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { harnessLedgerResponseSchema } from '@open-mercato/cezar-contract';

describe('explicit multi-model review actions', () => {
  let base: string;
  let root: string;
  let worktree: string;
  let store: RunStore;
  let id: string;
  let app: ReturnType<typeof createApp>;
  const resume = vi.fn();
  beforeEach(() => {
    vi.stubEnv('CEZ_MULTI_MODEL', '1');
    vi.stubEnv('CEZ_DRY_RUN', '0');
    base = mkdtempSync(join(tmpdir(), 'cez-review-action-'));
    root = join(base, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', root]);
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'base'], { cwd: root });
    worktree = join(base, 'worktree');
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'cez/test', worktree], { cwd: root });
    store = RunStore.open(join(root, '.ai/cezar'));
    id = store.createRun({ title: 'Feature', task: 'Build it', workflow: 'harness-implement-feature', steps: [] }).id;
    store.updateRun(id, { status: 'review', worktreePath: worktree, harness: { profile: 'standard', workflow: 'harness-implement-feature' } });
    const ledger = createLedger({ workflow: 'harness-implement-feature', requestedProfile: 'standard', subject: { kind: 'brief', text: 'Build it' } });
    ledger.phases.push({ id: 'implement', name: 'Implement', kind: 'agent', status: 'done', attempts: 1, artifacts: {} });
    ledger.councils = [{ kind: 'implementation', round: 3, verdict: 'request_changes', findings: [{ severity: 'major', title: 'Missing tenant check', by: 'claude' }] }];
    ledger.stage.status = 'staged';
    ledger.outcome = { status: 'contested', blockingReasons: ['Missing tenant check'] };
    saveLedger(store.getDataDir(), id, ledger);
    resume.mockReset().mockImplementation(() => { store.updateRun(id, { status: 'queued' }); return { ok: true }; });
    app = createApp({ repoRoot: root, store, manager: { isActive: () => false, continueRun: resume } as unknown as RunManager, version: 'test' } as Parameters<typeof createApp>[0]);
  });
  afterEach(() => { store.flush(); rmSync(base, { recursive: true, force: true }); vi.unstubAllEnvs(); });
  const snapshot = async () => harnessLedgerResponseSchema.parse(await (await apiRequest(app, `/api/v1/runs/${id}/harness`)).json());
  const post = (body: unknown) => apiRequest(app, `/api/v1/runs/${id}/harness/review-action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const input = async (extra: Record<string, unknown> = {}) => ({ requestId: '11111111-1111-4111-8111-111111111111', action: 'verify', revision: (await snapshot()).actionRevision, ...extra });

  it('records one bounded action and closes publication before resuming', async () => {
    const response = await post(await input());
    expect(response.status, await response.text()).toBe(200);
    const ledger = loadLedger(store.getDataDir(), id)!;
    expect(ledger.reviewAction).toMatchObject({ action: 'verify', status: 'pending', round: 4, onePass: true });
    expect(ledger.stage.status).toBe('pending');
    expect(ledger.outcome.status).toBe('pending');
    expect(resume).toHaveBeenCalledTimes(1);
  });
  it('replays the same request without starting another pass', async () => {
    const request = await input();
    expect((await post(request)).status).toBe(200);
    expect((await post(request)).status).toBe(200);
    expect(resume).toHaveBeenCalledTimes(1);
  });
  it('rejects simultaneous decisions against the same snapshot', async () => {
    const request = await input();
    const responses = await Promise.all([post(request), post({ ...request, requestId: '22222222-2222-4222-8222-222222222222' })]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(resume).toHaveBeenCalledTimes(1);
  });
  it('rejects stale snapshots, unknown findings and invalid bodies without resuming', async () => {
    expect((await post(await input({ revision: 'stale' }))).status).toBe(409);
    expect((await post(await input({ action: 'fix', findingIds: ['unknown'] }))).status).toBe(409);
    expect((await post(await input({ action: 'fix' }))).status).toBe(400);
    expect((await post(await input({ command: 'anything' }))).status).toBe(400);
    expect(resume).not.toHaveBeenCalled();
  });
  it('accepts only current selected findings for a repair', async () => {
    const state = await snapshot();
    expect((await post(await input({ action: 'fix', findingIds: [state.findingHistory![0]!.id] }))).status).toBe(200);
    expect(loadLedger(store.getDataDir(), id)?.reviewAction?.findingIds).toEqual([state.findingHistory![0]!.id]);
  });
  it('requires setup before verification and installs nothing during a read', async () => {
    writeFileSync(join(worktree, 'package.json'), JSON.stringify({ packageManager: 'yarn@4.6.0', devDependencies: { typescript: '5' } }));
    const state = await snapshot();
    expect(state.environment?.status).toBe('needs-setup');
    expect((await post(await input())).status).toBe(409);
    expect(resume).not.toHaveBeenCalled();
    expect((await post(await input({ action: 'prepare' }))).status).toBe(200);
  });
  it('restores the prior staged outcome when the manager refuses the action', async () => {
    resume.mockReturnValue({ ok: false, error: 'held' });
    const before = loadLedger(store.getDataDir(), id);
    expect((await post(await input())).status).toBe(409);
    expect(loadLedger(store.getDataDir(), id)).toEqual(before);
  });
});
