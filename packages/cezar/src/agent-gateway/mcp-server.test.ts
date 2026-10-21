import { PassThrough } from 'node:stream';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { cockpitBase, handleMessage, serveMcp, TOOLS, type McpDeps } from './mcp-server.ts';
import { INTEGRATION_TARGETS, hermesSnippet, openclawSnippet, resolveMcpLaunch, runIntegrationsCommand, skillMarkdown } from './integrations.ts';

const run = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  title: `task ${id}`,
  workflow: 'quick-task',
  task: 'do it',
  status: 'running',
  createdAt: '2026-09-01T10:00:00.000Z',
  tokensUsed: 0,
  archived: false,
  steps: [],
  ...overrides,
});

const harness = (routes: Record<string, unknown>, env: McpDeps['env'] = {}) => {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const deps: McpDeps = {
    env,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ method: init?.method ?? 'GET', url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      const key = `${init?.method ?? 'GET'} ${url.replace('http://127.0.0.1:4321/api/v1', '')}`;
      if (!(key in routes)) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
      const reply = routes[key];
      return reply instanceof Response ? reply : new Response(JSON.stringify(reply), { status: 200 });
    }) as typeof fetch,
  };
  return { deps, calls };
};

const rpc = (deps: McpDeps, method: string, params?: Record<string, unknown>, id: number = 1) =>
  handleMessage({ jsonrpc: '2.0', id, method, params }, deps) as Promise<{ result?: any; error?: { code: number; message: string } }>;

const textOf = (reply: { result?: any }) => reply.result.content[0].text as string;

describe('cezar mcp protocol', () => {
  const { deps } = harness({});

  it('initialize echoes a supported protocol version and advertises tools', async () => {
    const reply = await rpc(deps, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    expect(reply.result).toMatchObject({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'cezar' } });
  });

  it('initialize falls back to the newest known version for an unknown one', async () => {
    const reply = await rpc(deps, 'initialize', { protocolVersion: '1999-01-01' });
    expect(reply.result.protocolVersion).toBe('2025-06-18');
  });

  it('answers ping and never answers notifications', async () => {
    expect((await rpc(deps, 'ping')).result).toEqual({});
    expect(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, deps)).toBeUndefined();
  });

  it('lists every tool with a JSON-schema input', async () => {
    const reply = await rpc(deps, 'tools/list');
    const names = reply.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual([
      'cezar_list_projects',
      'cezar_list_workflows',
      'cezar_list_tasks',
      'cezar_get_task',
      'cezar_create_task',
      'cezar_send_message',
      'cezar_cancel_task',
      'cezar_accept_review',
      'cezar_open_pr',
    ]);
    expect(names).toHaveLength(TOOLS.length);
    for (const tool of reply.result.tools) expect(tool.inputSchema.type).toBe('object');
    const create = reply.result.tools.find((t: { name: string }) => t.name === 'cezar_create_task');
    expect(create.inputSchema.required).toEqual(['task']);
  });

  it('answers a JSON-RPC batch with -32600 instead of dropping it', async () => {
    const reply = (await handleMessage([{ jsonrpc: '2.0', id: 1, method: 'ping' }], deps)) as { error: { code: number } };
    expect(reply.error.code).toBe(-32600);
  });

  it('rejects unknown methods and unknown tools', async () => {
    expect((await rpc(deps, 'resources/list')).error?.code).toBe(-32601);
    expect((await rpc(deps, 'tools/call', { name: 'nope' })).error?.code).toBe(-32602);
  });

  it('returns invalid arguments as a tool error the model can read', async () => {
    const reply = await rpc(deps, 'tools/call', { name: 'cezar_create_task', arguments: {} });
    expect(reply.result.isError).toBe(true);
    expect(textOf(reply)).toMatch(/invalid arguments: task/);
  });
});

