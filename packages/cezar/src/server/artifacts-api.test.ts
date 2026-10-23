import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runArtifactsEventSchema, runArtifactsResponseSchema } from '@open-mercato/cezar-contract';
import { MAX_ARTIFACT_BYTES } from '../runs/artifacts.ts';
import { artifactsDir, RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { artifactCsp, artifactsFrame } from './artifacts.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

/**
 * Run artifacts, served (spec `.ai/specs/2026-10-22-html-artifacts-and-impact.md` § Serving).
 * The security boundary first: agent-authored script runs on the cockpit's origin space, so the
 * exact CSP and the membership guard are pinned before anything else.
 */

describe('artifactCsp — the exact header (spec Q3/Q4)', () => {
  it('allows the CDN script allowlist by default, and nothing that can phone home', () => {
    expect(artifactCsp(true)).toBe(
      "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; default-src 'none'; " +
        "script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com; " +
        "style-src 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; " +
        "font-src data: https://fonts.gstatic.com; img-src data: blob:; media-src data: blob:; " +
        "connect-src 'none'; form-action 'none'; base-uri 'none'",
    );
  });

  it('drops every https: source with CEZ_ARTIFACTS_CDN=0', () => {
    expect(artifactCsp(false)).toBe(
      "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; default-src 'none'; " +
        "script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:; img-src data: blob:; " +
        "media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'",
    );
  });

  it('never grants the same origin, in either mode', () => {
    for (const cdn of [true, false]) expect(artifactCsp(cdn)).not.toContain('allow-same-origin');
  });
});

describe('GET /runs/:id/artifacts[/:name]', () => {
  const savedCdn = process.env.CEZ_ARTIFACTS_CDN;
  let repoRoot: string;
  let outside: string;
  let store: RunStore;
  let app: Hono;
  let runId: string;
  let dir: string;

  beforeEach(() => {
    delete process.env.CEZ_ARTIFACTS_CDN;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-artifacts-api-'));
    outside = mkdtempSync(join(tmpdir(), 'cez-artifacts-outside-'));
    const dataDir = join(repoRoot, '.ai/cezar');
    store = RunStore.open(dataDir);
    runId = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] }).id;
    dir = artifactsDir(dataDir, runId);
    mkdirSync(dir, { recursive: true });
    app = createApp({
      repoRoot,
      store,
      manager: { isActive: () => false } as unknown as RunManager,
      version: '0.0.0-test',
    });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    if (savedCdn === undefined) delete process.env.CEZ_ARTIFACTS_CDN;
    else process.env.CEZ_ARTIFACTS_CDN = savedCdn;
  });

  const get = (path: string) => apiRequest(app, `/api/v1/runs/${runId}/artifacts${path}`);

  it('serves HTML with the sandbox CSP and the isolation headers', async () => {
    writeFileSync(join(dir, 'report.html'), '<title>Report</title><p>hi</p>');
    const res = await get('/report.html');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<title>Report</title><p>hi</p>');
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-security-policy')).toBe(artifactCsp(true));
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('serves the no-CDN CSP when CEZ_ARTIFACTS_CDN=0', async () => {
    process.env.CEZ_ARTIFACTS_CDN = '0';
    writeFileSync(join(dir, 'report.html'), '<p>hi</p>');
    const res = await get('/report.html');
    expect(res.headers.get('content-security-policy')).toBe(artifactCsp(false));
  });

  it('404s a dotfile, a dot-dot name and an absent file — only scan members are served', async () => {
    writeFileSync(join(dir, '.secret'), 'x');
    mkdirSync(join(dir, 'sub.html'));
    // A dotted name passes the regex and reaches the handler (a bare `..` is a URL dot segment).
    for (const name of ['.secret', '..x.html', 'sub.html', 'missing.html']) {
      expect((await get(`/${name}`)).status, name).toBe(404);
    }
  });

  it('refuses an encoded path separator at the validator (400)', async () => {
    const res = await get('/..%2Fruns.json');
    expect(res.status).toBe(400);
  });

  it('404s a symlink, even to a readable file outside the directory', async () => {
    writeFileSync(join(outside, 'secret.html'), '<p>secret</p>');
    symlinkSync(join(outside, 'secret.html'), join(dir, 'link.html'));
    const res = await get('/link.html');
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('secret</p>');
    const list = runArtifactsResponseSchema.parse(await (await get('')).json());
    expect(list.artifacts.map((a) => a.name)).not.toContain('link.html');
  });

  it('serves an over-cap file download-only', async () => {
    const big = join(dir, 'huge.html');
    writeFileSync(big, '');
    truncateSync(big, MAX_ARTIFACT_BYTES + 1);
    const list = runArtifactsResponseSchema.parse(await (await get('')).json());
    expect(list.artifacts.find((a) => a.name === 'huge.html')?.kind).toBe('other');
    const res = await get('/huge.html');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="huge.html"');
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-security-policy')).not.toContain('allow-scripts');
    await res.body?.cancel();
  });

  it('serves markdown and json inert, with the image/text header set', async () => {
    writeFileSync(join(dir, 'notes.md'), '# Notes\n');
    writeFileSync(join(dir, 'review.json'), '{}');
    const md = await get('/notes.md');
    expect(md.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(md.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
    const json = await get('/review.json');
    expect(json.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(json.headers.get('content-disposition')).toBeNull();
  });

  it('lists the directory, newest first, with titles', async () => {
    writeFileSync(join(dir, 'a.html'), '<html><head><title> A  page </title></head></html>');
    const list = runArtifactsResponseSchema.parse(await (await get('')).json());
    expect(list.truncated).toBe(false);
    expect(list.artifacts).toEqual([
      expect.objectContaining({ name: 'a.html', kind: 'html', title: 'A page', size: expect.any(Number) }),
    ]);
  });

  it('404s an unknown run on both routes', async () => {
    expect((await apiRequest(app, '/api/v1/runs/nope/artifacts')).status).toBe(404);
    expect((await apiRequest(app, '/api/v1/runs/nope/artifacts/a.html')).status).toBe(404);
  });

  // Kept revisions (spec R4): `?v=<n>` serves `.versions/<n>/` through the same membership guard.
  it('serves a kept version with identical headers and lists the versions', async () => {
    writeFileSync(join(dir, 'impact.html'), '<title>v2</title>');
    mkdirSync(join(dir, '.versions/1'), { recursive: true });
    writeFileSync(join(dir, '.versions/1/impact.html'), '<title>v1</title>');
    writeFileSync(join(dir, '.versions/1/review.json'), '{}');
    const current = await get('/impact.html');
    const old = await get('/impact.html?v=1');
    expect(old.status).toBe(200);
    expect(await old.text()).toBe('<title>v1</title>');
    expect(await current.text()).toBe('<title>v2</title>');
    for (const header of ['content-type', 'content-security-policy', 'x-content-type-options', 'referrer-policy', 'cross-origin-resource-policy', 'cache-control']) {
      expect(old.headers.get(header), header).toBe(current.headers.get(header));
    }
    const list = runArtifactsResponseSchema.parse(await (await get('')).json());
    expect(list.versions).toEqual([{ version: 1, updatedAt: expect.any(String), files: ['impact.html', 'review.json'] }]);
    expect(list.artifacts.map((a) => a.name)).toEqual(['impact.html']);
  });

  it('404s an unknown version, 400s a malformed one, and never follows a planted .versions symlink', async () => {
    writeFileSync(join(dir, 'impact.html'), '<p>now</p>');
    expect((await get('/impact.html?v=7')).status).toBe(404);
    expect((await get('/impact.html?v=0')).status).toBe(400);
    expect((await get('/impact.html?v=..')).status).toBe(400);
    mkdirSync(join(outside, '1'));
    writeFileSync(join(outside, '1/secret.html'), '<p>secret</p>');
    symlinkSync(outside, join(dir, '.versions'));
    const res = await get('/secret.html?v=1');
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('secret</p>');
    expect(runArtifactsResponseSchema.parse(await (await get('')).json()).versions).toBeUndefined();
  });

  it('answers an empty listing when the directory does not exist yet', async () => {
    rmSync(dir, { recursive: true, force: true });
    const body = runArtifactsResponseSchema.parse(await (await get('')).json());
    expect(body).toEqual({ artifacts: [], truncated: false });
  });
});

describe('the artifacts SSE frame', () => {
  it('matches the contract on both streams', () => {
    const payload = { runId: 'r1', artifacts: [], truncated: false };
    expect(runArtifactsEventSchema.parse(artifactsFrame(payload))).toEqual({ type: 'artifacts', ...payload });
    expect(runArtifactsEventSchema.parse(artifactsFrame(payload, 'proj'))).toEqual({ type: 'artifacts', ...payload, project: 'proj' });
  });

  it('reaches /api/v1/events when the store publishes a listing', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'cez-artifacts-sse-'));
    const store = RunStore.open(join(repoRoot, '.ai/cezar'));
    const runId = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] }).id;
    const app = createApp({ repoRoot, store, manager: { isActive: () => false } as unknown as RunManager, version: '0.0.0-test' });
    const controller = new AbortController();
    const res = await apiRequest(app, '/api/v1/events', { signal: controller.signal });
    const reader = res.body!.getReader();
    const listing = { artifacts: [{ name: 'demo.html', kind: 'html' as const, size: 3, updatedAt: new Date(0).toISOString() }], truncated: false };
    setTimeout(() => store.publishArtifacts(runId, listing), 20);
    let text = '';
    const decoder = new TextDecoder();
    while (!text.includes('event: artifacts')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    // The data line follows the event line in the same frame.
    while (!/event: artifacts\ndata: .*\n/.test(text)) text += decoder.decode((await reader.read()).value);
    controller.abort();
    await reader.cancel().catch(() => undefined);
    const data = /event: artifacts\ndata: (.*)\n/.exec(text)![1]!;
    expect(runArtifactsEventSchema.parse(JSON.parse(data))).toEqual({ type: 'artifacts', runId, ...listing });
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });
});
