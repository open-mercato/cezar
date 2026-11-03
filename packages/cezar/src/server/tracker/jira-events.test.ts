import { afterEach, expect, it, vi } from 'vitest';
import { runOperation, TrackerRequestError } from './transport.ts';
import { createJiraEventSource as realJiraEventSource } from './jira-events.ts';
const createJiraEventSource: typeof realJiraEventSource = (association, request) =>
  realJiraEventSource(association, (path, init, signal) => path === '/rest/api/3/myself'
    ? Promise.resolve({ timeZone: 'UTC' }) : request(path, init, signal));
const association = {
  kind: 'jira' as const,
  source: { id: 'cloud', webUrl: 'https://example.atlassian.net' },
  externalId: '1',
  externalName: 'Test',
};
const issue = {
  id: '10',
  key: 'TEST-1',
  fields: {
    project: { id: '1' },
    summary: 'Test',
    created: '2026-09-18T00:00:00Z',
    status: { name: 'Done' },
    labels: [],
  },
};
it('preserves two historical transitions despite a different current status and resumes within history', async () => {
  const requests: string[] = [];
  const source = createJiraEventSource(association, async (path) => {
    requests.push(path);
    if (path.includes('/search/')) return { isLast: true, issues: [issue] };
    return {
      isLast: true,
      startAt: 0,
      maxResults: 100,
      values: [
        {
          id: 'h1',
          created: '2026-09-19T01:00:00Z',
          items: [
            {
              fieldId: 'status',
              from: 'todo',
              to: 'progress',
              toString: 'In Progress',
            },
          ],
        },
        {
          id: 'h2',
          created: '2026-09-19T02:00:00Z',
          items: [
            {
              fieldId: 'status',
              from: 'progress',
              to: 'todo',
              toString: 'To Do',
            },
          ],
        },
      ],
    };
  });
  const input = {
    baselineAt: '2026-09-19T00:00:00Z',
    now: '2026-09-19T03:00:00Z',
    event: 'issue.status_changed' as const,
    limit: 1,
    signal: new AbortController().signal,
  };
  const first = await source.poll(input);
  expect(first.complete).toBe(false);
  const second = await source.poll({ ...input, checkpoint: first.checkpoint });
  expect(
    [...first.candidates, ...second.candidates].map((x) => x.change.toId),
  ).toEqual(['progress', 'todo']);
  expect(
    new Set([...first.candidates, ...second.candidates].map((x) => x.eventId))
      .size,
  ).toBe(2);
  expect(second.complete).toBe(true);
  expect(requests).toHaveLength(2);
});
it('quotes the updated-since JQL date literal instead of emitting a bare epoch number', async () => {
  let jql = '';
  const source = createJiraEventSource(association, async (path, init) => {
    if (path.includes('/search/')) {
      jql = JSON.parse(init.body as string).jql as string;
      return { isLast: true, issues: [issue] };
    }
    return { isLast: true, startAt: 0, maxResults: 100, values: [] };
  });
  await source.poll({
    baselineAt: '2026-09-19T00:00:30Z',
    now: '2026-09-19T03:00:00Z',
    event: 'issue.status_changed',
    limit: 25,
    signal: new AbortController().signal,
  });
  expect(jql).toContain('updated >= "2026/09/19 00:00"');
  expect(jql).not.toMatch(/updated >= \d/);
});
it('never manufactures a status change from issue.updatedAt', async () => {
  const source = createJiraEventSource(association, async (path) =>
    path.includes('/search/')
      ? { isLast: true, issues: [issue] }
      : {
          isLast: true,
          startAt: 0,
          maxResults: 100,
          values: [
            {
              id: 'h',
              created: '2026-09-19T01:00:00Z',
              items: [{ fieldId: 'description', from: null, to: null }],
            },
          ],
        },
  );
  const page = await source.poll({
    baselineAt: '2026-09-19T00:00:00Z',
    now: '2026-09-19T03:00:00Z',
    event: 'issue.status_changed',
    limit: 25,
    signal: new AbortController().signal,
  });
  expect(page.candidates).toEqual([]);
});
it('bounds requests and resumes the dedicated history page after restart', async () => {
  const starts: string[] = [];
  const request = async (path: string) => {
    if (path.includes('/search/')) return { isLast: true, issues: [issue] };
    const start = new URL(path, 'https://example.test').searchParams.get(
      'startAt',
    )!;
    starts.push(start);
    return {
      isLast: Number(start) >= 8,
      startAt: Number(start),
      maxResults: 1,
      values: [{ id: `h${start}`, created: '2026-09-18T01:00:00Z', items: [] }],
    };
  };
  const input = {
    baselineAt: '2026-09-19T00:00:00Z',
    now: '2026-09-19T03:00:00Z',
    event: 'issue.status_changed' as const,
    limit: 25,
    signal: new AbortController().signal,
  };
  const first = await createJiraEventSource(association, request).poll(input);
  expect(first.complete).toBe(false);
  expect(starts).toHaveLength(6);
  const second = await createJiraEventSource(association, request).poll({
    ...input,
    checkpoint: first.checkpoint,
  });
  expect(second.complete).toBe(true);
  expect(starts).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8']);
});
it('rejects connection changes and preserves the old checkpoint on history failure', async () => {
  const input = {
    baselineAt: '2026-09-19T00:00:00Z',
    now: '2026-09-19T03:00:00Z',
    event: 'issue.opened' as const,
    limit: 25,
    signal: new AbortController().signal,
  };
  const page = await createJiraEventSource(association, async () => ({
    isLast: true,
    issues: [],
  })).poll(input);
  await expect(
    createJiraEventSource(
      { ...association, connectionId: 'new' },
      async () => ({}),
    ).poll({ ...input, checkpoint: page.checkpoint }),
  ).rejects.toMatchObject({ code: 'invalid_cursor' });
  await expect(
    createJiraEventSource(association, async (path) => {
      if (path.includes('/search/')) return { isLast: true, issues: [issue] };
      throw new Error('denied');
    }).poll({ ...input, event: 'issue.status_changed' }),
  ).rejects.toThrow('denied');
});
it('rescans overlap for delayed indexing without crossing the enable baseline', async () => {
  const input = {
    baselineAt: '2026-09-19T00:00:00Z',
    now: '2026-09-19T03:00:00Z',
    event: 'issue.opened' as const,
    limit: 25,
    signal: new AbortController().signal,
  };
  const first = await createJiraEventSource(association, async () => ({
    isLast: true,
    issues: [],
  })).poll(input);
  const delayed = {
    ...issue,
    fields: { ...issue.fields, created: '2026-09-19T02:59:00Z' },
  };
  const second = await createJiraEventSource(association, async () => ({
    isLast: true,
    issues: [delayed],
  })).poll({
    ...input,
    now: '2026-09-19T03:01:00Z',
    checkpoint: first.checkpoint,
  });
  expect(second.candidates).toHaveLength(1);
});
it('resets an expired provider cursor to the unfinished scan watermark', async () => {
  const input = {
    baselineAt: '2026-09-19T00:00:00Z',
    now: '2026-09-19T03:00:00Z',
    event: 'issue.opened' as const,
    limit: 25,
    signal: new AbortController().signal,
  };
  let requests = 0;
  const source = createJiraEventSource(association, async () => {
    requests++;
    return requests === 1
      ? { isLast: false, nextPageToken: 'expired', issues: [] }
      : { errorMessages: ['Invalid nextPageToken'] };
  });
  const page = await source.poll(input);
  expect(page.complete).toBe(false);
  const checkpoint = JSON.parse(page.checkpoint);
  expect(checkpoint.watermark).toBe(input.baselineAt);
  expect(checkpoint.cursor).toBeUndefined();
  expect(requests).toBe(2);
});