describe('cezar mcp tools', () => {
  it('cezar_list_projects', async () => {
    const { deps } = harness({ 'GET /projects': { bootProject: 'shop', projects: [{ id: 'shop', name: 'Shop', root: '/r/shop', extra: 1 }] } });
    const reply = await rpc(deps, 'tools/call', { name: 'cezar_list_projects', arguments: {} });
    expect(JSON.parse(textOf(reply))).toEqual({ bootProject: 'shop', projects: [{ id: 'shop', name: 'Shop', root: '/r/shop' }] });
  });

  it('cezar_list_tasks filters by status, hides archived, newest first, scoped by project', async () => {
    const { deps, calls } = harness({
      'GET /p/shop/runs': [
        run('old', { status: 'waiting', createdAt: '2026-09-01T00:00:00.000Z' }),
        run('new', { status: 'waiting', createdAt: '2026-09-02T00:00:00.000Z', titleSummary: 'Nice title' }),
        run('gone', { status: 'waiting', archived: true }),
        run('busy', { status: 'running' }),
      ],
    });
    const reply = await rpc(deps, 'tools/call', { name: 'cezar_list_tasks', arguments: { project: 'shop', status: ['waiting'] } });
    const tasks = JSON.parse(textOf(reply));
    expect(tasks.map((t: { id: string }) => t.id)).toEqual(['new', 'old']);
    expect(tasks[0].title).toBe('Nice title');
    expect(calls[0]!.url).toBe('http://127.0.0.1:4321/api/v1/p/shop/runs');
  });

  it('cezar_get_task resolves an id prefix and adds the pending question and last message', async () => {
    const { deps } = harness({
      'GET /runs': [run('abcdef123456'), run('zzz')],
      'GET /runs/abcdef123456': run('abcdef123456', { status: 'waiting', branch: 'cez/abc' }),
      'GET /runs/abcdef123456/history': {
        events: [
          { seq: 1, ts: 't', type: 'item.completed', item: { kind: 'message', role: 'assistant', id: 'm', text: 'first' } },
          { seq: 2, ts: 't', type: 'ask.requested', requestId: 'r', questions: [{ header: 'DB', question: 'Which DB?', options: [{ label: 'pg' }, { label: 'sqlite' }] }] },
          { seq: 3, ts: 't', type: 'item.completed', item: { kind: 'message', role: 'assistant', id: 'm2', text: 'I need to know the DB.' } },
        ],
        itemCount: 3,
        liveCursor: 'c',
        asOfSeq: 3,
        hasOlder: false,
      },
    });
    const reply = await rpc(deps, 'tools/call', { name: 'cezar_get_task', arguments: { id: 'abcdef12' } });
    expect(JSON.parse(textOf(reply))).toMatchObject({
      id: 'abcdef123456',
      status: 'waiting',
      branch: 'cez/abc',
      lastAgentMessage: 'I need to know the DB.',
      question: [{ question: 'Which DB?' }],
    });
  });

  it('cezar_get_task drops an answered ask: question only while the task waits', async () => {
    const history = {
      events: [{ seq: 1, ts: 't', type: 'ask.requested', requestId: 'r', questions: [{ header: 'DB', question: 'Which DB?', options: [{ label: 'pg' }, { label: 'sqlite' }] }] }],
      itemCount: 1,
      liveCursor: 'c',
      asOfSeq: 1,
      hasOlder: false,
    };
    const { deps } = harness({ 'GET /runs': [run('bbbb2222')], 'GET /runs/bbbb2222': run('bbbb2222', { status: 'running' }), 'GET /runs/bbbb2222/history': history });
    const reply = await rpc(deps, 'tools/call', { name: 'cezar_get_task', arguments: { id: 'bbbb2222' } });
    expect(JSON.parse(textOf(reply))).not.toHaveProperty('question');
  });

  it('cezar_get_task still answers when history fails, and rejects an unknown id', async () => {
    const { deps } = harness({ 'GET /runs': [run('aaaa1111')], 'GET /runs/aaaa1111': run('aaaa1111') });
    const ok = await rpc(deps, 'tools/call', { name: 'cezar_get_task', arguments: { id: 'aaaa1111' } });
    expect(JSON.parse(textOf(ok)).status).toBe('running');
    const bad = await rpc(deps, 'tools/call', { name: 'cezar_get_task', arguments: { id: 'nope00' } });
    expect(bad.result.isError).toBe(true);
    expect(textOf(bad)).toMatch(/no task "nope00"/);
  });

  it('cezar_create_task posts the run with the default workflow', async () => {
    const { deps, calls } = harness({ 'POST /runs': run('new1', { status: 'queued' }) });
    const reply = await rpc(deps, 'tools/call', { name: 'cezar_create_task', arguments: { task: 'fix it', runner: 'claude', autonomous: true } });
    expect(calls[0]).toMatchObject({ method: 'POST', body: { task: 'fix it', workflow: 'quick-task', runner: 'claude', autonomous: true } });
    expect(JSON.parse(textOf(reply))).toMatchObject({ id: 'new1', status: 'queued' });
  });

  it('cezar_send_message, cancel, accept and open_pr hit the right routes', async () => {
    const { deps, calls } = harness({
      'GET /runs': [run('t1xxxxxx')],
      'POST /runs/t1xxxxxx/messages': { ok: true },
      'POST /runs/t1xxxxxx/cancel': { cancelled: true },
      'POST /runs/t1xxxxxx/finish': { finished: true },
      'POST /runs/t1xxxxxx/pr': { url: 'https://github.com/o/r/pull/3', dryRun: false },
    });
    await rpc(deps, 'tools/call', { name: 'cezar_send_message', arguments: { id: 't1xxxx', text: 'use pg' } });
    expect(JSON.parse(textOf(await rpc(deps, 'tools/call', { name: 'cezar_cancel_task', arguments: { id: 't1xxxx' } })))).toEqual({ id: 't1xxxxxx', cancelled: true });
    await rpc(deps, 'tools/call', { name: 'cezar_accept_review', arguments: { id: 't1xxxx' } });
    const pr = await rpc(deps, 'tools/call', { name: 'cezar_open_pr', arguments: { id: 't1xxxx' } });
    expect(JSON.parse(textOf(pr)).url).toBe('https://github.com/o/r/pull/3');
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => c.url.replace('http://127.0.0.1:4321/api/v1', ''))).toEqual([
      '/runs/t1xxxxxx/messages',
      '/runs/t1xxxxxx/cancel',
      '/runs/t1xxxxxx/finish',
      '/runs/t1xxxxxx/pr',
    ]);
    expect(posts[0]!.body).toEqual({ text: 'use pg' });
    expect(posts[3]!.body).toEqual({ draft: true });
  });

  it('surfaces a cockpit refusal as a tool error', async () => {
    const { deps } = harness({ 'POST /runs': new Response(JSON.stringify({ error: 'unknown workflow: nope' }), { status: 404 }) });
    const reply = await rpc(deps, 'tools/call', { name: 'cezar_create_task', arguments: { task: 'x', workflow: 'nope' } });
    expect(reply.result.isError).toBe(true);
    expect(textOf(reply)).toBe('cezar refused: unknown workflow: nope');
  });

  it('says how to start the cockpit when it is unreachable', async () => {
    const deps: McpDeps = { env: {}, fetch: (async () => { throw new Error('ECONNREFUSED'); }) as never };
    const reply = await rpc(deps, 'tools/call', { name: 'cezar_list_projects', arguments: {} });
    expect(reply.result.isError).toBe(true);
    expect(textOf(reply)).toMatch(/not reachable at http:\/\/127\.0\.0\.1:4321.*CEZ_API_URL/);
  });
});

