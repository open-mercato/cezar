import { describe, expect, it, vi } from 'vitest';
import {
  trackerAssociationResultSchema,
  trackerCandidatesResultSchema,
  trackerItemResultSchema,
  trackerItemsResultSchema,
  type TrackerAssociation,
} from '@open-mercato/cezar-contract';
import { createJiraClient } from './jira.ts';

const origin = 'https://acme.atlassian.net';
const gateway = 'https://api.atlassian.com/ex/jira/cloud-1';
const credentials = { origin, email: 'dev@example.com', token: 'jira-secret-token' };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function projectPage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    startAt: 0,
    maxResults: 50,
    total: 1,
    isLast: true,
    values: [{ id: '10000', key: 'PROJ', name: 'Project One' }],
    ...overrides,
  };
}

function issue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '10001',
    key: 'PROJ-1',
    fields: {
      project: { id: '10000' },
      summary: 'First issue',
      creator: { displayName: 'Ada Lovelace' },
      created: '2026-01-02T03:04:05.000+0000',
      updated: '2026-02-03T04:05:06.000+0000',
      labels: ['backend'],
      description: {
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Issue body' }] }],
      },
      status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
    },
    ...overrides,
  };
}

function association(sourceId = 'cloud-1', webUrl = origin): TrackerAssociation {
  return {
    kind: 'jira',
    source: { id: sourceId, webUrl },
    externalId: '10000',
    externalName: 'Project One',
  };
}

