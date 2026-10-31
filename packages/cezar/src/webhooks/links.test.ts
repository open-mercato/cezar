import { describe, expect, it } from 'vitest';
import { freshServerState } from '../server-install/types.ts';
import { hostedTaskLink } from './links.ts';
const record = () => ({ instance: 'default', state: { ...freshServerState(), installed: true, platform: 'ubuntu-vps', instanceId: 'install-local', primaryPort: 4321, publicUrl: 'https://cockpit.example.com' } });
describe('trusted hosted task links', () => {
  it('requires one installed record matching both actual port and service identity', () => {
    expect(hostedTaskLink([record()], 'hosted', 4321, 'install-local', 'project', 'task-1')).toBe('https://cockpit.example.com/p/project/tasks/task-1');
    expect(hostedTaskLink([record()], 'local', 4321, 'install-local', 'project', 'task-1')).toBeUndefined();
    expect(hostedTaskLink([record()], 'hosted', 9999, 'install-local', 'project', 'task-1')).toBeUndefined();
    expect(hostedTaskLink([record()], 'hosted', 4321, undefined, 'project', 'task-1')).toBeUndefined();
    expect(hostedTaskLink([record(), record()], 'hosted', 4321, 'install-local', 'project', 'task-1')).toBeUndefined();
  });
  it.each(['http://cockpit.example.com', 'https://user@cockpit.example.com', 'https://cockpit.example.com/?token=x', 'https://cockpit.example.com/#fragment'])('omits unsafe installer URL %s', publicUrl => {
    const entry = record(); entry.state.publicUrl = publicUrl;
    expect(hostedTaskLink([entry], 'hosted', 4321, 'install-local', 'project', 'task-1')).toBeUndefined();
  });
  it('omits preview and unknown/remote platform records', () => {
    const entry = record(); entry.state.dryRun = true;
    expect(hostedTaskLink([entry], 'hosted', 4321, 'install-local', 'project', 'task-1')).toBeUndefined();
    entry.state.dryRun = false; entry.state.platform = 'remote';
    expect(hostedTaskLink([entry], 'hosted', 4321, 'install-local', 'project', 'task-1')).toBeUndefined();
  });
});

import { canonicalTrackerLink } from './links.ts';
import type { TrackerAssociation } from '@open-mercato/cezar-contract';
it('rebuilds Jira links only for the currently connected association', () => {
  const association: TrackerAssociation = { kind: 'jira', source: { id: 'tenant', webUrl: 'https://acme.atlassian.net' }, externalId: 'project-1', externalName: 'Project', connectionId: '00000000-0000-4000-8000-000000000001' };
  const tracker = { association, provider: 'jira' as const, key: 'APP-42', url: 'https://acme.atlassian.net/browse/APP-42?secret=drop' };
  expect(canonicalTrackerLink(tracker, association)).toBe('https://acme.atlassian.net/browse/APP-42');
  expect(canonicalTrackerLink(tracker, { ...association, externalId: 'another-project' })).toBeUndefined();
  expect(canonicalTrackerLink({ ...tracker, url: 'https://foreign.atlassian.net/browse/APP-42' }, association)).toBeUndefined();
  expect(canonicalTrackerLink({ ...tracker, url: 'https://acme.atlassian.net/browse/OTHER-42' }, association)).toBeUndefined();
  expect(canonicalTrackerLink(tracker, null)).toBeUndefined();
});
it('validates Linear workspace, association and key, discarding untrusted title slugs', () => {
  const association: TrackerAssociation = { kind: 'linear', source: { id: 'org', webUrl: 'https://linear.app/acme' }, externalId: 'team-1', externalName: 'Team', connectionId: '00000000-0000-4000-8000-000000000001' };
  const tracker = { association, provider: 'linear' as const, key: 'APP-42', url: 'https://linear.app/acme/issue/APP-42/private-title?secret=drop' };
  expect(canonicalTrackerLink(tracker, association)).toBe('https://linear.app/acme/issue/APP-42');
  expect(canonicalTrackerLink({ ...tracker, url: 'https://linear.app/foreign/issue/APP-42' }, association)).toBeUndefined();
  expect(canonicalTrackerLink({ ...tracker, association: undefined }, association)).toBeUndefined();
});
