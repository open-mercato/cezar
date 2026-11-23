import { describe, expect, it, vi } from 'vitest';
import { automationWritesVia, capped, runManagerCommand, SANDBOX_BLOCKED_HINT, sinceOf, taskModelLabel, type ManagerCliIo } from './manager-cli.ts';
import { recentTasks } from './snapshot.ts';

const snapshot = {
  generatedAt: '',
  attention: [{ key: 'k', kind: 'pr-ready', projectId: 'alpha', title: 'Ship it', number: 4 }, { key: 'q', kind: 'task-needs-you', projectId: 'alpha', title: 'Gate', runId: 'r2', detail: 'Ship it?' }],
  projects: [{ projectId: 'alpha', name: 'alpha', available: true, tasks: [{ runId: 'r1', title: 't', status: 'running', workflow: 'w', childCount: 2 }], prs: [{ number: 4, title: 'Ship it', status: 'ready' }] }],
};

let workflows: unknown = { workflows: [] };

function harness(env: Record<string, string> = {}, manager: Record<string, unknown> = {}, pending: Array<{ id: string; at: string }> = [], extra: Partial<ManagerCliIo> = {}) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const io: ManagerCliIo = {
    log: (line) => logs.push(line),
    error: (line) => errors.push(line),
    fetch: vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), method: init?.method ?? 'GET', ...(body !== undefined ? { body } : {}) });
      if (String(url).endsWith('/snapshot')) return Response.json(snapshot);
      if (String(url).endsWith('/managers/m1')) return Response.json({ id: 'm1', ...manager });
      if (String(url).includes('/messages?pending=1')) return Response.json({ messages: pending, hasMore: false });
      if (String(url).endsWith('/actions')) return Response.json({ actionId: 'a1', status: 'pending' }, { status: 201 });
      if (String(url).endsWith('/tasks')) return Response.json({ projectId: 'alpha', runId: 'new', ...(body?.fromMessage ? { forwarded: { messageId: 'u1', chars: 20_000, attachments: 1, skipped: ['huge.mov'] } } : {}), ...(body?.dispatch ? { notice: 'dispatch ignored: alpha runs tasks in place' } : {}) }, { status: 201 });
      if (String(url).endsWith('/task-message')) return Response.json({ ok: true, ...(body?.fromMessage ? { forwarded: { messageId: 'u1', chars: 20_000, attachments: 0 } } : {}) });
      if (String(url).endsWith('/task-cancel')) return Response.json({ runId: body?.runId, cancelled: true, status: 'cancelled', children: ['c1', 'c2'] });
      if (String(url).endsWith('/task-retry')) return Response.json({ projectId: 'alpha', runId: 'retried' }, { status: 201 });
      if (String(url).endsWith('/workflows')) return Response.json(workflows);
      if (String(url).endsWith('/action-ops')) return Response.json({ ops: [
        { type: 'merge-pr', category: 'pull-requests', risk: 'high', pinnedAsk: true, scope: 'project', summary: 'Merge a pull request', usage: 'cez manager merge --project <id> <number>', available: true },
        { type: 'connector-call', category: 'connectors', risk: 'high', pinnedAsk: true, scope: 'manager', summary: 'Make one connector call', usage: 'cez manager propose-action …', available: false, reason: 'no connector grants write calls' },
      ] });
      if (/\/automations\/[^/]+(\/report)?$/.test(String(url))) return Response.json({ automation: { id: 'a1', name: 'n', revision: 1, enabled: true } });
      return Response.json({ automations: [], ok: true });
    }) as typeof fetch,
    ...extra,
  };
  const run = (...args: string[]) => runManagerCommand(args, { CEZ_API_URL: 'http://x', CEZ_MANAGER_ID: 'm1', ...env }, io);
  return { run, calls, logs, errors };
}