describe('Jira Cloud adapter', () => {
  it.each([401, 403])('falls back from the gateway on %s and remembers the site transport', async status => {
    const urls: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url === `${origin}/_edge/tenant_info`) return json({ cloudId: 'cloud-1' });
      if (url.startsWith(`${gateway}/rest/api/3/project/search`)) return json({}, status);
      if (url.startsWith(`${origin}/rest/api/3/project/search`)) return json(projectPage());
      throw new Error(`Unexpected URL: ${url}`);
    }) as unknown as typeof fetch;

    const client = createJiraClient(credentials, fetcher);
    expect(trackerCandidatesResultSchema.parse(await client.listCandidates({ kind: 'jira', q: 'one', limit: 50 }))).toMatchObject({
      available: true,
      source: { id: 'cloud-1', webUrl: origin },
    });
    expect((await client.listCandidates({ kind: 'jira', q: 'two', limit: 50 })).available).toBe(true);

    expect(urls.filter(url => url.startsWith(`${gateway}/rest/`))).toHaveLength(1);
    expect(urls.filter(url => url.startsWith(`${origin}/rest/`))).toHaveLength(2);
  });

  it('uses opaque, query-bound cursors for Jira project pagination', async () => {
    const starts: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/_edge/tenant_info') return json({ cloudId: 'cloud-1' });
      starts.push(url.searchParams.get('startAt') ?? 'missing');
      return starts.length === 1
        ? json(projectPage({ startAt: 0, maxResults: 2, total: 3, isLast: false, values: [
            { id: '10000', key: 'ONE', name: 'One' },
            { id: '10001', key: 'TWO', name: 'Two' },
          ] }))
        : json(projectPage({ startAt: 2, maxResults: 2, total: 3, isLast: true, values: [
            { id: '10002', key: 'THREE', name: 'Three' },
          ] }));
    }) as unknown as typeof fetch;

    const client = createJiraClient(credentials, fetcher);
    const first = trackerCandidatesResultSchema.parse(await client.listCandidates({ kind: 'jira', q: 'project', limit: 2 }));
    expect(first).toMatchObject({ available: true, truncated: true });
    if (!first.available) throw new Error('expected a successful page');
    expect(first.nextCursor).not.toContain('startAt');
    const second = trackerCandidatesResultSchema.parse(await client.listCandidates({
      kind: 'jira', q: 'project', limit: 2, cursor: first.nextCursor,
    }));
    expect(second).toMatchObject({ available: true, truncated: false, candidates: [{ id: '10002', name: 'Three' }] });
    expect(starts).toEqual(['0', '2']);

    const wrongQuery = await client.listCandidates({ kind: 'jira', q: 'different', limit: 2, cursor: first.nextCursor });
    expect(wrongQuery).toMatchObject({ available: false, code: 'invalid_cursor' });
  });

  it('resolves only numeric canonical project IDs and binds the origin and cloud ID', async () => {
    const urls: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url === `${origin}/_edge/tenant_info`) return json({ cloudId: 'cloud-1' });
      if (url === `${gateway}/rest/api/3/project/10000`) {
        return json({ id: '10000', key: 'PROJ', name: 'Canonical Project' });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as unknown as typeof fetch;

    const client = createJiraClient(credentials, fetcher);
    const invalid = trackerAssociationResultSchema.parse(await client.resolveAssociation({
      kind: 'jira', externalId: '../PROJ', sourceId: 'cloud-1',
    }));
    expect(invalid).toMatchObject({ available: false, code: 'not_found' });
    expect(urls).toEqual([`${origin}/_edge/tenant_info`]);

    const resolved = trackerAssociationResultSchema.parse(await client.resolveAssociation({
      kind: 'jira', externalId: '10000', sourceId: 'cloud-1',
    }));
    expect(resolved).toEqual({
      available: true,
      association: {
        kind: 'jira',
        source: { id: 'cloud-1', webUrl: origin },
        externalId: '10000',
        externalName: 'Canonical Project',
      },
    });
  });

  it('escapes search text and labels as JQL values and adds exact issue-key lookup', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === `${origin}/_edge/tenant_info`) return json({ cloudId: 'cloud-1' });
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return json({ isLast: true, issues: [] });
    }) as unknown as typeof fetch;

    const driver = createJiraClient(credentials, fetcher).driver(association());
    expect((await driver.searchItems({
      q: 'x" OR project = 9 \\ y',
      limit: 50,
      state: 'active',
      labels: ['team"red', 'back\\slash'],
    })).available).toBe(true);
    expect((await driver.searchItems({ q: 'PROJ-123', limit: 50, state: 'all' })).available).toBe(true);

    expect(bodies[0]?.jql).toBe(
      'project = 10000 AND statusCategory != Done AND labels = "team\\"red" AND labels = "back\\\\slash" AND text ~ "x\\" OR project = 9 \\\\ y" ORDER BY updated DESC',
    );
    expect(bodies[1]?.jql).toBe(
      'project = 10000 AND (key = "PROJ-123" OR text ~ "PROJ-123") ORDER BY updated DESC',
    );
  });

  it('uses Jira continuation tokens and binds them to the complete issue query', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === `${origin}/_edge/tenant_info`) return json({ cloudId: 'cloud-1' });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      return bodies.length === 1
        ? json({ isLast: false, nextPageToken: 'jira-page-two', issues: [issue()] })
        : json({ isLast: true, issues: [] });
    }) as unknown as typeof fetch;

    const driver = createJiraClient(credentials, fetcher).driver(association());
    const first = trackerItemsResultSchema.parse(await driver.listIssues({ limit: 1, state: 'active', labels: ['backend'] }));
    expect(first).toMatchObject({ available: true, truncated: true });
    if (!first.available) throw new Error('expected a successful page');
    const second = trackerItemsResultSchema.parse(await driver.listIssues({
      limit: 1, state: 'active', labels: ['backend'], cursor: first.nextCursor,
    }));
    expect(second).toMatchObject({ available: true, truncated: false, items: [] });
    expect(bodies[1]?.nextPageToken).toBe('jira-page-two');

    const wrongScope = await driver.listIssues({ limit: 1, state: 'all', labels: ['backend'], cursor: first.nextCursor });
    expect(wrongScope).toMatchObject({ available: false, code: 'invalid_cursor' });
  });

  it('rejects a changed Jira source before an authenticated request', async () => {
    const urls: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      return json({ cloudId: 'cloud-2' });
    }) as unknown as typeof fetch;

    const result = await createJiraClient(credentials, fetcher).driver(association('cloud-1')).listIssues({
      limit: 50, state: 'active',
    });
    expect(result).toMatchObject({ available: false, code: 'source_changed' });
    expect(urls).toEqual([`${origin}/_edge/tenant_info`]);

    const originChanged = await createJiraClient(credentials, fetcher).driver(association('cloud-2', 'https://other.atlassian.net')).listIssues({
      limit: 50, state: 'active',
    });
    expect(originChanged).toMatchObject({ available: false, code: 'source_changed' });
  });

  it('enforces project scope and validates issue keys on direct detail lookup', async () => {
    const urls: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url === `${origin}/_edge/tenant_info`) return json({ cloudId: 'cloud-1' });
      if (url.includes('/rest/api/3/issue/OTHER-2')) {
        return json(issue({ key: 'OTHER-2', fields: { ...(issue().fields as object), project: { id: '20000' } } }));
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as unknown as typeof fetch;

    const driver = createJiraClient(credentials, fetcher).driver(association());
    expect(await driver.getItem('../PROJ-1')).toMatchObject({ available: false, code: 'not_found' });
    const result = trackerItemResultSchema.parse(await driver.getItem('OTHER-2'));
    expect(result).toMatchObject({ available: false, code: 'not_found' });
    expect(urls.some(url => url.includes('..'))).toBe(false);
  });

  it('caps preview and detail descriptions independently and preserves ADF loss flags', async () => {
    const longText = 'x'.repeat(70_000);
    const longIssue = issue({
      fields: {
        ...(issue().fields as object),
        description: {
          type: 'doc', version: 1, content: [
            { type: 'paragraph', content: [{ type: 'text', text: longText }] },
            { type: 'mystery', attrs: { text: 'unsupported value' } },
          ],
        },
      },
    });
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === `${origin}/_edge/tenant_info`) return json({ cloudId: 'cloud-1' });
      if (url.includes('/search/jql')) return json({ isLast: true, issues: [longIssue] });
      return json(longIssue);
    }) as unknown as typeof fetch;

    const driver = createJiraClient(credentials, fetcher).driver(association());
    const page = trackerItemsResultSchema.parse(await driver.listIssues({ limit: 50, state: 'all' }));
    if (!page.available) throw new Error('expected a successful page');
    expect(page.items[0]?.body).toHaveLength(8_000);
    expect(page.items[0]).toMatchObject({ bodyTruncated: true, unsupportedContent: true });

    const detail = trackerItemResultSchema.parse(await driver.getItem('PROJ-1'));
    if (!detail.available) throw new Error('expected a successful detail');
    expect(detail.item.body).toHaveLength(60_000);
    expect(detail.item).toMatchObject({ bodyTruncated: true, unsupportedContent: true });
  });

  it('normalizes Jira timestamps and maps issue fields without leaking gateway URLs', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === `${origin}/_edge/tenant_info`) return json({ cloudId: 'cloud-1' });
      return json(issue());
    }) as unknown as typeof fetch;

    const result = trackerItemResultSchema.parse(await createJiraClient(credentials, fetcher).driver(association()).getItem('PROJ-1'));
    expect(result).toEqual({
      available: true,
      item: {
        kind: 'issue',
        id: 'PROJ-1',
        title: 'First issue',
        author: 'Ada Lovelace',
        createdAt: '2026-01-02T03:04:05.000Z',
        updatedAt: '2026-02-03T04:05:06.000Z',
        labels: ['backend'],
        body: 'Issue body',
        bodyTruncated: false,
        unsupportedContent: false,
        url: `${origin}/browse/PROJ-1`,
        status: 'In Progress',
      },
    });
  });

  it('returns controlled invalid-response failures for malformed vendor data', async () => {
    const fetcher = vi.fn(async () => json({ cloudId: '' })) as unknown as typeof fetch;
    const result = trackerCandidatesResultSchema.parse(await createJiraClient(credentials, fetcher).listCandidates({
      kind: 'jira', limit: 50,
    }));
    expect(result).toMatchObject({ available: false, code: 'invalid_response' });
  });

  it('maps list not-found to unavailable and never exposes raw or derived credentials', async () => {
    const derived = Buffer.from(`${credentials.email}:${credentials.token}`).toString('base64');
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === `${origin}/_edge/tenant_info`) return json({ cloudId: 'cloud-1' });
      return json({ errorMessages: [credentials.token], errors: { auth: derived } }, 400);
    }) as unknown as typeof fetch;

    const result = await createJiraClient(credentials, fetcher).driver(association()).listIssues({ limit: 50, state: 'all' });
    expect(result).toMatchObject({ available: false, code: 'unavailable' });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(credentials.token);
    expect(serialized).not.toContain(credentials.email);
    expect(serialized).not.toContain(derived);
  });

  it('clears cached source identity and successful pages', async () => {
    let tenantReads = 0;
    let projectReads = 0;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === `${origin}/_edge/tenant_info`) {
        tenantReads++;
        return json({ cloudId: 'cloud-1' });
      }
      projectReads++;
      return json(projectPage());
    }) as unknown as typeof fetch;

    const client = createJiraClient(credentials, fetcher);
    await client.listCandidates({ kind: 'jira', limit: 50 });
    await client.listCandidates({ kind: 'jira', limit: 50 });
    expect({ tenantReads, projectReads }).toEqual({ tenantReads: 1, projectReads: 1 });
    client.clearCache();
    await client.listCandidates({ kind: 'jira', limit: 50 });
    expect({ tenantReads, projectReads }).toEqual({ tenantReads: 2, projectReads: 2 });
  });

  it('refreshes and replaces the cached page for the same semantic query', async () => {
    let issueReads = 0;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === `${origin}/_edge/tenant_info`) return json({ cloudId: 'cloud-1' });
      issueReads++;
      return json({
        isLast: true,
        issues: [issue({ key: `PROJ-${issueReads}`, id: String(10_000 + issueReads) })],
      });
    }) as unknown as typeof fetch;

    const driver = createJiraClient(credentials, fetcher).driver(association());
    const first = await driver.listIssues({ limit: 50, state: 'all' });
    const refreshed = await driver.listIssues({ limit: 50, state: 'all', refresh: '1' });
    const cached = await driver.listIssues({ limit: 50, state: 'all' });
    expect(first.available && first.items[0]?.id).toBe('PROJ-1');
    expect(refreshed.available && refreshed.items[0]?.id).toBe('PROJ-2');
    expect(cached.available && cached.items[0]?.id).toBe('PROJ-2');
    expect(issueReads).toBe(2);
  });
});


