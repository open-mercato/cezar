import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { DEFAULT_UNIT_PROMPTS, unitPromptsDir } from '../units/prompts.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

/**
 * The role-prompt CRUD behind Settings → Units (spec 2026-09-08-units-hierarchy §Routes).
 *
 * The whole surface is one round trip: GET the defaults → PUT an override → GET it back as
 * `file` → DELETE → GET the default again. Everything else here is a bound or a refusal, and
 * every case runs against a real temp repository, because "did the file land where the run
 * composer will look for it" is most of what this route does.
 */
describe('/api/v1/units/prompts', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  const savedUnits = process.env.CEZ_UNITS;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-unit-prompts-api-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    process.env.CEZ_UNITS = '1';
    app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedUnits === undefined) delete process.env.CEZ_UNITS;
    else process.env.CEZ_UNITS = savedUnits;
  });

  interface Entry {
    role: string;
    text: string;
    source: string;
  }

  const list = async (): Promise<Entry[]> => {
    const res = await apiRequest(app, '/api/v1/units/prompts');
    expect(res.status).toBe(200);
    return ((await res.json()) as { prompts: Entry[] }).prompts;
  };

  const put = (role: string, text: string) =>
    apiRequest(app, `/api/v1/units/prompts/${role}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });

  const del = (role: string) =>
    apiRequest(app, `/api/v1/units/prompts/${role}`, { method: 'DELETE' });

  it('walks the whole cycle: default → PUT → file → DELETE → default', async () => {
    expect(await list()).toEqual([
      { role: 'caesar', text: DEFAULT_UNIT_PROMPTS.caesar, source: 'default' },
      { role: 'legate', text: DEFAULT_UNIT_PROMPTS.legate, source: 'default' },
      { role: 'centurion', text: DEFAULT_UNIT_PROMPTS.centurion, source: 'default' },
    ]);
    // Nothing on disk yet — reading the prompts is not a reason to write state.
    expect(existsSync(unitPromptsDir(repoRoot))).toBe(false);

    const saved = await put('legate', 'Hold the left.');
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ role: 'legate', text: 'Hold the left.', source: 'file' });
    expect(await readFile(join(unitPromptsDir(repoRoot), 'legate.md'), 'utf8')).toBe('Hold the left.');

    const afterPut = await list();
    expect(afterPut.find((p) => p.role === 'legate')).toEqual({
      role: 'legate',
      text: 'Hold the left.',
      source: 'file',
    });
    // One override is one role: the neighbours are untouched.
    expect(afterPut.filter((p) => p.source === 'default').map((p) => p.role)).toEqual(['caesar', 'centurion']);

    const restored = await del('legate');
    expect(restored.status).toBe(200);
    expect(await restored.json()).toEqual({
      role: 'legate',
      text: DEFAULT_UNIT_PROMPTS.legate,
      source: 'default',
    });
    expect(existsSync(join(unitPromptsDir(repoRoot), 'legate.md'))).toBe(false);
    expect((await list()).every((p) => p.source === 'default')).toBe(true);
  });

  it('replaces an existing override rather than appending', async () => {
    await put('caesar', 'first');
    await put('caesar', 'second');
    expect(await readFile(join(unitPromptsDir(repoRoot), 'caesar.md'), 'utf8')).toBe('second');
  });

  it('DELETE on a role that has no override still answers the default', async () => {
    // Idempotent by design: the user's intent ("give me the shipped prompt") is satisfied either
    // way, so a 404 here would only make the Settings editor branch for no reason.
    const res = await del('centurion');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ source: 'default', text: DEFAULT_UNIT_PROMPTS.centurion });
  });

  it('400s an unknown role on both mutators, and writes nothing', async () => {
    expect((await put('emperor', 'x')).status).toBe(400);
    expect((await del('emperor')).status).toBe(400);
    expect(existsSync(unitPromptsDir(repoRoot))).toBe(false);
  });

  it('400s an empty or missing text, and a non-string one', async () => {
    expect((await put('caesar', '')).status).toBe(400);
    expect((await put('caesar', 'x'.repeat(40_001))).status).toBe(400);
    const noText = await apiRequest(app, '/api/v1/units/prompts/caesar', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 42 }),
    });
    expect(noText.status).toBe(400);
    expect(existsSync(unitPromptsDir(repoRoot))).toBe(false);
  });

  it('accepts exactly the 40k cap', async () => {
    const res = await put('caesar', 'x'.repeat(40_000));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Entry).text).toHaveLength(40_000);
  });

  it('answers identically under the project-scoped spelling', async () => {
    await put('caesar', 'scoped');
    const res = await apiRequest(app, '/api/v1/p/default/units/prompts');
    expect(res.status).toBe(200);
    const prompts = ((await res.json()) as { prompts: Entry[] }).prompts;
    expect(prompts.find((p) => p.role === 'caesar')).toEqual({
      role: 'caesar',
      text: 'scoped',
      source: 'file',
    });
  });
});
