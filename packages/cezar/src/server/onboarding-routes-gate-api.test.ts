import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import type { CommandRunner } from './create-project.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

/** The first-run project mutators (spec 2026-10-26-first-run-onboarding) refuse in a
 *  single-project workspace, like every other registry mutator, before touching the disk or `gh`. */
describe('git-init and publish-github in a single-project workspace', () => {
  const saved = { home: process.env.CEZ_HOME, single: process.env.CEZ_SINGLE_PROJECT, dryRun: process.env.CEZ_DRY_RUN };
  let home: string;
  let repoRoot: string;
  let store: RunStore;
  let run: ReturnType<typeof vi.fn<CommandRunner>>;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'cez-gate-home-')));
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'cez-gate-repo-')));
    writeFileSync(join(repoRoot, 'notes.md'), '# notes\n');
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    process.env.CEZ_HOME = home;
    process.env.CEZ_SINGLE_PROJECT = '1';
    process.env.CEZ_DRY_RUN = '1';
    run = vi.fn<CommandRunner>(async () => ({ ok: true, stdout: '' }));
  });

  afterEach(() => {
    store.flush();
    for (const [key, value] of [['CEZ_HOME', saved.home], ['CEZ_SINGLE_PROJECT', saved.single], ['CEZ_DRY_RUN', saved.dryRun]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const dir of [home, repoRoot]) rmSync(dir, { recursive: true, force: true });
  });

  const app = () => createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', projectCommandRunner: run });

  it('POST git-init answers 409 and creates no repository', async () => {
    const res = await apiRequest(app(), '/api/v1/projects/anything/git-init', { method: 'POST' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'single-project mode is enabled; initializing git is disabled' });
    expect(existsSync(join(repoRoot, '.git'))).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('POST publish-github answers 409 and runs no gh or git', async () => {
    const res = await apiRequest(app(), '/api/v1/projects/anything/publish-github', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: 'zielivia', name: 'notes' }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'single-project mode is enabled; publishing to GitHub is disabled' });
    expect(run).not.toHaveBeenCalled();
  });
});