describe('Jira historical keys and failed reads', () => {
  it.each(['10000', '20000'])('classifies a historical key by numeric project %s', async projectId => {
    const fetcher = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith('/_edge/tenant_info') ? json({ cloudId: 'cloud-1' }) :
        json(issue({ key: 'NEW-1', fields: { ...(issue().fields as object), project: { id: projectId } } }))
    ) as unknown as typeof fetch;
    const result = await createJiraClient(credentials, fetcher).driver(association()).getItem('OLD-1');
    expect(result).toMatchObject(projectId === '10000'
      ? { available: true, item: { id: 'NEW-1', url: origin + '/browse/NEW-1' } }
      : { available: false, code: 'not_found' });
  });

  it.each([
    [429, 'rate_limited'], [503, 'unavailable'], [404, 'unavailable'],
    [200, 'invalid_response'],
  ] as const)('never falls back on gateway %s / %s', async (status, code) => {
    const urls: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      urls.push(String(input));
      return String(input).endsWith('/_edge/tenant_info')
        ? json({ cloudId: 'cloud-1' }) : new Response(credentials.token, { status });
    }) as unknown as typeof fetch;
    const client = createJiraClient(credentials, fetcher);
    const result = await client.listCandidates({ kind: 'jira', limit: 50 });
    expect(result).toMatchObject({ available: false, code });
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain(gateway);
    const serialized = JSON.stringify(result);
    for (const secret of [credentials.token, credentials.email, Buffer.from(credentials.email + ':' + credentials.token).toString('base64')])
      expect(serialized).not.toContain(secret);
    if (status === 429) {
      expect(await client.driver(association()).listIssues({ state: 'all', limit: 50, refresh: '1' })).toMatchObject({ code });
      expect(urls).toHaveLength(2);
    }
  });

  it.each([401, 403])('stops after one unsuccessful auth fallback (%s)', async status => {
    const fetcher = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith('/_edge/tenant_info') ? json({ cloudId: 'cloud-1' }) : json({}, status)
    ) as unknown as typeof fetch;
    expect(await createJiraClient(credentials, fetcher).listCandidates({ kind: 'jira', limit: 50 }))
      .toMatchObject({ available: false, code: 'unauthorized' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('maps direct missing objects to not_found after successful source discovery', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith('/_edge/tenant_info') ? json({ cloudId: 'cloud-1' }) : json({}, 404)
    ) as unknown as typeof fetch;
    const client = createJiraClient(credentials, fetcher);
    expect(await client.driver(association()).getItem('PROJ-2')).toMatchObject({ code: 'not_found' });
    expect(await client.resolveAssociation({ kind: 'jira', sourceId: 'cloud-1', externalId: '10000' }))
      .toMatchObject({ code: 'not_found' });
  });
});