describe('cockpit discovery', () => {
  const fetchStub = (() => undefined) as never;
  const found = { record: { url: 'http://127.0.0.1:5555', pid: 9, repoRoot: '/r', startedAt: 't' }, reason: 'the only running cockpit (pid 9)' };

  it('--url beats CEZ_API_URL beats a discovered cockpit beats the default; CEZ_PROJECT_ID scopes every call', async () => {
    expect(cockpitBase({ fetch: fetchStub, env: {}, url: 'http://a:1/', discover: () => found })).toBe('http://a:1');
    expect(cockpitBase({ fetch: fetchStub, env: { CEZ_API_URL: 'http://b:2/' }, discover: () => found })).toBe('http://b:2');
    expect(cockpitBase({ fetch: fetchStub, env: {}, discover: () => found })).toBe('http://127.0.0.1:5555');
    expect(cockpitBase({ fetch: fetchStub, env: {}, discover: () => undefined })).toBe('http://127.0.0.1:4321');
    expect(cockpitBase({ fetch: fetchStub, env: {} })).toBe('http://127.0.0.1:4321');
    const { deps, calls } = harness({ 'GET /p/proj/runs': [] }, { CEZ_PROJECT_ID: 'proj' });
    await rpc(deps, 'tools/call', { name: 'cezar_list_tasks', arguments: {} });
    expect(calls[0]!.url).toBe('http://127.0.0.1:4321/api/v1/p/proj/runs');
  });
});