it('skips an unavailable queued issue with a visible gap and continues remaining history', async () => {
  const history: string[] = [];
  const source = createJiraEventSource(association, async path => {
    if (path.includes('/search/')) return { isLast: true, issues: [issue, { ...issue, id: '20', key: 'TEST-2' }] };
    history.push(path);
    if (path.includes('/10/')) throw new TrackerRequestError('not_found', 'Deleted');
    return { isLast: true, startAt: 0, maxResults: 100, values: [{ id: 'h2', created: '2026-09-19T01:00:00Z', items: [{ fieldId: 'status', from: 'progress', to: 'todo' }] }] };
  });
  const input = { baselineAt: '2026-09-19T00:00:00Z', now: '2026-09-19T03:00:00Z', event: 'issue.status_changed' as const, limit: 1, signal: new AbortController().signal };
  const first = await source.poll(input);
  expect(first.candidates.map(item => item.key)).toEqual(['TEST-2']);
  expect(first.gaps).toEqual([{ issueId: '10', key: 'TEST-1', reason: expect.stringContaining('not found') }]);
  expect(history).toHaveLength(2);
  expect(JSON.parse(first.checkpoint).issues).toEqual([]);
});

it('does not treat general authorization failure as a missing issue', async () => {
  const source = createJiraEventSource(association, async path => {
    if (path.includes('/search/')) return { isLast: true, issues: [issue] };
    throw new TrackerRequestError('unauthorized', 'Denied');
  });
  await expect(source.poll({ baselineAt: '2026-09-19T00:00:00Z', now: '2026-09-19T03:00:00Z', event: 'issue.status_changed', limit: 25, signal: new AbortController().signal })).rejects.toMatchObject({ code: 'unauthorized' });
});

