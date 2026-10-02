import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore, type RunRecord } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

/**
 * The landing check's HTTP surface (spec `.ai/specs/2026-09-29-landing-check.md`, PR 4):
 * `POST /api/v1/runs/:id/land-check` and the read-time `landingCheckStale` marker on
 * `GET /runs/:id`.
 *
 * The engine is stubbed here on purpose — `landing-check-run.test.ts` drives the real manager —
 * so what this file pins is the WIRE: the status codes, the response shape, the middleware
 * validation (a misspelled `source` is a 400, not a silent no-op filter) and the derived marker
 * that must never be persisted.
 */
const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const posix = describe.skipIf(process.platform === 'win32');

let repoRoot: string;
let store: RunStore;
let app: ReturnType<typeof createApp>;
let calls: Array<{ parentId: string; input: unknown }>;
let answer: { runId: string; ofRunId: string } | { refused: string; notFound: boolean };

const grepRun = (id: string): RunRecord | undefined => store.getRun(id);

beforeEach(async () => {
  repoRoot = mkdtempSync(join(tmpdir(), 'cez-landing-route-'));
  mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
  await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  writeFileSync(join(repoRoot, 'a.txt'), 'a\n');
  await run('git', ['add', '-A'], { cwd: repoRoot });
  await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
  store = RunStore.open(join(repoRoot, '.ai/cezar'));
  calls = [];
  answer = { runId: 'check-1', ofRunId: 'parent-1' };
  const manager = {
    startLandingCheck: async (parentId: string, input: unknown) => {
      calls.push({ parentId, input });
      return answer;
    },
  } as unknown as RunManager;
  app = createApp({ repoRoot, store, manager, version: '0.0.0-test' });
});

afterEach(() => {
  store.flush();
  rmSync(repoRoot, { recursive: true, force: true });
});

const post = (path: string, body?: string): Promise<Response> =>
  apiRequest(app, path, {
    method: 'POST',
    ...(body === undefined ? {} : { body, headers: { 'content-type': 'application/json' } }),
  });

describe('POST /runs/:id/land-check', () => {
  it('answers 201 with the CHECK run id and passes an absent body through as the empty request', async () => {
    const response = await post('/api/v1/runs/parent-1/land-check');
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ runId: 'check-1', ofRunId: 'parent-1' });
    expect(calls).toEqual([{ parentId: 'parent-1', input: {} }]);
  });

  it('carries explicit sources and commands through, and 400s a misspelled key rather than ignoring it', async () => {
    const ok = await post(
      '/api/v1/runs/parent-1/land-check',
      JSON.stringify({ sources: ['cez/a'], commands: ['npm test'], acknowledge: { digest: 'a'.repeat(64) } }),
    );
    expect(ok.status).toBe(201);
    expect(calls[0]?.input).toEqual({ sources: ['cez/a'], commands: ['npm test'], acknowledge: { digest: 'a'.repeat(64) } });

    // `.strict()`: a `source` (singular) filter that silently did nothing would be worse than a
    // refusal — the check would run whatever the ledger says while the caller believes otherwise.
    const bad = await post('/api/v1/runs/parent-1/land-check', JSON.stringify({ source: ['cez/a'] }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain('source');

    // An acknowledgement is a digest or it is nothing at all: an empty one would compare equal
    // to nothing and silently strip the brake.
    const empty = await post('/api/v1/runs/parent-1/land-check', JSON.stringify({ acknowledge: { digest: '' } }));
    expect(empty.status).toBe(400);
  });

  it('answers 404 for an unknown run and 409 only for a check already in flight', async () => {
    answer = { refused: 'no such run: gone', notFound: true };
    const missing = await post('/api/v1/runs/gone/land-check');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'no such run: gone' });

    answer = { refused: 'a landing check is already in flight for this project (run abc)', notFound: false };
    const busy = await post('/api/v1/runs/parent-1/land-check');
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ error: 'a landing check is already in flight for this project (run abc)' });
  });
});

posix('landingCheckStale', () => {
  const subject = (baseSha: string, childSha: string) => ({
    baseRef: 'cez/parent',
    baseSha,
    sources: [{ ref: 'cez/child', sha: childSha }],
    order: 'ledger' as const,
    treeSha: 'f'.repeat(40),
  });

  it('is derived on GET /runs/:id — true once a recorded ref moved, false while it still matches, absent for an ordinary run', async () => {
    await run('git', ['checkout', '-q', '-b', 'cez/parent'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '--allow-empty', '-m', 'parent'], { cwd: repoRoot });
    const baseSha = (await run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim();
    await run('git', ['checkout', '-q', '-b', 'cez/child', baseSha], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'c.txt'), 'c\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'child'], { cwd: repoRoot });
    const childSha = (await run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim();
    await run('git', ['checkout', '-q', 'cez/parent'], { cwd: repoRoot });

    const checked = store.createRun({ title: 'checked', workflow: 'task', task: 'c', steps: [] });
    store.updateRun(checked.id, { landingCheck: { ofRunId: 'parent', subject: subject(baseSha, childSha), verdict: 'passed' } });
    const ordinary = store.createRun({ title: 'ordinary', workflow: 'task', task: 'o', steps: [] });

    const fresh = (await (await apiRequest(app, `/api/v1/runs/${checked.id}`)).json()) as Record<string, unknown>;
    expect(fresh.landingCheckStale).toBe(false);
    const plain = (await (await apiRequest(app, `/api/v1/runs/${ordinary.id}`)).json()) as Record<string, unknown>;
    expect('landingCheckStale' in plain).toBe(false);

    // The child moves after the check: the recorded verdict is about content that moved.
    writeFileSync(join(repoRoot, 'c.txt'), 'c2\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'child moved'], { cwd: repoRoot });

    const stale = (await (await apiRequest(app, `/api/v1/runs/${checked.id}`)).json()) as Record<string, unknown>;
    expect(stale.landingCheckStale).toBe(true);
    // The STORED verdict is not rewritten by the read.
    expect((grepRun(checked.id)?.landingCheck?.subject.sources[0] ?? {}).sha).toBe(childSha);
    expect(grepRun(checked.id)?.landingCheck?.verdict).toBe('passed');
  });
});
