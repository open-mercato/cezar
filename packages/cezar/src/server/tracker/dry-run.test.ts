import { describe, expect, it } from 'vitest';
import { trackerCandidatesQuerySchema, trackerListQuerySchema, trackerSearchQuerySchema, trackerItemsResultSchema } from '@open-mercato/cezar-contract';
import { createDryTrackerClient } from './dry-run.ts';

const prefixes = { jira: 'DEMO', linear: 'ENG', clickup: 'CU' } as const;
const webUrls = { jira: 'https://demo.atlassian.net', linear: 'https://linear.app/demo', clickup: 'https://app.clickup.com/demo' } as const;
for (const kind of ['jira', 'linear', 'clickup'] as const) describe(`${kind} offline fixture`, () => {
  it('reaches candidate 51 and preserves long handoff descriptions', async () => {
    const client = createDryTrackerClient(kind);
    const first = await client.listCandidates(trackerCandidatesQuerySchema.parse({ kind }));
    expect(first.available).toBe(true);
    if (!first.available) return;
    const next = await client.listCandidates(trackerCandidatesQuerySchema.parse({ kind, cursor: first.nextCursor }));
    expect(next.available && next.candidates[0]?.id).toBe('51');
    const associated = await client.resolveAssociation({ kind, externalId: '51', sourceId: first.source.id });
    if (!associated.available) throw new Error('fixture association failed');
    const driver = client.driver(associated.association);
    const list = await driver.listIssues(trackerListQuerySchema.parse({}));
    expect(trackerItemsResultSchema.safeParse(list).success).toBe(true);
    if (!list.available) throw new Error('fixture list failed');
    expect(list.items.find(row => row.id.endsWith('-2'))?.bodyTruncated).toBe(true);
    const detail = await driver.getItem(`${prefixes[kind]}51-2`);
    expect(detail.available && detail.item.body).toContain('Acceptance: preserve all requirements.');
    expect(detail.available && detail.item.bodyTruncated).toBe(false);
    const search = await driver.searchItems(trackerSearchQuerySchema.parse({ q: 'task 125' }));
    expect(search.available && search.items.length).toBe(1);
  });
  it('rejects forged and cross-project direct lookups', async () => {
    const client = createDryTrackerClient(kind);
    const assoc = { kind, source: { id: `dry-${kind}`, webUrl: webUrls[kind] }, externalId: '1', externalName: 'One' };
    const first = client.driver(assoc);
    const second = client.driver({ ...assoc, externalId: '2' });
    const id = `${prefixes[kind]}1-1`;
    expect(await first.getItem(id)).toMatchObject({ available: true });
    expect(await second.getItem(id)).toMatchObject({ available: false, code: 'not_found' });
    expect(await client.driver({ ...assoc, externalId: '9999' }).getItem(id)).toMatchObject({ available: false });
  });
  it('does not silently reuse a scope after a source change', async () => {
    const client = createDryTrackerClient(kind);
    const driver = client.driver({ kind, source: { id: 'other', webUrl: 'https://other.test' }, externalId: '1', externalName: 'Wrong' });
    expect(await driver.getItem('DEMO-1')).toMatchObject({ available: false, code: 'source_changed' });
  });
});

it('opens a ClickUp space onto a connectable folder and list offline', async () => {
  const client = createDryTrackerClient('clickup');
  const root = await client.listCandidates(trackerCandidatesQuerySchema.parse({ kind: 'clickup' }));
  expect(root.available && root.candidates[0]).toMatchObject({ id: '1', hasChildren: true });
  const opened = await client.listCandidates(trackerCandidatesQuerySchema.parse({ kind: 'clickup', parent: '1' }));
  if (!opened.available) throw new Error('fixture failed');
  expect(opened.candidates.map(row => row.name)).toEqual(['Folder 1', 'List 1']);
  const connected = await client.resolveAssociation({ kind: 'clickup', externalId: opened.candidates[0]!.id, sourceId: opened.source.id });
  if (!connected.available) throw new Error('fixture association failed');
  expect(await client.driver(connected.association).listIssues(trackerListQuerySchema.parse({}))).toMatchObject({ available: true });
});