it('resumes an older unfiltered checkpoint when the poller starts forwarding a singleton event', async () => {
  const input = { baselineAt: '2026-09-19T00:00:00Z', now: '2026-09-19T03:00:00Z', limit: 25, signal: new AbortController().signal };
  const source = createJiraEventSource(association, async () => ({ isLast: true, issues: [] }));
  const old = await source.poll(input);
  const resumed = await source.poll({ ...input, event: 'issue.opened', checkpoint: old.checkpoint });
  expect(resumed.complete).toBe(true);
  expect(resumed.candidates).toEqual([]);
  await expect(source.poll({ ...input, event: 'issue.status_changed', checkpoint: resumed.checkpoint })).rejects.toMatchObject({ code: 'invalid_cursor' });
});


afterEach(() => vi.useRealTimers());

it('checkpoints slow successful history pages before the default deadline and drains pending events once', async () => {
  vi.useFakeTimers();
  const input = { baselineAt: '2026-09-19T00:00:00Z', now: '2026-09-19T03:00:00Z', event: 'issue.status_changed' as const, limit: 1 };
  const source = createJiraEventSource(association, async (path, _init, signal) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 1750);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
    if (path.includes('/search/')) return { isLast: true, issues: [issue] };
    const start = Number(new URL(path, 'https://example.test').searchParams.get('startAt'));
    return { isLast: start === 6, startAt: start, maxResults: 1, values: [{ id: `h${start}`, created: start === 6 ? '2026-09-19T01:00:00Z' : '2020-01-01T00:00:00Z', items: start === 6 ? [{ fieldId: 'status', from: 'done', to: 'todo' }, { fieldId: 'status', from: 'todo', to: 'progress' }] : [] }] };
  });
  const poll = async (checkpoint?: string) => {
    const result = runOperation(signal => source.poll({ ...input, checkpoint, signal }));
    const assertion = expect(result).resolves.toHaveProperty('checkpoint');
    await Promise.all([assertion, vi.advanceTimersByTimeAsync(10_000)]);
    return result;
  };
  const first = await poll();
  expect(first.complete).toBe(false);
  expect(first.candidates).toEqual([]);
  expect(JSON.parse(first.checkpoint)).toMatchObject({ watermark: input.baselineAt, until: input.now, historyCursor: '3' });
  const second = await poll(first.checkpoint);
  expect(second.candidates.map(e => e.change.toId)).toEqual(['todo']);
  expect(JSON.parse(second.checkpoint).pending).toHaveLength(1);
  const third = await poll(second.checkpoint);
  expect(third.candidates.map(e => e.change.toId)).toEqual(['progress']);
  expect(third.complete).toBe(true);
  expect(new Set([...second.candidates, ...third.candidates].map(e => e.eventId)).size).toBe(2);
});

it('allows a first successful page near the hard deadline to make progress', async () => {
  vi.useFakeTimers();
  const source = createJiraEventSource(association, async () => {
    await new Promise(resolve => setTimeout(resolve, 9000));
    return { isLast: true, issues: [issue] };
  });
  const result = runOperation(signal => source.poll({ baselineAt: '2026-09-19T00:00:00Z', now: '2026-09-19T03:00:00Z', event: 'issue.status_changed', limit: 25, signal }));
  const assertion = expect(result).resolves.toMatchObject({ complete: false });
  await Promise.all([assertion, vi.advanceTimersByTimeAsync(10_000)]);
  expect(JSON.parse((await result).checkpoint).issues).toHaveLength(1);
});

