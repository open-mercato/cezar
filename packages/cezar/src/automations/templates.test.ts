import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AutomationStore } from './store.ts';
import { automationTemplatesOf } from './templates.ts';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

async function project(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `cezar-templates-${name}-`));
  dirs.push(root);
  return root;
}

describe('automationTemplatesOf', () => {
  it('lists every other project\'s definitions as templates, in the palette shape', async () => {
    const storefront = await project('storefront');
    const api = await project('api');
    const me = await project('me');
    AutomationStore.open(join(storefront, '.ai/cezar')).create({
      name: 'Sync translations', enabled: true, kind: 'schedule', schedule: { type: 'weekdays', hour: 9, minute: 0 },
      task: { prompt: 'Pull new keys', workflow: 'quick-task', runner: 'claude', model: 'sonnet', autonomous: true, dispatch: { maxSubtasks: 4 } },
    }, 'sync');
    AutomationStore.open(join(api, '.ai/cezar')).create({
      name: 'Triage issues', enabled: false, kind: 'github', events: ['issue.opened'], intervalSeconds: 300, filters: { lookbackDays: 7, maxRecords: 25 },
      task: { prompt: 'Read {{github.url}}' },
    }, 'triage');
    AutomationStore.open(join(me, '.ai/cezar')).create({ name: 'Mine', enabled: false, kind: 'schedule', schedule: { type: 'daily' }, task: { prompt: 'x' } }, 'mine');

    const templates = automationTemplatesOf(
      [
        { id: 'storefront', root: storefront, name: 'storefront', status: 'ok' },
        { id: 'api', root: api, status: 'ok' },
        { id: 'me', root: me, name: 'me', status: 'ok' },
      ],
      'me',
    );
    expect(templates).toEqual([
      {
        project: { id: 'storefront', name: 'storefront' },
        id: 'sync', name: 'Sync translations', kind: 'schedule', schedule: { type: 'weekdays', hour: 9, minute: 0 },
        task: { prompt: 'Pull new keys', workflow: 'quick-task', runner: 'claude', model: 'sonnet', autonomous: true, dispatch: { maxSubtasks: 4 } },
      },
      {
        project: { id: 'api', name: expect.stringMatching(/^cezar-templates-api-/) },
        id: 'triage', name: 'Triage issues', kind: 'github', events: ['issue.opened'], intervalSeconds: 300,
        task: { prompt: 'Read {{github.url}}' },
      },
    ]);
  });

  it('skips projects that are missing, have no definitions, or cannot be read', async () => {
    const empty = await project('empty');
    const corrupt = await project('corrupt');
    mkdirSync(join(corrupt, '.ai/cezar'), { recursive: true });
    writeFileSync(join(corrupt, '.ai/cezar/automations.json'), '{ not json');
    const unreadable = await project('unreadable');
    mkdirSync(join(unreadable, '.ai/cezar'), { recursive: true });
    writeFileSync(join(unreadable, '.ai/cezar/automations.json'), '{}');
    chmodSync(join(unreadable, '.ai/cezar/automations.json'), 0o000);
    const templates = automationTemplatesOf([
      { id: 'gone', root: '/nowhere/at/all', status: 'missing' },
      { id: 'empty', root: empty, status: 'ok' },
      { id: 'corrupt', root: corrupt, status: 'ok' },
      { id: 'unreadable', root: unreadable, status: 'ok' },
    ]);
    chmodSync(join(unreadable, '.ai/cezar/automations.json'), 0o600);
    expect(templates).toEqual([]);
  });
});
