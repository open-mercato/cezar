import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { effectiveStartApp, readStartApp, writeStartApp } from './start-app.ts';
import { loadWorkspaceConfig, mergeWriteWorkspaceConfig } from './workspace/config.ts';

let root: string;
let dataDir: string;

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cez-start-app-')));
  dataDir = join(root, '.ai/cezar');
  await mergeWriteWorkspaceConfig((config) => {
    config.projects = [{ id: 'demo', root, name: 'demo', addedAt: '', lastOpenedAt: '', source: 'local' }];
  });
});

afterEach(async () => {
  await mergeWriteWorkspaceConfig((config) => {
    config.projects = [];
  });
  rmSync(root, { recursive: true, force: true });
});

describe('the start recipe', () => {
  it('is absent until written, and the team recipe lands in the repo config beside its other keys', async () => {
    expect(await readStartApp(dataDir, root)).toEqual({ project: null, personal: null, personalAvailable: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ baseBranch: 'develop' }));

    expect(await writeStartApp(dataDir, root, 'project', { services: ['npm run dev'] })).toBe(true);

    expect(JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'))).toEqual({
      baseBranch: 'develop',
      startApp: { services: ['npm run dev'] },
    });
    expect(effectiveStartApp(await readStartApp(dataDir, root))).toEqual({ services: ['npm run dev'], scope: 'project' });
  });

  it('prefers your own recipe, kept in your registry entry, and falls back when you remove it', async () => {
    await writeStartApp(dataDir, root, 'project', { services: ['npm run dev'] });
    await writeStartApp(dataDir, root, 'personal', { services: ['npm run api', 'npm run web'], url: 'http://localhost:5173' });

    const entry = (await loadWorkspaceConfig()).projects.find((project) => project.root === root) as Record<string, unknown>;
    expect(entry.startApp).toEqual({ services: ['npm run api', 'npm run web'], url: 'http://localhost:5173' });
    expect(effectiveStartApp(await readStartApp(dataDir, root))?.scope).toBe('personal');

    await writeStartApp(dataDir, root, 'personal', null);
    expect(effectiveStartApp(await readStartApp(dataDir, root))?.scope).toBe('project');
  });

  it('refuses to save a team recipe over a malformed repo config instead of replacing it', async () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'config.json'), '{ "baseBranch": "develop", ');

    await expect(writeStartApp(dataDir, root, 'project', { services: ['npm run dev'] })).rejects.toThrow(/malformed/);
    expect(readFileSync(join(dataDir, 'config.json'), 'utf8')).toBe('{ "baseBranch": "develop", ');
  });

  it('reads a malformed recipe as none, and has nowhere to keep a personal one for an unregistered project', async () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ startApp: { services: [] } }));
    expect((await readStartApp(dataDir, root)).project).toBeNull();

    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'cez-start-app-other-')));
    try {
      expect((await readStartApp(join(elsewhere, '.ai/cezar'), elsewhere)).personalAvailable).toBe(false);
      expect(await writeStartApp(join(elsewhere, '.ai/cezar'), elsewhere, 'personal', { services: ['x'] })).toBe(false);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