it.each(['unauthorized', 'source_changed'] as const)('does not checkpoint completed pages over a %s failure', async code => {
  vi.useFakeTimers();
  const source = createJiraEventSource(association, async path => {
    await new Promise(resolve => setTimeout(resolve, 1750));
    if (path.includes('/search/')) return { isLast: true, issues: [issue] };
    throw new TrackerRequestError(code, 'Denied');
  });
  const result = runOperation(signal => source.poll({ baselineAt: '2026-09-19T00:00:00Z', event: 'issue.status_changed', limit: 25, signal }));
  await Promise.all([expect(result).rejects.toMatchObject({ code }), vi.advanceTimersByTimeAsync(10_000)]);
  expect(vi.getTimerCount()).toBe(0);
});

it('rejects explicit cancellation after completed pages even when the request ignores its signal', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const source = createJiraEventSource(association, async path => {
    if (path.includes('/search/')) return { isLast: true, issues: [issue] };
    return new Promise(() => {});
  });
  const result = runOperation(signal => source.poll({ baselineAt: '2026-09-19T00:00:00Z', event: 'issue.status_changed', limit: 25, signal: AbortSignal.any([signal, controller.signal]) }));
  const cancelled = new Error('Caller cancelled');
  setTimeout(() => controller.abort(cancelled), 1000);
  await Promise.all([expect(result).rejects.toBe(cancelled), vi.advanceTimersByTimeAsync(10_000)]);
  expect(vi.getTimerCount()).toBe(0);
});

it('retains the hard deadline when no page makes progress', async () => {
  vi.useFakeTimers();
  const source = createJiraEventSource(association, async () => new Promise(() => {}));
  const result = runOperation(signal => source.poll({ baselineAt: '2026-09-19T00:00:00Z', limit: 25, signal }));
  await Promise.all([expect(result).rejects.toMatchObject({ code: 'unavailable', reason: expect.stringContaining('timed out') }), vi.advanceTimersByTimeAsync(10_000)]);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  ['America/Los_Angeles', '2026/09/25 05:00'],
  ['Asia/Kolkata', '2026/09/25 17:30'],
])('uses account timezone %s for the discovery lower bound', async (timeZone, expected) => {
  let jql = '';
  const source = realJiraEventSource(association, async (path, init) => {
    if (path === '/rest/api/3/myself') return { timeZone };
    jql = JSON.parse(init.body as string).jql;
    return { isLast: true, issues: [] };
  });
  await source.poll({ baselineAt: '2026-09-25T12:00:30Z', now: '2026-09-25T12:30:00Z', event: 'issue.opened', limit: 25, signal: new AbortController().signal });
  expect(jql).toContain(`updated >= "${expected}"`);
});
it('does not complete a scan when the account timezone is unavailable', async () => {
  const request = vi.fn(async (path: string) => path === '/rest/api/3/myself' ? {} : { isLast: true, issues: [] });
  await expect(realJiraEventSource(association, request).poll({ baselineAt: '2026-09-25T12:00:00Z', now: '2026-09-25T12:30:00Z', event: 'issue.opened', limit: 25, signal: new AbortController().signal })).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(1);
});

it('widens discovery across the repeated hour at a DST transition', async () => {
  let jql = '';
  await realJiraEventSource(association, async (path, init) => {
    if (path === '/rest/api/3/myself') return { timeZone: 'America/Los_Angeles' };
    jql = JSON.parse(init.body as string).jql;
    return { isLast: true, issues: [] };
  }).poll({ baselineAt: '2026-11-01T08:30:00Z', now: '2026-11-01T10:00:00Z', event: 'issue.opened', limit: 25, signal: new AbortController().signal });
  expect(jql).toContain('updated >= "2026/10/31 01:30"');
});
it('loads the timezone once and respects the HTTP budget across discovery pages', async () => {
  const paths: string[] = [];
  const source = realJiraEventSource(association, async path => {
    paths.push(path);
    if (path === '/rest/api/3/myself') return { timeZone: 'UTC' };
    return { isLast: false, nextPageToken: String(paths.length), issues: [] };
  });
  const page = await source.poll({ baselineAt: '2026-09-25T12:00:00Z', now: '2026-09-25T12:30:00Z', event: 'issue.opened', limit: 25, signal: new AbortController().signal });
  expect(page.complete).toBe(false);
  expect(paths.filter(path => path === '/rest/api/3/myself')).toHaveLength(1);
  expect(paths).toHaveLength(8); // Seven pages + profile, leaving two source-discovery requests.
});
