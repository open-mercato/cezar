import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackerFailureSchema, trackerReadScope, type TrackerAssociation } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

const mocks = vi.hoisted(() => ({ driver: vi.fn() }));
vi.mock('./tracker/index.ts', async importOriginal => {
  const original = await importOriginal<typeof import('./tracker/index.ts')>();
  return { ...original, createTrackerService: (...args: Parameters<typeof original.createTrackerService>) => ({ ...original.createTrackerService(...args), driver: mocks.driver }) };
});
const association: TrackerAssociation = { kind: 'jira', source: { id: 'site', webUrl: 'https://example.atlassian.net' }, externalId: 'P', externalName: 'Project', connectionId: '11111111-1111-4111-8111-111111111111' };
const expectedScope = JSON.stringify(['jira', 'site', 'https://example.atlassian.net', 'P', association.connectionId]);
const read = vi.fn();
let root: string;
let store: RunStore;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tracker-read-scope-api-'));
  store = RunStore.open(join(root, '.ai/cezar'));
  read.mockReset().mockResolvedValue({ available: false, code: 'unavailable', reason: 'Vendor reached' });
  mocks.driver.mockReset().mockResolvedValue({ association, listIssues: read, searchItems: read, getItem: read });
  app = createApp({ repoRoot: root, store, manager: {} as never, version: 'test' });
});
afterEach(() => { store.flush(); rmSync(root, { recursive: true, force: true }); });

const endpoints = ['/tracker', '/tracker/search?q=issue', '/tracker/P-1'];
const scopedUrl = (base: string, endpoint: string, scope?: string) => base + endpoint + (scope === undefined ? '' : `${endpoint.includes('?') ? '&' : '?'}expectedScope=${encodeURIComponent(scope)}`);

it.each(endpoints)('rejects stale browser identity before vendor read on %s', async endpoint => {
  const changes: TrackerAssociation[] = [
    { ...association, externalId: 'OTHER' },
    { ...association, kind: 'linear' },
    { ...association, source: { ...association.source, id: 'other-site' } },
    { ...association, source: { ...association.source, webUrl: 'https://other.atlassian.net' } },
    { ...association, connectionId: '22222222-2222-4222-8222-222222222222' },
  ];
  for (const current of changes) {
    mocks.driver.mockResolvedValue({ association: current, listIssues: read, searchItems: read, getItem: read });
    for (const base of ['/api/v1', '/api/v1/p/default']) {
      const response = await apiRequest(app, scopedUrl(base, endpoint, expectedScope));
      expect(response.status).toBe(200);
      expect(trackerFailureSchema.parse(await response.json())).toMatchObject({ available: false, code: 'source_changed' });
      expect(read).not.toHaveBeenCalled();
    }
  }
});

it.each(endpoints)('allows matching identity, display renames and legacy omitted scope on %s', async endpoint => {
  mocks.driver.mockResolvedValue({ association: { ...association, externalName: 'Renamed' }, listIssues: read, searchItems: read, getItem: read });
  for (const scope of [expectedScope, undefined]) {
    const response = await apiRequest(app, scopedUrl('/api/v1/p/default', endpoint, scope));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ reason: 'Vendor reached' });
  }
  expect(read).toHaveBeenCalledTimes(2);
});

it.each(endpoints)('bounds expectedScope in middleware on %s', async endpoint => {
  const response = await apiRequest(app, scopedUrl('/api/v1', endpoint, 'x'.repeat(4097)));
  expect(response.status).toBe(400);
  expect(mocks.driver).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});

it('encodes the public source tuple unambiguously and excludes the display name', () => {
  expect(trackerReadScope(association)).toBe(expectedScope);
  expect(trackerReadScope({ ...association, externalName: 'Renamed' })).toBe(expectedScope);
  const { connectionId: _connectionId, ...demo } = association;
  expect(JSON.parse(trackerReadScope(demo))).toEqual(['jira', 'site', 'https://example.atlassian.net', 'P', null]);
  expect(trackerReadScope({ ...demo, source: { ...demo.source, id: 'a:b' }, externalId: 'c' }))
    .not.toBe(trackerReadScope({ ...demo, source: { ...demo.source, id: 'a' }, externalId: 'b:c' }));
});