describe('cockpit discovery inside a task', () => {
  it('never guesses: no explicit address means a tool error, and discovery is not even asked', async () => {
    let asked = false;
    const deps: McpDeps = { env: { CEZ_TASK_ID: 'run-1' }, fetch: (async () => { throw new Error('must not call'); }) as never, discover: () => { asked = true; return undefined; } };
    expect(cockpitBase(deps)).toBeUndefined();
    const reply = await rpc(deps, 'tools/call', { name: 'cezar_list_projects', arguments: {} });
    expect(reply.result.isError).toBe(true);
    expect(textOf(reply)).toMatch(/never guessed/);
    expect(asked).toBe(false);
    expect(cockpitBase({ ...deps, env: { CEZ_TASK_ID: 'run-1', CEZ_API_URL: 'http://c:3' } })).toBe('http://c:3');
  });

  it('uses the discovered cockpit for requests', async () => {
    const urls: string[] = [];
    const deps: McpDeps = {
      env: {},
      fetch: (async (input: string | URL | Request) => { urls.push(String(input)); return new Response('{"projects":[]}', { status: 200 }); }) as never,
      discover: () => ({ record: { url: 'http://127.0.0.1:5555', pid: 9, repoRoot: '/r', startedAt: 't' }, reason: 'x' }),
    };
    await rpc(deps, 'tools/call', { name: 'cezar_list_projects', arguments: {} });
    expect(urls).toEqual(['http://127.0.0.1:5555/api/v1/projects']);
  });
});

describe('task id resolution', () => {
  const uuid = '3f2b8c1e-5a4d-4e7f-9b21-0c6d7e8f9a10';

  it('a full id is one direct GET — the run list is never fetched', async () => {
    const { deps, calls } = harness({ [`GET /runs/${uuid}`]: run(uuid), [`POST /runs/${uuid}/cancel`]: { cancelled: true } });
    const reply = await rpc(deps, 'tools/call', { name: 'cezar_cancel_task', arguments: { id: uuid } });
    expect(JSON.parse(textOf(reply))).toEqual({ id: uuid, cancelled: true });
    expect(calls.map((c) => c.url.replace('http://127.0.0.1:4321/api/v1', ''))).toEqual([`/runs/${uuid}`, `/runs/${uuid}/cancel`]);
  });

  it('a full id the cockpit does not know is a clear error', async () => {
    const { deps } = harness({});
    const reply = await rpc(deps, 'tools/call', { name: 'cezar_cancel_task', arguments: { id: uuid } });
    expect(reply.result.isError).toBe(true);
    expect(textOf(reply)).toBe(`no task "${uuid}" in this project`);
  });

  it('refuses a prefix shorter than 6 characters without calling the cockpit', async () => {
    const { deps, calls } = harness({});
    const reply = await rpc(deps, 'tools/call', { name: 'cezar_get_task', arguments: { id: 'abcde' } });
    expect(reply.result.isError).toBe(true);
    expect(textOf(reply)).toMatch(/too short.*at least 6/);
    expect(calls).toHaveLength(0);
  });

  it('an ambiguous prefix lists the matches', async () => {
    const { deps } = harness({ 'GET /runs': [run('abc12345-aaaa', { title: 'first task' }), run('abc12345-bbbb', { title: 'second task' }), run('zzz')] });
    const reply = await rpc(deps, 'tools/call', { name: 'cezar_get_task', arguments: { id: 'abc123' } });
    expect(reply.result.isError).toBe(true);
    const text = textOf(reply);
    expect(text).toMatch(/ambiguous — 2 tasks match/);
    expect(text).toContain('abc12345-aaa first task');
    expect(text).toContain('abc12345-bbb second task');
  });
});

