import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TrackerAssociation } from '@open-mercato/cezar-contract';
import { writeTrackerAssociation } from '../../tracker-association.ts';
import { TrackerConnections } from './connections.ts';
import { taskTracker, type TrackerTaskBinding } from './task-access.ts';
let root: string;
let project: string;
let association: TrackerAssociation;
let binding: TrackerTaskBinding;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tracker-task-binding-'));
  project = join(root, 'project'); await mkdir(project);
  vi.stubEnv('CEZ_HOME', join(root, 'home'));
  const record = await new TrackerConnections().write(project, { kind: 'jira', origin: 'https://acme.atlassian.net', email: 'a@acme.com', token: 'synthetic-token' });
  association = { kind: 'jira', source: { id: 'cloud', webUrl: 'https://acme.atlassian.net' }, externalId: '100', externalName: 'Sam', connectionId: record!.id };
  await writeTrackerAssociation(join(project, '.ai/cezar'), association);
  binding = { automationId: 'a', automationRevision: 1, receiptId: 'r', provider: 'jira', association, issueId: '101', key: 'SAM-1', url: 'https://acme.atlassian.net/browse/SAM-1', access: { version: 1, writes: [] } };
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
it('returns scoped operations, not an environment containing credentials', async () => {
  const driver = await taskTracker(project, binding);
  expect(driver.context).toBeTypeOf('function');
  expect(JSON.stringify(driver)).not.toContain('synthetic-token');
});
it('never substitutes a rotated credential', async () => {
  await new TrackerConnections().write(project, { kind: 'jira', origin: 'https://acme.atlassian.net', email: 'a@acme.com', token: 'replacement-token' });
  await expect(taskTracker(project, binding)).rejects.toThrow();
});
it.each(['externalId', 'source', 'kind'] as const)('rejects a changed %s', async field => {
  await writeTrackerAssociation(join(project, '.ai/cezar'), { ...association, [field]: field === 'source' ? { ...association.source, id: 'different' } : field === 'kind' ? 'linear' : 'different' });
  await expect(taskTracker(project, binding)).rejects.toThrow();
});
it('refuses a run started before mediated access (no grant or issue ID)', async () => {
  await expect(taskTracker(project, { ...binding, access: undefined })).rejects.toThrow('before mediated tracker access');
  await expect(taskTracker(project, { ...binding, issueId: undefined })).rejects.toThrow('before mediated tracker access');
});
it('rejects a removed connection', async () => {
  await new TrackerConnections().remove(project);
  await expect(taskTracker(project, binding)).rejects.toThrow();
});
