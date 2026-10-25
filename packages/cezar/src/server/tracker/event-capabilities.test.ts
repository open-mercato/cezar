import { expect, it } from 'vitest';
import { createJiraClient } from './jira.ts';
import { createLinearClient } from './linear.ts';
const jira = {
  kind: 'jira' as const,
  source: { id: 'cloud', webUrl: 'https://example.atlassian.net' },
  externalId: '1',
  externalName: 'Test',
};
const linear = {
  kind: 'linear' as const,
  source: { id: 'org', webUrl: 'https://linear.app/acme' },
  externalId: '11111111-1111-4111-8111-111111111111',
  externalName: 'Test',
};
const input = {
  baselineAt: '2026-09-19T00:00:00Z',
  limit: 25,
  signal: new AbortController().signal,
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
it('gates unverified event capabilities without network requests', async () => {
  const client = createLinearClient({ key: 'synthetic' }, async () => {
    throw new Error('unexpected fetch');
  });
  expect(await client.driver(linear).automationOptions!()).toMatchObject({
    events: ['issue.opened'],
  });
  await expect(
    client.driver(linear).pollEvents!({
      ...input,
      event: 'issue.status_changed',
    }),
  ).rejects.toMatchObject({ code: 'unavailable' });
  const other = createJiraClient(
    {
      origin: jira.source.webUrl,
      email: 'test@example.test',
      token: 'synthetic',
    },
    async () => {
      throw new Error('unexpected fetch');
    },
  );
  await expect(
    other.driver(jira).pollEvents!({ ...input, event: 'issue.labeled' }),
  ).rejects.toMatchObject({ code: 'unavailable' });
});
it('turns malformed event payloads into sanitized provider errors', async () => {
  const client = createJiraClient(
    {
      origin: jira.source.webUrl,
      email: 'test@example.test',
      token: 'synthetic',
    },
    async (url) =>
      String(url).includes('tenant_info')
        ? json({ cloudId: 'cloud' })
        : json({ issues: 'invalid' }),
  );
  await expect(client.driver(jira).pollEvents!(input)).rejects.toMatchObject({
    code: 'invalid_response',
  });
});
it.each([403, 429])(
  'does not return an advanced checkpoint on HTTP %s',
  async (status) => {
    const client = createJiraClient(
      {
        origin: jira.source.webUrl,
        email: 'test@example.test',
        token: 'synthetic',
      },
      async (url) =>
        String(url).includes('tenant_info')
          ? json({ cloudId: 'cloud' })
          : json({}, status),
    );
    await expect(client.driver(jira).pollEvents!(input)).rejects.toMatchObject({
      code: status === 403 ? 'unauthorized' : 'rate_limited',
    });
  },
);
it('rejects partial GraphQL success before emitting opened events', async () => {
  const client = createLinearClient({ key: 'synthetic' }, async (_url, init) =>
    String(init?.body).includes('TrackerSource')
      ? json({ data: { organization: { id: 'org', urlKey: 'acme' } } })
      : json({
          data: {
            issues: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
          errors: [{ message: 'synthetic provider detail' }],
        }),
  );
  await expect(client.driver(linear).pollEvents!(input)).rejects.toMatchObject({
    code: 'unavailable',
  });
});
