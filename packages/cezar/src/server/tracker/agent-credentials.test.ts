import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { TrackerAssociation } from '@open-mercato/cezar-contract';
import { writeTrackerAssociation } from '../../tracker-association.ts';
import { TrackerConnections } from './connections.ts';
import { resolveTrackerAgentEnv } from './agent-credentials.ts';
let root: string;
let project: string;
let env: NodeJS.ProcessEnv;
let association: TrackerAssociation;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tracker-agent-env-'));
  project = join(root, 'project');
  await mkdir(project);
  env = { CEZ_HOME: join(root, 'home') };
  const record = await new TrackerConnections(env).write(project, { kind: 'jira', origin: 'https://acme.atlassian.net', email: 'a@acme.com', token: 'synthetic-token' });
  association = { kind: 'jira', source: { id: 'https://acme.atlassian.net', webUrl: 'https://acme.atlassian.net' }, externalId: 'SAM', externalName: 'Sam', connectionId: record!.id };
  await writeTrackerAssociation(join(project, '.ai/cezar'), association);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
it('maps only the bound connection to agent env', async () => {
  expect(await resolveTrackerAgentEnv(project, association, env)).toEqual({ JIRA_BASE_URL: 'https://acme.atlassian.net', JIRA_EMAIL: 'a@acme.com', JIRA_API_TOKEN: 'synthetic-token' });
});
it('never substitutes a rotated credential', async () => {
  await new TrackerConnections(env).write(project, { kind: 'jira', origin: 'https://acme.atlassian.net', email: 'a@acme.com', token: 'replacement-token' });
  await expect(resolveTrackerAgentEnv(project, association, env)).rejects.toThrow(/connection|scope/i);
});
it.each(['externalId', 'source', 'kind'] as const)('rejects a changed %s', async (field) => {
  await writeTrackerAssociation(join(project, '.ai/cezar'), { ...association, [field]: field === 'source' ? { ...association.source, id: 'different' } : field === 'kind' ? 'linear' : 'different' });
  await expect(resolveTrackerAgentEnv(project, association, env)).rejects.toThrow(/connection|scope/i);
});
it('legacy and dry runs never receive real credentials', async () => {
  expect(await resolveTrackerAgentEnv(project, undefined, env)).toEqual({});
  expect(await resolveTrackerAgentEnv(project, association, { ...env, CEZ_DRY_RUN: '1' })).toEqual({});
});

it('rejects a removed connection', async () => {
  await new TrackerConnections(env).remove(project);
  await expect(resolveTrackerAgentEnv(project, association, env)).rejects.toThrow(/connection|scope/i);
});
it('maps a bound Linear connection', async () => {
  const record = await new TrackerConnections(env).write(project, { kind: 'linear', key: 'synthetic-linear-key' });
  const linear = { ...association, kind: 'linear' as const, connectionId: record!.id };
  await writeTrackerAssociation(join(project, '.ai/cezar'), linear);
  expect(await resolveTrackerAgentEnv(project, linear, env)).toEqual({ LINEAR_API_KEY: 'synthetic-linear-key' });
});