it.each(['timeout', 'oversize'] as const)('does not fall back after gateway %s', async failure => {
  vi.useFakeTimers();
  try {
    const urls: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      urls.push(String(input));
      if (String(input).endsWith('/_edge/tenant_info')) return json({ cloudId: 'cloud-1' });
      if (failure === 'timeout') return await new Promise<Response>(() => {});
      return new Response('sensitive', { headers: { 'content-length': '2097153' } });
    }) as unknown as typeof fetch;
    const pending = createJiraClient(credentials, fetcher).listCandidates({ kind: 'jira', limit: 50 });
    if (failure === 'timeout') await vi.advanceTimersByTimeAsync(10_001);
    expect(await pending).toMatchObject({
      available: false, code: failure === 'timeout' ? 'unavailable' : 'invalid_response',
    });
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain(gateway);
  } finally { vi.useRealTimers(); }
});

it('revalidates detail on a subsequent request instead of renewing a cached snapshot', async () => {
  let reads = 0;
  let revoked = false;
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    if (String(input).endsWith('/_edge/tenant_info')) return json({ cloudId: 'cloud-1' });
    if (revoked) return json({}, 403);
    reads++;
    const row = issue();
    return json({ ...row, fields: { ...(row.fields as Record<string, unknown>), summary: `Revision ${reads}` } });
  }) as unknown as typeof fetch;
  const driver = createJiraClient(credentials, fetcher).driver(association());
  const initial = await Promise.all([driver.getItem('PROJ-1'), driver.getItem('PROJ-1')]);
  for (const result of initial) expect(result).toMatchObject({ available: true, item: { title: 'Revision 1' } });
  expect(reads).toBe(1);
  expect(await driver.getItem('PROJ-1')).toMatchObject({ available: true, item: { title: 'Revision 2' } });
  revoked = true;
  expect(await driver.getItem('PROJ-1')).toMatchObject({ available: false, code: 'unauthorized' });
});
