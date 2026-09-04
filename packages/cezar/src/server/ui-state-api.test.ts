import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

/**
 * `GET/PUT /api/v1/ui-state` (#408 — the `skillUsage` addition). The contract under test: the
 * schema is `.passthrough()` so unrelated keys survive a PUT untouched (BACKWARD_COMPATIBILITY.md
 * §3 — additive only); `skillUsage` is a plain `name -> count` map with no shape surprises; and
 * because the top-level merge is SHALLOW, a PUT of `skillUsage` replaces the whole map rather
 * than merging entry-by-entry — exactly what the client's `bumpSkillUsage` (packages/web/src/lib/
 * skills.ts) is written to expect (it always sends the full updated map back).
 */
describe('the ui-state API — skillUsage (#408)', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-uistateapi-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    // The ui-state routes never touch the manager — an empty stub is honest.
    app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const uiStatePath = () => join(repoRoot, '.ai/cezar', 'ui-state.json');
  const rawFile = () => JSON.parse(readFileSync(uiStatePath(), 'utf8')) as Record<string, unknown>;

  const get = () => apiRequest(app, '/api/v1/ui-state');
  const put = (body: unknown) =>
    apiRequest(app, '/api/v1/ui-state', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('GET answers {} when no file exists yet', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it('PUT skillUsage persists and round-trips through GET', async () => {
    const res = await put({ skillUsage: { 'om-fix': 1, 'om-review': 3 } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skillUsage: { 'om-fix': 1, 'om-review': 3 } });
    expect(rawFile().skillUsage).toEqual({ 'om-fix': 1, 'om-review': 3 });
  });

  it('a later PUT replaces the whole map (shallow merge) — clients must send the FULL map', async () => {
    await put({ skillUsage: { 'om-fix': 1, 'om-review': 3 } });
    // Sending only the bumped entry would silently drop om-review — the client-side
    // `bumpSkillUsage` always spreads the previous map, exactly to avoid this.
    await put({ skillUsage: { 'om-fix': 2 } });
    expect(rawFile().skillUsage).toEqual({ 'om-fix': 2 });
  });

  it('a skillUsage PUT never disturbs unrelated existing keys (additive, #3 BACKWARD_COMPATIBILITY)', async () => {
    await put({ lastTask: { source: 'skill', ref: 'om-fix' }, lastAutonomous: true });
    await put({ skillUsage: { 'om-fix': 1 } });
    const raw = rawFile();
    expect(raw.lastTask).toEqual({ source: 'skill', ref: 'om-fix' });
    expect(raw.lastAutonomous).toBe(true);
    expect(raw.skillUsage).toEqual({ 'om-fix': 1 });
  });

  it('rejects a malformed skillUsage value instead of writing garbage', async () => {
    const res = await put({ skillUsage: { 'om-fix': 'a lot' } });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toHaveProperty('error');
  });

  // ---- lastTask: the "no skill" value ---------------------------------------------------------
  // The composer can run a task with NO skill and no workflow (the plain built-in quick-task).
  // `null` is how that choice is recorded, and it has to be a real value rather than an omitted
  // key: omitting it leaves whatever the previous run stored, because the merge is shallow.
  describe('lastTask records "nothing picked" as null', () => {
    it('accepts null, writes it, and round-trips it through GET', async () => {
      const res = await put({ lastTask: null });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ lastTask: null });
      expect(rawFile()).toHaveProperty('lastTask', null);
      expect(await (await get()).json()).toMatchObject({ lastTask: null });
    });

    it('null REPLACES a stored source — an omitted key would have kept it', async () => {
      await put({ lastTask: { source: 'skill', ref: 'om-fix' } });
      await put({ lastTask: null });
      expect(rawFile().lastTask).toBeNull();
      // The omitted-key case, for contrast: the shallow merge keeps what is already there.
      await put({ lastTask: { source: 'skill', ref: 'om-fix' } });
      await put({ lastAutonomous: true });
      expect(rawFile().lastTask).toEqual({ source: 'skill', ref: 'om-fix' });
    });

    it('still refuses a malformed source', async () => {
      expect((await put({ lastTask: { source: 'nonsense', ref: 'x' } })).status).toBe(400);
      expect((await put({ lastTask: { source: 'skill' } })).status).toBe(400);
    });
  });

  // ---- bounds ------------------------------------------------------------------------------
  // The body is written straight to ui-state.json, which every cockpit load GETs back and every
  // later PUT re-reads — so an unbounded map is an unbounded file. Every other field in this
  // schema carries a limit; skillUsage now does too, on all three axes.
  describe('skillUsage bounds — unbounded input must never reach the file', () => {
    const usageOf = (entries: number) =>
      Object.fromEntries(Array.from({ length: entries }, (_, i) => [`skill-${i}`, 1]));

    it('a 200-char key is accepted; a 201-char key is refused', async () => {
      expect((await put({ skillUsage: { ['a'.repeat(200)]: 1 } })).status).toBe(200);
      const over = await put({ skillUsage: { ['a'.repeat(201)]: 1 } });
      expect(over.status).toBe(400);
      expect(rawFile().skillUsage).toEqual({ ['a'.repeat(200)]: 1 });
    });

    it('a huge key cannot balloon the file (the 50 MB PUT)', async () => {
      const res = await put({ skillUsage: { ['A'.repeat(50 * 1024 * 1024)]: 1 } });
      // A body this size never reaches the handler's 400 validators — the request-body size
      // guard (#429) refuses it first with 413 Payload Too Large. Either way the point holds:
      // it is refused before any write.
      expect(res.status).toBe(413);
      // Refused before any write — the file must not exist at all.
      expect(() => readFileSync(uiStatePath(), 'utf8')).toThrow();
    });

    it('a count at the cap is accepted; one over it is refused', async () => {
      expect((await put({ skillUsage: { 'om-fix': 1_000_000 } })).status).toBe(200);
      expect((await put({ skillUsage: { 'om-fix': 1_000_001 } })).status).toBe(400);
      expect(rawFile().skillUsage).toEqual({ 'om-fix': 1_000_000 });
    });

    it('200 entries are accepted; 201 are refused', async () => {
      expect((await put({ skillUsage: usageOf(200) })).status).toBe(200);
      const over = await put({ skillUsage: usageOf(201) });
      expect(over.status).toBe(400);
      expect((await over.json()) as { error: string }).toHaveProperty('error');
      // The at-cap map from the previous PUT still stands — the refusal wrote nothing.
      expect(Object.keys(rawFile().skillUsage as object)).toHaveLength(200);
    });
  });
});