describe('stdio framing', () => {
  it('answers newline-delimited frames, skips notifications, survives garbage', async () => {
    const input = new PassThrough();
    const out: string[] = [];
    const { deps } = harness({});
    const done = serveMcp(deps, { input, write: (l) => out.push(l), error: () => undefined });
    input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}\n');
    input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    input.write('not json\n');
    input.write('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
    input.end();
    await done;
    const frames = out.map((l) => JSON.parse(l));
    expect(frames).toHaveLength(3);
    expect(frames.find((f) => f.id === 1).result.protocolVersion).toBe('2024-11-05');
    expect(frames.find((f) => f.id === null).error.code).toBe(-32700);
    expect(frames.find((f) => f.id === 2).result.tools.length).toBe(TOOLS.length);
  });
});

describe('cezar integrations print', () => {
  it('fills in the absolute launch command for this cezar', () => {
    expect(resolveMcpLaunch('/usr/bin/node', '/opt/cezar/dist/index.js')).toEqual({ command: '/usr/bin/node', args: ['/opt/cezar/dist/index.js', 'mcp'] });
    expect(resolveMcpLaunch('/usr/bin/node', '/src/index.ts')).toEqual({ command: 'cezar', args: ['mcp'] });
    const launch = { command: '/usr/bin/node', args: ['/opt/cezar/dist/index.js', 'mcp'] };
    const hermes = hermesSnippet(launch);
    expect(hermes).toContain('mcp_servers:');
    expect(hermes).toContain('command: "/usr/bin/node"');
    expect(hermes).toContain('deliver_only: true');
    expect(hermes).toContain('CEZ_HERMES_WEBHOOK_SECRET');
    const openclaw = openclawSnippet(launch);
    expect(openclaw).toContain(`openclaw mcp set cezar '{"command":"/usr/bin/node","args":["/opt/cezar/dist/index.js","mcp"]`);
    expect(openclaw).toContain('hooks: { enabled: true');
    expect(openclaw).toContain('openclaw mcp add cezar --command /usr/bin/node --arg /opt/cezar/dist/index.js --arg mcp\n');
    // Discovery covers the address: CEZ_API_URL is an optional pin, never in the live config.
    for (const text of [hermes, openclaw]) {
      expect(text.split('\n').filter((line) => line.includes('CEZ_API_URL') && !line.trimStart().startsWith('#'))).toEqual([]);
    }
    expect(openclaw).not.toContain('"env"}');
    expect(hermes).toContain('# env:');
    expect(openclaw).toContain('Out-File -Encoding utf8');
  });

  it('says which cockpit it found (or that none runs) instead of hard-coding an address', () => {
    const found = { record: { url: 'http://127.0.0.1:5555', pid: 9, repoRoot: '/r', startedAt: 't' }, reason: 'the only running cockpit (pid 9)' };
    const withCockpit: string[] = [];
    runIntegrationsCommand(['print', 'hermes'], (l) => withCockpit.push(l), found);
    expect(withCockpit[0]).toContain('Found now: http://127.0.0.1:5555');
    const without: string[] = [];
    runIntegrationsCommand(['print', 'openclaw'], (l) => without.push(l), undefined);
    expect(without[0]).toContain('none runs right now');
  });

  it('prints a skill with valid frontmatter per target and exits 2 on bad usage', () => {
    for (const target of INTEGRATION_TARGETS) {
      const lines: string[] = [];
      expect(runIntegrationsCommand(['print', target, '--skill'], (l) => lines.push(l))).toBe(0);
      const [, front, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(lines[0]!)!;
      const meta = parseYaml(front!) as Record<string, unknown>;
      expect(meta.name).toBe('cezar');
      expect(typeof meta.description).toBe('string');
      expect(meta.description as string).toContain(': ');
      // No PATH gate: the printed launch is absolute, so the skill must not hide when `cezar` is not on PATH.
      expect(meta).not.toHaveProperty('metadata');
      expect(body).toContain('cezar_create_task');
      expect(body).toContain('lastAgentMessage');
    }
    expect(skillMarkdown('openclaw')).not.toContain('requires');
    expect(runIntegrationsCommand(['print', 'nope'], () => undefined)).toBe(2);
  });
});
