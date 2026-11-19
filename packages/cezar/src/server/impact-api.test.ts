import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { artifactsBySubjectResponseSchema, startImpactResponseSchema } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

/**
 * `POST /impact` and `GET /artifacts?subject=` end to end in a dry run (spec
 * 2026-10-22-html-artifacts-and-impact § Serving). The subject guards are pinned in
 * `impact/launch.test.ts`; this proves the routes reach them, start the run on the pinned subject,
 * and find it again — with the backstop's report — by subject.
 */

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

describe('Assess Impact routes', () => {
  const saved = { dry: process.env.CEZ_DRY_RUN, pace: process.env.CEZ_MOCK_PACE };
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let app: Hono;

  beforeEach(async () => {
    process.env.CEZ_DRY_RUN = '1';
    process.env.CEZ_MOCK_PACE = '0';
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-impact-api-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    mkdirSync(join(repoRoot, '.ai/specs'), { recursive: true });
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai/cezar/config.json'), '{"skillsRepos": []}\n');
    writeFileSync(join(repoRoot, '.gitignore'), '.ai/cezar/\n');
    writeFileSync(join(repoRoot, '.ai/specs/feature.md'), '# Feature\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
    app = createApp({ repoRoot, store, manager, version: '0.0.0-test' });
  });

  afterEach(async () => {
    for (const r of store.listRuns()) manager.cancel(r.id);
    manager.dispose();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    for (const [key, value] of [['CEZ_DRY_RUN', saved.dry], ['CEZ_MOCK_PACE', saved.pace]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const post = (body: unknown, prefix = '/api/v1') =>
    apiRequest(app, `${prefix}/impact`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  const bySubject = async (subject: string) => {
    const res = await apiRequest(app, `/api/v1/artifacts?subject=${encodeURIComponent(subject)}`);
    expect(res.status).toBe(200);
    return artifactsBySubjectResponseSchema.parse(await res.json());
  };
  const waitFor = async (pred: () => Promise<boolean> | boolean, ms = 30_000) => {
    const deadline = Date.now() + ms;
    while (!(await pred())) {
      if (Date.now() > deadline) throw new Error('condition not met in time');
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  it('refuses a spec outside .ai/specs (409) and a malformed body (400), starting nothing', async () => {
    const outside = await post({ subject: { kind: 'spec', path: '../etc/passwd.md' } });
    expect(outside.status).toBe(409);
    expect(await outside.json()).toEqual({ error: expect.stringContaining('.ai/specs/') });
    expect((await post({ subject: { kind: 'pr', number: 0 } })).status).toBe(400);
    expect((await post({ subject: { kind: 'file', path: 'x' } })).status).toBe(400);
    expect(store.listRuns()).toEqual([]);
  });

  it('a PR (dry run): pins the head, forks from it, attributes the PR; the subject lookup finds the report', async () => {
    const res = await post({ subject: { kind: 'pr', number: 42 } }, '/api/v1/p/default');
    expect(res.status).toBe(201);
    const { runId } = startImpactResponseSchema.parse(await res.json());
    const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim();
    const record = store.getRun(runId)!;
    expect(record).toMatchObject({
      workflow: 'assess-impact',
      subject: { kind: 'pr', number: 42, headSha: head },
      prHead: { number: 42, ref: 'refs/cezar/pr/42' },
      baseBranch: head,
      prNumber: 42,
    });
    expect(record.task).toBe('Assess the impact of GitHub pull request #42: Dry-run pull request\n\nhttps://github.com/dry-run/repo/pull/42');

    await waitFor(async () => (await bySubject('pr:42')).artifacts.some((a) => a.name === 'impact.html'));
    const found = await bySubject('pr:42');
    expect(found).toMatchObject({ run: { id: runId }, subject: { kind: 'pr', number: 42 }, stale: false });
    if (found.run === null) throw new Error('unreachable');
    expect(found.versions?.map((v) => v.version)).toEqual([1]);
  }, 60_000);

  it('a spec: pinned by blob; stale once the spec changes on HEAD; an unknown subject is run:null', async () => {
    const res = await post({ subject: { kind: 'spec', path: '.ai/specs/feature.md' } });
    expect(res.status).toBe(201);
    const { runId } = startImpactResponseSchema.parse(await res.json());
    expect(store.getRun(runId)?.task).toBe('Assess the impact of the spec .ai/specs/feature.md');
    expect(await bySubject('spec:.ai/specs/feature.md')).toMatchObject({ run: { id: runId }, stale: false });
    writeFileSync(join(repoRoot, '.ai/specs/feature.md'), '# Feature v2\n');
    await run('git', [...GIT_ID, 'commit', '-q', '-am', 'edit'], { cwd: repoRoot });
    expect(await bySubject('spec:.ai/specs/feature.md')).toMatchObject({ run: { id: runId }, stale: true });
    expect(await bySubject('spec:.ai/specs/other.md')).toEqual({ run: null, subject: null, artifacts: [], truncated: false, stale: null });
    expect((await apiRequest(app, '/api/v1/artifacts?subject=nope')).status).toBe(400);
  }, 60_000);

  // Q11: the impact task still reaches the review gate with its empty diff, but no draft PR.
  it('a spec impact run parks at review (gate on) and offers no draft PR', async () => {
    const savedGate = process.env.CEZ_REVIEW_GATE;
    process.env.CEZ_REVIEW_GATE = '1';
    try {
      const res = await post({ subject: { kind: 'spec', path: '.ai/specs/feature.md' } });
      const { runId } = startImpactResponseSchema.parse(await res.json());
      // The mock parks at `waiting`; a done marker settles the step.
      await waitFor(() => ['waiting', 'review', 'done'].includes(store.getRun(runId)?.status ?? ''));
      if (store.getRun(runId)?.status === 'waiting') {
        const sent = await apiRequest(app, `/api/v1/runs/${runId}/messages`, { method: 'POST', body: JSON.stringify({ text: 'mock:done' }), headers: { 'content-type': 'application/json' } });
        expect(sent.status).toBe(200);
      }
      await waitFor(() => !manager.isActive(runId) && ['review', 'done'].includes(store.getRun(runId)?.status ?? ''));
      expect(store.getRun(runId)?.status).toBe('review');
      const pr = await apiRequest(app, `/api/v1/runs/${runId}/pr`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
      expect(pr.status).toBe(409);
      expect(await pr.json()).toEqual({ error: 'this task assessed impact and changed nothing — there is no pull request to open' });
    } finally {
      if (savedGate === undefined) delete process.env.CEZ_REVIEW_GATE;
      else process.env.CEZ_REVIEW_GATE = savedGate;
    }
  }, 60_000);
});