describe('cez manager', () => {
  it('refuses without a cockpit or a manager id', async () => {
    const error = vi.fn();
    const io = { fetch, log: vi.fn(), error };
    expect(await runManagerCommand(['status'], {}, io)).toBe(2);
    expect(await runManagerCommand(['status'], { CEZ_API_URL: 'http://x' }, io)).toBe(2);
    expect(error.mock.calls[1]?.[0]).toContain('CEZ_MANAGER_ID');
  });

  it('passes the selected task runner and account together', async () => {
    const { run, calls } = harness();
    expect(await run('task', 'create', '--project', 'alpha', '--runner', 'claude', '--account', 'claude-second', 'Review it')).toBe(0);
    expect(calls.at(-1)?.body).toMatchObject({ runner: 'claude', agentProfile: 'claude-second', task: 'Review it' });
  });

  it('prints attention and tasks', async () => {
    const { run, logs } = harness();
    expect(await run('status')).toBe(0);
    expect(logs.join('\n')).toContain('pr-ready');
    expect(logs.join('\n')).toContain('2 dispatched)');
  });

  it('names the model a task asked for and the one it ran, arrow only when they differ', () => {
    expect(taskModelLabel(undefined, 'claude-opus-5-5')).toBe('auto → claude-opus-5-5');
    expect(taskModelLabel('anthropic/opus', 'claude-opus-5-5[1m]')).toBe('anthropic/opus → claude-opus-5-5[1m]');
    expect(taskModelLabel('anthropic/claude-opus-5-5', 'claude-opus-5-5[1m]')).toBe('anthropic/claude-opus-5-5');
    expect(taskModelLabel('anthropic/claude-opus-5-5', undefined)).toBe('anthropic/claude-opus-5-5');
  });

  it('follows and unfollows a task, finding its project from the snapshot', async () => {
    const { run, calls, logs, errors } = harness();
    expect(await run('task', 'follow', 'r1')).toBe(0);
    expect(calls.at(-1)).toEqual({ url: 'http://x/api/v1/workspace/managers/m1/follows', method: 'POST', body: { projectId: 'alpha', runId: 'r1', follow: true } });
    expect(logs.at(-1)).toContain('following r1');
    expect(await run('task', 'unfollow', '--project', 'alpha', 'r1')).toBe(0);
    expect(calls.at(-1)?.body).toEqual({ projectId: 'alpha', runId: 'r1', follow: false });
    expect(await run('task', 'follow')).toBe(1);
    expect(errors.at(-1)).toContain('usage: cez manager task follow');
  });

  it('says what a waiting task is asking', async () => {
    const { run, logs } = harness();
    expect(await run('attention')).toBe(0);
    expect(logs.join('\n')).toContain('Gate — Ship it?');
  });

  it('propose-action posts one connector-call, by key and tool or by the full tool name', async () => {
    const { run, calls, logs } = harness();
    const args = '{"summary":"Kick-Off","start":"2027-01-21"}';
    expect(await run('propose-action', '--connector', 'claude_ai_Google_Calendar', '--tool', 'create_event', '--args', args, '--reason', 'asked')).toBe(0);
    const action = { type: 'connector-call', connector: 'claude_ai_Google_Calendar', tool: 'create_event', args: { summary: 'Kick-Off', start: '2027-01-21' } };
    expect(calls.at(-1)).toMatchObject({ method: 'POST', body: { action, reason: 'asked' } });
    expect(logs.at(-1)).toContain('proposed a1');
    expect(await run('propose-action', '--tool', 'mcp__claude_ai_Google_Calendar__create_event', '--args', args)).toBe(0);
    expect(calls.at(-1)?.body).toEqual({ action });
  });

  it('propose-action refuses a bad tool, a mismatched connector and args that are not a JSON object', async () => {
    const { run, calls, errors } = harness();
    expect(await run('propose-action', '--tool', 'create_event')).toBe(1);
    expect(await run('propose-action', '--connector', 'x', '--tool', 'mcp__claude_ai_Gmail__send_message')).toBe(1);
    expect(await run('propose-action', '--tool', 'mcp__nope')).toBe(1);
    expect(await run('propose-action', '--connector', 'c', '--tool', 't', '--args', '[1]')).toBe(1);
    expect(await run('propose-action', '--connector', 'c', '--tool', 't', '--args', '{oops')).toBe(1);
    expect(errors.join('\n')).toContain('does not match');
    expect(errors.join('\n')).toContain('not valid JSON');
    expect(calls).toEqual([]);
  });

  it('merge only ever proposes', async () => {
    const { run, calls, logs } = harness();
    expect(await run('merge', '--project', 'alpha', '4', '--reason', 'green')).toBe(0);
    expect(calls.at(-1)).toMatchObject({ method: 'POST', body: { action: { type: 'merge-pr', projectId: 'alpha', number: 4 }, reason: 'green' } });
    expect(calls.at(-1)?.url).toMatch(/\/workspace\/managers\/m1\/actions$/);
    expect(logs.join()).toContain('approval');
  });

  it('says so when the proposal is already waiting, instead of claiming a new card', async () => {
    const { run, logs } = harness({}, {}, [{ id: 'a1', at: '2026-11-10T02:00:00.000Z' }]);
    expect(await run('merge', '--project', 'alpha', '4')).toBe(0);
    expect(logs.at(-1)).toMatch(/^already pending a1 \(proposed 2026-11-10T02:00:00.000Z\): merging #4 still waits/);
    expect(logs.at(-1)).toContain('No new card');
    const fresh = harness({}, {}, [{ id: 'other', at: '2026-11-10T02:00:00.000Z' }]);
    expect(await fresh.run('merge', '--project', 'alpha', '4')).toBe(0);
    expect(fresh.logs.at(-1)).toMatch(/^proposed a1: merging #4 waits/);
  });

  describe('automations', () => {
    const json = '{"name":"n","enabled":true,"enable":true}';

    it('never creates one enabled, however the definition spells it', async () => {
      const { run, calls } = harness();
      await run('automation', '--project', 'alpha', 'create', '--json', json);
      const post = calls.find((call) => call.method === 'POST');
      // Through the manager's own route, which checks it on the server (spec 2026-11-20 § 3.6).
      expect(post?.url).toMatch(/\/workspace\/managers\/m1\/automations$/);
      expect(post?.body).toMatchObject({ projectId: 'alpha' });
      expect((post?.body as { definition: object }).definition).not.toHaveProperty('enable');
      expect((post?.body as { definition: object }).definition).not.toHaveProperty('enabled');
    });

    it('links what it creates to the calling manager, unless told otherwise', async () => {
      const { run, calls } = harness();
      await run('automation', '--project', 'alpha', 'create', '--json', '{"name":"n","report":{"managerId":"someone-else","mode":"none"}}');
      await run('automation', '--project', 'alpha', 'add', '--name', 'Brief', '--cron', '45 7 * * *', '--prompt', 'brief', '--report-mode', 'failure-only');
      await run('automation', '--project', 'alpha', 'add', '--name', 'Quiet', '--cron', '45 7 * * *', '--prompt', 'brief', '--no-report');
      const posts = calls.filter((call) => call.method === 'POST' && /\/automations$/.test(call.url)).map((call) => (call.body as { definition: { report?: unknown } }).definition.report);
      expect(posts).toEqual([{ managerId: 'm1', mode: 'none' }, { managerId: 'm1', mode: 'notify-on-failure' }, undefined]);
      expect(calls.every((call) => !(call.body as { definition?: { enable?: unknown } } | undefined)?.definition?.enable)).toBe(true);
    });

    it('changes the link of an existing automation, to itself only', async () => {
      const { run, calls, errors } = harness();
      expect(await run('automation', '--project', 'alpha', 'report', 'a1', '--mode', 'failure-only')).toBe(0);
      expect(calls.at(-1)).toMatchObject({ method: 'PUT', body: { projectId: 'alpha', report: { managerId: 'm1', mode: 'notify-on-failure' } } });
      expect(calls.at(-1)?.url).toMatch(/\/workspace\/managers\/m1\/automations\/a1\/report$/);
      expect(await run('automation', '--project', 'alpha', 'report', 'a1', '--unlink')).toBe(0);
      expect(calls.at(-1)).toMatchObject({ method: 'PUT', body: { projectId: 'alpha', report: null } });
      expect(await run('automation', '--project', 'alpha', 'report', 'a1', '--manager', 'other')).toBe(1);
      expect(errors.at(-1)).toContain('itself only');
    });

    it('an edit pauses, even one that asks for enabled', async () => {
      const { run, calls } = harness();
      await run('automation', '--project', 'alpha', 'update', 'a1', '--json', json);
      const put = calls.find((call) => call.method === 'PUT');
      expect(put?.url).toMatch(/\/workspace\/managers\/m1\/automations\/a1$/);
      expect(put?.body).toMatchObject({ projectId: 'alpha', definition: { enabled: false } });
    });

    it.each([[['check', 'a1', '--execute']], [['run', 'a1']], [['delete', 'a1']], [['create', '--enable', '--json', '{}']]])('refuses %j in any turn', async (sub) => {
      const { run, calls } = harness();
      expect(await run('automation', '--project', 'alpha', ...sub)).toBe(1);
      expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
    });

    it.each(['create', 'add', 'update', 'pause', 'mystery'])('a watch check refuses %s', async (sub) => {
      const { run, calls } = harness({ CEZ_MANAGER_TURN: 'watch' });
      expect(await run('automation', '--project', 'alpha', sub, 'a1')).toBe(1);
      expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
    });

    it('a watch check may still read', async () => {
      const { run } = harness({ CEZ_MANAGER_TURN: 'watch' });
      expect(await run('automation', '--project', 'alpha', 'list')).toBe(0);
    });
  });

  it('sends its turn token on every manager route it calls (spec 2026-11-20 § 3.1)', async () => {
    const seen: Array<{ url: string; token: string | null }> = [];
    const { run } = harness({ CEZ_MANAGER_TURN_TOKEN: 't-1' }, {}, [], {
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        seen.push({ url: String(url), token: new Headers(init?.headers).get('x-cez-manager-turn') });
        if (String(url).endsWith('/snapshot')) return Response.json({ projects: [{ projectId: 'alpha', name: 'alpha', available: true, attention: [], tasks: [], prs: [] }] });
        if (String(url).includes('/messages?pending=1')) return Response.json({ messages: [], hasMore: false });
        return Response.json({ actionId: 'a1', status: 'pending', automation: { id: 'a1', name: 'n', revision: 1, enabled: false } }, { status: 201 });
      }) as typeof fetch,
    });
    await run('merge', '--project', 'alpha', '12');
    await run('rename', 'Scout');
    await run('automation', '--project', 'alpha', 'create', '--json', '{"name":"n"}');
    const managerCalls = seen.filter((call) => call.url.includes('/workspace/managers/'));
    expect(managerCalls.length).toBeGreaterThan(4);
    expect(managerCalls.every((call) => call.token === 't-1')).toBe(true);
  });

  describe('propose (spec 2026-11-20-manager-admin-actions)', () => {
    it('proposes any kind through the one route, with the project pinned from the snapshot', async () => {
      const { run, calls, logs } = harness();
      expect(await run('propose', 'merge-pr', '--project', 'alpha', '--json', '{"number":12,"method":"squash"}', '--reason', 'green')).toBe(0);
      expect(calls.at(-1)).toMatchObject({ method: 'POST', url: 'http://x/api/v1/workspace/managers/m1/actions', body: { action: { type: 'merge-pr', projectId: 'alpha', number: 12, method: 'squash' }, reason: 'green' } });
      expect(logs.at(-1)).toContain('proposed a1');
    });

    it('the type comes from the argument, never from --json', async () => {
      const { run, calls } = harness();
      expect(await run('propose', 'add-job', '--json', '{"type":"merge-pr","name":"n","prompt":"p","everyMinutes":60}')).toBe(0);
      expect(calls.at(-1)?.body).toMatchObject({ action: { type: 'add-job' } });
    });

    it('refuses a missing type, extra words and non-object JSON', async () => {
      const { run, calls, errors } = harness();
      expect(await run('propose')).toBe(1);
      expect(await run('propose', 'merge-pr', 'extra')).toBe(1);
      expect(await run('propose', 'merge-pr', '--json', '[1]')).toBe(1);
      expect(await run('propose', 'merge-pr', '--json', '{nope')).toBe(1);
      expect(errors.at(-1)).toContain('JSON object');
      expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
    });

    it('--help lists what this manager may propose, from the server', async () => {
      const { run, logs } = harness();
      expect(await run('propose', '--help')).toBe(0);
      const text = logs.join('\n');
      expect(text).toContain('merge-pr');
      expect(text).toContain('always asks');
      expect(text).toContain('unavailable: no connector grants write calls');
    });
  });

  describe('automationWritesVia', () => {
    const recorded: Array<{ url: string; method: string; body?: unknown }> = [];
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      recorded.push({ url: String(url), method: init?.method ?? 'GET', ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}) });
      return Response.json({ ok: true });
    }) as typeof fetch;
    const via = automationWritesVia(fake, 'http://x', 'http://x/api/v1/workspace/managers/m1', 'alpha');
    const scope = 'http://x/api/v1/p/alpha/automations';

    it('passes reads through untouched', async () => {
      recorded.length = 0;
      await via(`${scope}/a1`);
      expect(recorded).toEqual([{ url: `${scope}/a1`, method: 'GET' }]);
    });

    it('refuses every write the manager routes do not offer, without sending it', async () => {
      recorded.length = 0;
      for (const [path, method, body] of [['/a1', 'DELETE', undefined], ['/a1/run', 'POST', undefined], ['/a1/enable', 'POST', undefined], ['/a1/check', 'POST', { mode: 'execute' }], ['/import', 'POST', {}]] as const) {
        const response = await via(`${scope}${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
        expect(response.status).toBe(403);
      }
      const other = await via('http://x/api/v1/p/beta/automations', { method: 'POST', body: '{}' });
      expect(other.status).toBe(403);
      expect(recorded).toEqual([]);
    });

    it('sends a preview check to the manager route', async () => {
      recorded.length = 0;
      await via(`${scope}/a1/check`, { method: 'POST', body: JSON.stringify({ mode: 'preview' }) });
      expect(recorded).toEqual([{ url: 'http://x/api/v1/workspace/managers/m1/automations/a1/check', method: 'POST', body: { projectId: 'alpha' } }]);
    });

    it('sends a pause to the manager route, as `cez manager automation pause` worked before the routes', async () => {
      recorded.length = 0;
      const response = await via(`${scope}/a1/pause`, { method: 'POST' });
      expect(response.status).toBe(200);
      expect(recorded).toEqual([{ url: 'http://x/api/v1/workspace/managers/m1/automations/a1/pause', method: 'POST', body: { projectId: 'alpha' } }]);
    });
  });

  it('renames, but not from a watch check', async () => {
    const { run, calls } = harness();
    expect(await run('rename', 'Mobile', 'Manager')).toBe(0);
    // Its own route, never the general PATCH that also changes access (spec 2026-11-20 § 3.1).
    expect(calls.at(-1)).toMatchObject({ method: 'POST', url: 'http://x/api/v1/workspace/managers/m1/rename', body: { name: 'Mobile Manager' } });
    expect(calls.some((call) => call.method === 'PATCH')).toBe(false);
    const watching = harness({ CEZ_MANAGER_TURN: 'watch' });
    expect(await watching.run('rename', 'Pwned')).toBe(1);
    expect(watching.calls).toEqual([]);
  });

  it('cannot switch a manager off or on: rename sends the name alone, and nothing reaches the activity route', async () => {
    const { run, calls } = harness();
    expect(await run('rename', '{"active":false}')).toBe(0);
    expect(calls.at(-1)).toEqual(expect.objectContaining({ method: 'POST', body: { name: '{"active":false}' } }));
    expect(calls.at(-1)?.url).toMatch(/\/rename$/);
    expect(calls.some((call) => call.url.includes('/activity'))).toBe(false);
  });

  it('refuses to set up automations on a read-only project, and still reads them', async () => {
    const { run, calls } = harness({}, { access: 'read' });
    expect(await run('automation', '--project', 'alpha', 'create', '--json', '{"name":"n"}')).toBe(1);
    expect(calls.filter((call) => call.method === 'POST')).toEqual([]);
    expect(await run('automation', '--project', 'alpha', 'list')).toBe(0);
  });

  it('job add only proposes', async () => {
    const { run, calls, logs } = harness();
    expect(await run('job', 'add', '--name', 'Digest', '--every', '60', 'Summarize')).toBe(0);
    expect(calls.at(-1)).toMatchObject({ method: 'POST', body: { action: { type: 'add-job', name: 'Digest', everyMinutes: 60, prompt: 'Summarize' } } });
    expect(logs.join()).toContain('approval');
  });

  it('task create prints the card', async () => {
    const { run, logs, calls } = harness();
    expect(await run('task', 'create', '--title', 'T', 'Do', 'it')).toBe(0);
    expect(calls.at(-1)?.body).toMatchObject({ projectId: 'alpha', task: 'Do it', title: 'T' });
    expect(logs).toContain('[[task:alpha/new]]');
  });

  it('task create says when the project ignored --dispatch', async () => {
    const { run, logs } = harness();
    expect(await run('task', 'create', '--dispatch', 'Do', 'it')).toBe(0);
    expect(logs).toEqual(['[[task:alpha/new]]', 'dispatch ignored: alpha runs tasks in place']);
  });

  describe('content that does not fit a command', () => {
    it('forwards the newest user message server-side: nothing but the flag crosses the shell', async () => {
      const { run, calls, logs } = harness();
      expect(await run('task', 'create', '--title', 'Notes', '--attach-last-user-message', 'File', 'this')).toBe(0);
      expect(calls.at(-1)?.body).toEqual({ projectId: 'alpha', task: 'File this', title: 'Notes', fromMessage: 'last' });
      expect(logs.join('\n')).toContain('forwarded the user\'s message u1 verbatim: 20000 characters, 1 attachment');
      expect(logs.join('\n')).toContain('huge.mov');
    });

    it('needs no objective of its own when it forwards', async () => {
      const { run, calls } = harness();
      expect(await run('task', 'create', '--from-message', 'm-42')).toBe(0);
      expect(calls.at(-1)?.body).toEqual({ projectId: 'alpha', fromMessage: 'm-42' });
    });

    it('task say forwards too', async () => {
      const { run, calls, logs } = harness();
      expect(await run('task', 'say', 'r1', '--attach-last-user-message')).toBe(0);
      expect(calls.at(-1)?.body).toEqual({ projectId: 'alpha', runId: 'r1', fromMessage: 'last' });
      expect(logs.join('\n')).toContain('forwarded');
    });

    it('reads --file and --stdin verbatim, after the typed words', async () => {
      const text = 'Zażółć "gęślą" — it\'s $HOME `id`\nline 2';
      const readFile = vi.fn(async () => text);
      const { run, calls } = harness({}, {}, [], { readFile, readStdin: async () => text });
      expect(await run('task', 'create', '--file', 'files/t.txt', 'Summarize')).toBe(0);
      expect(readFile).toHaveBeenCalledWith('files/t.txt');
      expect(calls.at(-1)?.body).toMatchObject({ task: `Summarize\n\n${text}` });
      expect(await run('task', 'say', 'r1', '--stdin')).toBe(0);
      expect(calls.at(-1)?.body).toMatchObject({ runId: 'r1', text });
    });

    it('passes --allow-placeholder through, and refuses contradictory flags before any call', async () => {
      const { run, calls, errors } = harness();
      expect(await run('task', 'create', '--allow-placeholder', 'Fix the PASTE button')).toBe(0);
      expect(calls.at(-1)?.body).toMatchObject({ allowPlaceholder: true });
      const before = calls.length;
      expect(await run('task', 'create', '--attach-last-user-message', '--from-message', 'x')).toBe(1);
      expect(await run('task', 'create', '--file', 'a', '--stdin')).toBe(1);
      expect(await run('task', 'say', 'r1')).toBe(1);
      expect(calls.length).toBe(before);
      expect(errors.join()).toContain('not both');
    });

    it('says what it could not read', async () => {
      const { run, errors } = harness({}, {}, [], { readFile: async () => { throw new Error('ENOENT'); } });
      expect(await run('task', 'create', '--file', 'nope.txt')).toBe(1);
      expect(errors.join()).toContain('cannot read nope.txt');
    });
  });

  it('refuses a project it is not connected to before any tool call', async () => {
    const { run, errors, calls } = harness();
    expect(await run('merge', '--project', 'other', '4')).toBe(1);
    expect(errors.join()).toContain('not connected');
    expect(calls.every((call) => call.url.endsWith('/snapshot'))).toBe(true);
  });

  it('automation pins the project, and enable proposes instead of enabling', async () => {
    const { run, calls } = harness();
    expect(await run('automation', '--project', 'alpha', 'list')).toBe(0);
    expect(calls.at(-1)?.url).toContain('/p/alpha/automations');
    expect(await run('automation', '--project', 'alpha', 'enable', 'auto1')).toBe(0);
    expect(calls.at(-1)).toMatchObject({ body: { action: { type: 'enable-automation', projectId: 'alpha', automationId: 'auto1' } } });
    expect(calls.some((call) => call.url.endsWith('/enable'))).toBe(false);
  });

  it('refuses to create an enabled automation', async () => {
    const { run, errors } = harness();
    expect(await run('automation', '--project', 'alpha', 'add', '--name', 'n', '--enable')).toBe(1);
    expect(errors.join()).toContain('paused');
  });

  it('a watch turn may read automations but not change them', async () => {
    const { run, errors } = harness({ CEZ_MANAGER_TURN: 'watch' });
    expect(await run('automation', '--project', 'alpha', 'list')).toBe(0);
    expect(await run('automation', '--project', 'alpha', 'pause', 'a')).toBe(1);
    expect(errors.join()).toContain('read-only');
  });

  describe('task lifecycle and strict parsing', () => {
    it('cancels a task with a reason and reports its dispatched children', async () => {
      const { run, calls, logs } = harness();
      expect(await run('task', 'cancel', '--project', 'alpha', 'r1', '--reason', 'review only')).toBe(0);
      expect(calls.at(-1)).toMatchObject({ url: 'http://x/api/v1/workspace/managers/m1/task-cancel', method: 'POST', body: { projectId: 'alpha', runId: 'r1', reason: 'review only' } });
      expect(logs.at(-1)).toBe('cancelled r1, and 2 dispatched tasks: c1, c2. Its worktree and branch are kept.');
    });

    it('a watch turn may not cancel', async () => {
      const { run, calls, errors } = harness({ CEZ_MANAGER_TURN: 'watch' });
      expect(await run('task', 'cancel', '--project', 'alpha', 'r1')).toBe(1);
      expect(errors.join('\n')).toContain('read-only');
      expect(calls.some((call) => call.url.endsWith('/task-cancel'))).toBe(false);
    });

    it('retries a task as a new one', async () => {
      const { run, calls, logs } = harness();
      expect(await run('task', 'retry', '--project', 'alpha', 'r1')).toBe(0);
      expect(calls.at(-1)).toMatchObject({ url: 'http://x/api/v1/workspace/managers/m1/task-retry', body: { projectId: 'alpha', runId: 'r1' } });
      expect(logs.at(-1)).toBe('[[task:alpha/retried]]');
    });

    it('sends --model and --effort, and refuses an effort it does not know', async () => {
      const { run, calls, errors } = harness();
      expect(await run('task', 'create', '--project', 'alpha', '--model', 'opus', '--effort', 'max', 'Review it')).toBe(0);
      expect(calls.at(-1)).toMatchObject({ url: 'http://x/api/v1/workspace/managers/m1/tasks', body: { model: 'opus', effort: 'max', task: 'Review it' } });
      expect(await run('task', 'say', '--project', 'alpha', 'r1', '--model', 'sonnet', '--effort', 'low', 'again')).toBe(0);
      expect(calls.at(-1)).toMatchObject({ url: 'http://x/api/v1/workspace/managers/m1/task-message', body: { runId: 'r1', text: 'again', model: 'sonnet', effort: 'low' } });
      const before = calls.length;
      expect(await run('task', 'create', '--project', 'alpha', '--effort', 'extreme', 'x')).toBe(1);
      expect(errors.at(-1)).toContain('--effort must be one of low, medium, high, max');
      expect(calls).toHaveLength(before);
    });

    it('an unknown subcommand fails instead of being read as a run id', async () => {
      const { run, calls, errors } = harness();
      expect(await run('task', 'foo')).toBe(1);
      expect(errors.at(-1)).toContain("unknown subcommand 'foo' for 'task'. Valid: create, say, cancel, retry, follow, unfollow, or a run id");
      expect(await run('job', 'frob')).toBe(1);
      expect(errors.at(-1)).toContain("unknown subcommand 'frob' for 'job'. Valid: add, list, remove");
      expect(calls).toEqual([]);
    });

    it('still reads a run id, or its eight-character prefix', async () => {
      const { run, calls } = harness();
      expect(await run('task', '0123abcd', '--project', 'alpha')).toBe(0);
      expect(calls.at(-1)?.url).toBe('http://x/api/v1/workspace/managers/m1/task?projectId=alpha&runId=0123abcd');
      expect(await run('task', '--project', 'alpha', '0123abcd-1111-2222-3333-444455556666')).toBe(0);
    });

    it('an unknown command or flag names what is valid', async () => {
      const { run, errors } = harness();
      expect(await run('frobnicate')).toBe(2);
      expect(errors.at(-1)).toContain("unknown command 'frobnicate'. Valid: status, attention, tasks");
      expect(await run('task', 'cancel', '--project', 'alpha', 'r1', '--force')).toBe(1);
      expect(errors.at(-1)).toContain("unknown flag '--force' for 'task cancel'. Flags: --project, --reason. See: cez manager task cancel --help");
    });

    it('--help works on every command and subcommand, without a cockpit', async () => {
      const io = { fetch: vi.fn() as unknown as typeof fetch, log: vi.fn(), error: vi.fn() };
      for (const args of [['status', '--help'], ['task', '--help'], ['task', 'cancel', '-h'], ['task', 'say', '--help'], ['task', 'retry', '--help'], ['workflows', '--help'], ['merge', '--help'], ['job', 'add', '--help'], ['rename', '--help'], ['automation', '--help'], ['help', 'task', 'cancel']]) {
        io.log.mockClear();
        expect(await runManagerCommand(args, {}, io)).toBe(0);
        expect(String(io.log.mock.calls[0]?.[0])).toContain(`cez manager ${args[0] === 'help' ? 'task cancel' : args[0]}`);
      }
      io.log.mockClear();
      await runManagerCommand(['task', 'cancel', '--help'], {}, io);
      expect(String(io.log.mock.calls[0]?.[0])).toContain('--reason');
    });

    // #2258: a sandboxed connect is EPERM, not ECONNREFUSED; the agent needs the way out.
    it('says a sandbox blocked the call, and only then', async () => {
      const failing = (code: string) => ({
        fetch: vi.fn(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code } }); }) as unknown as typeof fetch,
        log: vi.fn(),
        error: vi.fn(),
      });
      const env = { CEZ_API_URL: 'http://127.0.0.1:4321', CEZ_MANAGER_ID: 'm1' };
      const blocked = failing('EPERM');
      expect(await runManagerCommand(['status'], env, blocked)).toBe(1);
      expect(String(blocked.error.mock.calls[0]?.[0])).toBe(`cez manager: fetch failed\n${SANDBOX_BLOCKED_HINT}`);
      const down = failing('ECONNREFUSED');
      expect(await runManagerCommand(['status'], env, down)).toBe(1);
      expect(String(down.error.mock.calls[0]?.[0])).toBe('cez manager: fetch failed');
    });

    it('task create --help lists the workflows, and says so when it cannot', async () => {
      workflows = { workflows: [{ name: 'quick-task', description: 'One agent' }, { name: 'review-pr', description: 'Review a PR' }] };
      const { run, logs } = harness();
      expect(await run('task', 'create', '--help')).toBe(0);
      expect(logs.join('\n')).toContain('--effort');
      expect(logs.join('\n')).toContain('Workflows in alpha:');
      expect(logs.join('\n')).toContain('review-pr  Review a PR');
      const io = { fetch: vi.fn() as unknown as typeof fetch, log: vi.fn(), error: vi.fn() };
      expect(await runManagerCommand(['task', 'create', '--help'], {}, io)).toBe(0);
      expect(io.log.mock.calls.flat().join('\n')).toContain('Workflows: unavailable');
    });

    it('flags what each workflow can do, and keeps --json raw', async () => {
      workflows = { workflows: [
        { name: 'review-council', description: 'Council\nreview', capabilities: { push: true, openPr: true, postToGithub: false } },
        { name: 'review-pr', description: 'Review a PR', capabilities: { push: false, openPr: false, postToGithub: false } },
        { name: 'custom', description: '' },
      ] };
      const { run, logs } = harness();
      expect(await run('workflows', '--project', 'alpha')).toBe(0);
      expect(logs).toEqual([
        'review-council  Council review  [push, open-pr]',
        'review-pr  Review a PR  [read-only]',
        'custom  -  [capabilities unknown]',
      ]);
      logs.length = 0;
      expect(await run('workflows', '--project', 'alpha', '--json')).toBe(0);
      expect(JSON.parse(logs.join('\n'))).toEqual(workflows);
    });

    it('prints the raw list from a cockpit without capabilities', async () => {
      workflows = { workflows: [{ name: 'quick-task' }] };
      const { run, logs } = harness();
      expect(await run('workflows', '--project', 'alpha')).toBe(0);
      expect(JSON.parse(logs.join('\n'))).toEqual(workflows);
    });
  });
});

describe('memory and history (spec 2026-11-21-manager-short-sessions-and-memory)', () => {
  const memory = { entries: [{ key: 'full-prs', kind: 'feedback', text: 'Open full PRs', why: 'reviews start sooner', updatedAt: 't', source: 'user' }], limits: { entries: 40, bytes: 6144 }, usedBytes: 120 };
  const messages = Array.from({ length: 30 }, (_, i) => ({
    id: `m${i}`, seq: i, at: new Date(Date.parse('2026-11-21T00:00:00Z') + i * 3_600_000).toISOString(),
    ...(i % 2 === 0 ? { kind: 'user', text: `question ${i}` } : { kind: 'assistant', text: `answer ${i}`, turn: 'chat', streaming: false, commands: [] }),
  }));
  const fetchFor = (calls: Array<{ url: string; method: string; body?: unknown }>) => vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), method: init?.method ?? 'GET', ...(body !== undefined ? { body } : {}) });
    if (String(url).includes('/memory')) return Response.json(memory);
    const before = Number(new URL(String(url)).searchParams.get('before') ?? Infinity);
    return Response.json({ messages: messages.filter((message) => message.seq < before).slice(-200), hasMore: false });
  }) as typeof fetch;

  it('lists, sets and removes memory', async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const { run, logs } = harness({}, {}, [], { fetch: fetchFor(calls) });
    expect(await run('memory', 'list')).toBe(0);
    expect(logs.at(-1)).toBe('full-prs  [feedback]  Open full PRs  (why: reviews start sooner)');
    expect(await run('memory', 'set', 'full-prs', '--kind', 'feedback', '--why', 'reviews start sooner', 'Open', 'full', 'PRs')).toBe(0);
    expect(calls.at(-1)).toMatchObject({ method: 'PUT', url: 'http://x/api/v1/workspace/managers/m1/memory/full-prs', body: { kind: 'feedback', text: 'Open full PRs', why: 'reviews start sooner', source: 'manager' } });
    expect(await run('memory', 'remove', 'full-prs')).toBe(0);
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE' });
  });

  it('refuses a bad key or kind, and any write during a watch', async () => {
    const { run, errors } = harness({}, {}, [], { fetch: fetchFor([]) });
    expect(await run('memory', 'set', 'Bad Key', '--kind', 'feedback', 'x')).not.toBe(0);
    expect(await run('memory', 'set', 'ok', '--kind', 'whim', 'x')).not.toBe(0);
    const watch = harness({ CEZ_MANAGER_TURN: 'watch' }, {}, [], { fetch: fetchFor([]) });
    expect(await watch.run('memory', 'set', 'ok', '--kind', 'feedback', 'x')).not.toBe(0);
    expect(watch.errors.join('\n')).toContain('read-only');
    expect(errors.join('\n')).toContain('lowercase');
  });

  it('prints the newest matching messages oldest first, filtered by --since and --grep', async () => {
    const { run, logs } = harness({}, {}, [], { fetch: fetchFor([]) });
    expect(await run('history', '--limit', '3')).toBe(0);
    expect(logs.at(-1)).toMatch(/^[^\n]*answer 27[\s\S]*question 28[\s\S]*answer 29$/);
    expect(await run('history', '--grep', 'ANSWER 1', '--limit', '200')).toBe(0);
    expect(logs.at(-1)!.split('\n\n').map((line) => line.replace(/^.*?: /, ''))).toEqual(['answer 1', 'answer 11', 'answer 13', 'answer 15', 'answer 17', 'answer 19']);
    expect(await run('history', '--since', '2026-11-21T27:00Z')).not.toBe(0);
  });

  it('reads --since as a duration or an ISO time', () => {
    const now = Date.parse('2026-11-21T12:00:00Z');
    expect(sinceOf('2h', now)).toBe(now - 7_200_000);
    expect(sinceOf('1d', now)).toBe(now - 86_400_000);
    expect(sinceOf('2026-11-21T10:00:00Z', now)).toBe(Date.parse('2026-11-21T10:00:00Z'));
    expect(sinceOf('soon', now)).toBeUndefined();
  });
});

describe('compact listings (spec 2026-11-21-manager-short-sessions-and-memory § 2.4)', () => {
  const busy = {
    generatedAt: '',
    attention: [
      { key: 'w', kind: 'task-needs-you', projectId: 'alpha', title: 'Gate', runId: 'r0' },
      ...Array.from({ length: 3 }, (_, i) => ({ key: `f${i}`, kind: 'task-finished', projectId: 'alpha', title: `Done ${i}`, runId: `d${i}` })),
    ],
    projects: [{
      projectId: 'alpha', name: 'alpha', available: true, prs: [],
      tasks: [
        { runId: 'live', title: 'Live', status: 'running', workflow: 'w', childCount: 0, startedBy: 'user' },
        ...Array.from({ length: 25 }, (_, i) => ({ runId: `d${i}`, title: `Done ${i}`, status: 'done', workflow: 'w', childCount: 0, startedBy: 'user', lastActivityAt: `2026-11-${String(i + 1).padStart(2, '0')}T00:00:00Z` })),
      ],
    }],
  };
  const fetchBusy = vi.fn(async () => Response.json(busy)) as typeof fetch;

  it('hides finished tasks from attention unless --all', async () => {
    const { run, logs } = harness({}, {}, [], { fetch: fetchBusy });
    expect(await run('attention')).toBe(0);
    expect(logs).toEqual(['task-needs-you  alpha  r0  Gate', '(3 finished tasks the user has not opened yet: --all lists them)']);
    logs.length = 0;
    expect(await run('attention', '--all')).toBe(0);
    expect(logs).toHaveLength(4);
  });

  it('lists unfinished tasks and the 20 newest finished ones', async () => {
    const { run, logs } = harness({}, {}, [], { fetch: fetchBusy });
    expect(await run('tasks')).toBe(0);
    expect(logs).toHaveLength(22);
    expect(logs[0]).toContain('live  running');
    expect(logs.join('\n')).toContain('d24  done');
    expect(logs.join('\n')).not.toContain('d4  done');
    expect(logs.at(-1)).toBe('alpha: 5 older finished tasks not shown (--all lists them)');
  });

  it('caps a listing and counts what it cut', () => {
    expect(capped(['aaaa', 'bbbb', 'cccc'], 10)).toEqual(['aaaa', 'bbbb', '… 1 more line: narrow with --project, or use --all or --json']);
    expect(capped(['aaaa'], undefined)).toEqual(['aaaa']);
    expect(recentTasks([{ status: 'cancelled' }, { status: 'failed' }]).hidden).toBe(0);
  });
});
