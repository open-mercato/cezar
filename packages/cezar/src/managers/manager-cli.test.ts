import { describe, expect, it, vi } from 'vitest';
import { runManagerCommand, type ManagerCliIo } from './manager-cli.ts';

const snapshot = {
  generatedAt: '',
  attention: [{ key: 'k', kind: 'pr-ready', projectId: 'alpha', title: 'Ship it', number: 4 }],
  projects: [{ projectId: 'alpha', name: 'alpha', available: true, tasks: [{ runId: 'r1', title: 't', status: 'running', workflow: 'w', childCount: 2 }], prs: [{ number: 4, title: 'Ship it', status: 'ready' }] }],
};

function harness(env: Record<string, string> = {}, manager: Record<string, unknown> = {}) {
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
      if (String(url).endsWith('/actions')) return Response.json({ actionId: 'a1', status: 'pending' }, { status: 201 });
      if (String(url).endsWith('/tasks')) return Response.json({ projectId: 'alpha', runId: 'new' }, { status: 201 });
      if (/\/automations\/[^/]+$/.test(String(url))) return Response.json({ automation: { id: 'a1', name: 'n', revision: 1, enabled: true } });
      return Response.json({ automations: [], ok: true });
    }) as typeof fetch,
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

  it('prints attention and tasks', async () => {
    const { run, logs } = harness();
    expect(await run('status')).toBe(0);
    expect(logs.join('\n')).toContain('pr-ready');
    expect(logs.join('\n')).toContain('(2 dispatched)');
  });

  it('merge only ever proposes', async () => {
    const { run, calls, logs } = harness();
    expect(await run('merge', '--project', 'alpha', '4', '--reason', 'green')).toBe(0);
    expect(calls.at(-1)).toMatchObject({ method: 'POST', body: { action: { type: 'merge-pr', projectId: 'alpha', number: 4 }, reason: 'green' } });
    expect(calls.at(-1)?.url).toMatch(/\/workspace\/managers\/m1\/actions$/);
    expect(logs.join()).toContain('approval');
  });

  describe('automations', () => {
    const json = '{"name":"n","enabled":true,"enable":true}';

    it('never creates one enabled, however the definition spells it', async () => {
      const { run, calls } = harness();
      await run('automation', '--project', 'alpha', 'create', '--json', json);
      const post = calls.find((call) => call.method === 'POST');
      expect(post?.url).toMatch(/\/automations$/);
      expect(post?.body).not.toHaveProperty('enable');
      expect(post?.body).not.toHaveProperty('enabled');
    });

    it('an edit pauses, even one that asks for enabled', async () => {
      const { run, calls } = harness();
      await run('automation', '--project', 'alpha', 'update', 'a1', '--json', json);
      const put = calls.find((call) => call.method === 'PUT');
      expect(put?.body).toMatchObject({ enabled: false });
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

  it('renames, but not from a watch check', async () => {
    const { run, calls } = harness();
    expect(await run('rename', 'Mobile', 'Manager')).toBe(0);
    expect(calls.at(-1)).toMatchObject({ method: 'PATCH', body: { name: 'Mobile Manager' } });
    const watching = harness({ CEZ_MANAGER_TURN: 'watch' });
    expect(await watching.run('rename', 'Pwned')).toBe(1);
    expect(watching.calls).toEqual([]);
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
});
