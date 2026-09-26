import { expect, it, vi } from 'vitest';
import {
  createLinearEventSource,
  mapLinearHistory,
  linearEventCapabilities,
} from './linear-events.ts';
const association = {
  kind: 'linear' as const,
  source: { id: 'org', webUrl: 'https://linear.app/team' },
  externalId: 'team',
  externalName: 'Team',
};
const issue = {
  id: 'id',
  key: 'T-1',
  title: 'Test',
  url: 'https://linear.app/team/issue/T-1',
  createdAt: '2026-09-19T00:01:00Z',
  status: 'Done',
  labels: [],
};
it('maps literal history transitions and labels without synthesizing absent early changes', () => {
  const history = [
    {
      id: 'h1',
      createdAt: '2026-09-19T01:00:00Z',
      fromStateId: 'todo',
      toStateId: 'progress',
      addedLabelIds: ['label'],
      removedLabelIds: [],
    },
    {
      id: 'h2',
      createdAt: '2026-09-19T02:00:00Z',
      fromStateId: 'progress',
      toStateId: 'todo',
      addedLabelIds: [],
      removedLabelIds: ['label'],
    },
  ];
  expect(
    mapLinearHistory(association, issue, history)
      .filter((x) => x.event === 'issue.status_changed')
      .map((x) => x.change.toId),
  ).toEqual(['progress', 'todo']);
  expect(mapLinearHistory(association, issue, [])).toEqual([]);
  expect(linearEventCapabilities).toEqual(['issue.opened']);
});
it('discovers archived issues and uses immutable creation time', async () => {
  let query = '';
  const source = createLinearEventSource(association, async (q) => {
    query = q;
    return {
      issues: {
        nodes: [
          {
            ...issue,
            identifier: issue.key,
            team: { id: 'team' },
            state: { name: 'Done' },
            labels: { nodes: [], pageInfo: { hasNextPage: false } },
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    };
  });
  const page = await source.poll({
    baselineAt: '2026-09-19T00:00:00Z',
    now: '2026-09-19T03:00:00Z',
    event: 'issue.opened',
    limit: 1,
    signal: new AbortController().signal,
  });
  expect(page.candidates[0]?.timestamp).toBe('2026-09-19T00:01:00.000Z');
  expect(query).toContain('includeArchived: true');
  expect(page.complete).toBe(true);
});
it('restarts a rejected continuation once per poll without moving the watermark', async () => {
  let count = 0;
  const source = createLinearEventSource(association, async () => {
    if (++count === 1)
      return {
        issues: {
          nodes: [],
          pageInfo: { hasNextPage: true, endCursor: 'expired' },
        },
      };
    const { TrackerRequestError } = await import('./transport.ts');
    throw new TrackerRequestError(
      'invalid_cursor',
      'Linear cursor expired.',
    );
  });
  const page = await source.poll({
    baselineAt: '2026-09-19T00:00:00Z',
    now: '2026-09-19T03:00:00Z',
    event: 'issue.opened',
    limit: 25,
    signal: new AbortController().signal,
  });
  expect(page.complete).toBe(false);
  expect(JSON.parse(page.checkpoint)).toMatchObject({
    watermark: '2026-09-19T00:00:00Z',
    discovered: false,
  });
  expect(count).toBe(2);
});


it('preserves the Linear continuation when a slow page exhausts the scan budget', async () => {
  const { runOperation } = await import('./transport.ts');
  vi.useFakeTimers();
  try {
    const source = createLinearEventSource(association, async (_query, variables, signal) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 1750);
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
      });
      return { issues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: String(Number(variables.after ?? 0) + 1) } } };
    });
    const result = runOperation(signal => source.poll({ baselineAt: '2026-09-19T00:00:00Z', now: '2026-09-19T03:00:00Z', event: 'issue.opened', limit: 25, signal }));
    await Promise.all([expect(result).resolves.toMatchObject({ complete: false }), vi.advanceTimersByTimeAsync(10_000)]);
    expect(JSON.parse((await result).checkpoint)).toMatchObject({ cursor: '4', discovered: true, watermark: '2026-09-19T00:00:00Z' });
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it('rejects incomplete labels instead of completing a scan with a partial label snapshot', async () => {
  let truncated = true;
  const source = createLinearEventSource(association, async () => ({
    issues: {
      nodes: [{
        ...issue,
        identifier: issue.key,
        team: { id: 'team' },
        state: { name: 'Done' },
        labels: {
          nodes: truncated
            ? Array.from({ length: 100 }, (_, i) => ({ name: `label-${i}` }))
            : [{ name: 'bug' }],
          pageInfo: { hasNextPage: truncated },
        },
      }],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  }));
  const input = {
    baselineAt: '2026-09-19T00:00:00Z',
    now: '2026-09-19T03:00:00Z',
    event: 'issue.opened' as const,
    limit: 25,
    signal: new AbortController().signal,
  };
  // A rejected poll returns no successful checkpoint for the scheduler to save.
  await expect(source.poll(input)).rejects.toMatchObject({ code: 'invalid_response' });
  truncated = false;
  const retry = await source.poll(input);
  expect(retry.complete).toBe(true);
  expect(retry.candidates).toHaveLength(1);
  expect(retry.candidates[0]?.labels).toEqual(['bug']);
});

it('preserves a continuation on an upstream HTTP 503 instead of returning a reset checkpoint', async () => {
  const { TrackerHttp } = await import('./transport.ts');
  let failing = false;
  const http = new TrackerHttp(async () => failing
    ? new Response('Unavailable', { status: 503 })
    : Response.json({ issues: { nodes: [{ ...issue, identifier: issue.key, team: { id: 'team' }, state: { name: 'Done' }, labels: { nodes: [], pageInfo: { hasNextPage: false } } }], pageInfo: { hasNextPage: true, endCursor: 'page-2' } } }));
  let recovering = false;
  let resumedCursor: unknown;
  const source = createLinearEventSource(association, (_q, variables, signal) => {
    resumedCursor = variables.after;
    return recovering
      ? Promise.resolve({ issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } })
      : http.json('https://synthetic.invalid', {}, signal);
  });
  const input = { baselineAt: '2026-09-19T00:00:00Z', now: '2026-09-19T03:00:00Z', event: 'issue.opened' as const, limit: 1, signal: new AbortController().signal };
  const first = await source.poll(input);
  expect(JSON.parse(first.checkpoint).cursor).toBe('page-2');
  failing = true;
  await expect(source.poll({ ...input, checkpoint: first.checkpoint })).rejects.toMatchObject({ code: 'unavailable' });
  recovering = true;
  const retry = await source.poll({ ...input, checkpoint: first.checkpoint });
  expect(resumedCursor).toBe('page-2');
  expect(retry.complete).toBe(true);
});
