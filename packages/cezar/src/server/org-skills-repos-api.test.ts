import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

describe('PUT /workspace/config orgSkillsRepos', () => {
  let repoRoot: string;
  let store: RunStore;
  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-org-skills-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
  });
  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });
  const put = (body: unknown) => {
    const app = createApp({ repoRoot, store, manager: {} as RunManager, version: 'test' });
    return apiRequest(app, '/api/v1/workspace/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  };

  it('stores a repo list, defaulting the ref, and clears it with []', async () => {
    const saved = await put({ orgSkillsRepos: [{ repo: 'acme/skills' }] });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { orgSkillsRepos: unknown }).orgSkillsRepos).toEqual([{ repo: 'acme/skills', ref: 'main' }]);
    const cleared = await put({ orgSkillsRepos: [] });
    expect(((await cleared.json()) as { orgSkillsRepos: unknown }).orgSkillsRepos).toEqual([]);
  });

  it('keeps unknown keys on entries it replaces', async () => {
    const saved = await put({ orgSkillsRepos: [{ repo: 'acme/skills', ref: 'main', future: 'kept' }] });
    expect(((await saved.json()) as { orgSkillsRepos: unknown }).orgSkillsRepos).toEqual([
      { repo: 'acme/skills', ref: 'main', future: 'kept' },
    ]);
  });

  it('rejects a transport-helper repo and an option-shaped ref', async () => {
    expect((await put({ orgSkillsRepos: [{ repo: 'ext::sh -c id' }] })).status).toBe(400);
    expect((await put({ orgSkillsRepos: [{ repo: 'acme/skills', ref: '--output=x' }] })).status).toBe(400);
    // Relative local paths resolve per process; the setting is global.
    expect((await put({ orgSkillsRepos: [{ repo: './skills' }] })).status).toBe(400);
    expect((await put({ orgSkillsRepos: [{ repo: '../skills' }] })).status).toBe(400);
    expect((await put({ orgSkillsRepos: [{ repo: '/abs/skills' }] })).status).toBe(200);
  });
});
