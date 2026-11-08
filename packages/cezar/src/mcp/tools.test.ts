import { afterEach, describe, expect, it } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createApiClient, type CezarFetch } from './api.ts';
import { buildMcpServer, EVENTS_MAX_WALK_PAGES, RESPONSE_BUDGET_CHARS, WAIT_MAX_SECONDS, type Cockpit } from './tools.ts';

/** The `cez mcp` tool set over a stubbed cockpit (#1109): what is pinned is the route each tool
 *  calls, how it shapes the answer, and the annotations a client decides auto-approval from.
 *  `tools.routes.test.ts` runs the same tools against the real router. */

type Reply = { status?: number; body?: unknown };
type Call = { method: string; url: URL; body?: unknown };
type Routes = Record<string, Reply | ((url: URL, init?: RequestInit) => Reply | Promise<Reply>)>;

function stubFetch(routes: Routes, calls: Call[] = []): CezarFetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const route = routes[`${method} ${url.pathname}`];
    if (!route) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    if (init?.signal?.aborted) throw init.signal.reason;
    const reply = typeof route === 'function' ? await route(url, init) : route;
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

interface ConnectOptions {
  readOnly?: boolean;
  calls?: Call[];
  cockpit?: () => Promise<Cockpit>;
  pollIntervalMs?: number;
}

async function connect(routes: Routes, opts: ConnectOptions = {}) {
  const api = createApiClient({ baseUrl: 'http://127.0.0.1:4321', fetch: stubFetch(routes, opts.calls) });
  const server = buildMcpServer({
    cockpit: opts.cockpit ?? (async () => ({ api, defaultProjectId: 'default' })),
    version: '0.0.0-test',
    pollIntervalMs: opts.pollIntervalMs ?? 20,
    ...(opts.readOnly ? { readOnly: true } : {}),
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const mcp = new Client({ name: 'test', version: '0.0.0' });
  await mcp.connect(clientSide);
  clients.push(mcp);
  return mcp;
}

const textOf = (result: { content?: unknown }) =>
  ((result.content as Array<{ type: string; text?: string }> | undefined) ?? []).map((c) => c.text ?? '').join('');

const run = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  status,
  title: `t-${id}`,
  workflow: 'quick-task',
  task: 'do it',
  createdAt: '2026-10-13T10:00:00.000Z',
  tokensUsed: 0,
  archived: false,
  steps: [],
  ...extra,
});

const ALL_TOOLS = [
  'list_projects',
  'list_workflows',
  'list_models',
  'list_runs',
  'get_run',
  'get_run_status',
  'list_run_events',
  'wait_for_runs',
  'get_pr_status',
  'start_run',
  'cancel_run',
  'push_run_branch',
  'send_run_message',
  'review_run',
];
const WRITE_TOOLS = ['start_run', 'cancel_run', 'push_run_branch', 'send_run_message', 'review_run'];

describe('cez mcp tools: registration', () => {
  it('registers the fourteen tools, each stating all four hints and an object output schema', async () => {
    const mcp = await connect({});
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...ALL_TOOLS].sort());
    for (const tool of tools) {
      for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
        expect(typeof tool.annotations?.[hint], `${tool.name}.${hint}`).toBe('boolean');
      }
      expect(tool.outputSchema?.type, `${tool.name}.outputSchema`).toBe('object');
      expect(tool.name).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    for (const name of WRITE_TOOLS) expect(byName[name]?.readOnlyHint, name).toBe(false);
    for (const name of ALL_TOOLS.filter((n) => !WRITE_TOOLS.includes(n))) expect(byName[name]?.readOnlyHint, name).toBe(true);
    expect(byName.cancel_run?.destructiveHint).toBe(true);
    expect(byName.start_run?.destructiveHint).toBe(false);
    expect(byName.start_run?.idempotentHint).toBe(false);
    // A push reaches the remote; an answer or a send-back wakes an agent that acts on the world.
    for (const name of ['push_run_branch', 'send_run_message', 'review_run']) expect(byName[name]?.openWorldHint, name).toBe(true);
    // Accept merges nothing and a push never forces: neither destroys anything.
    for (const name of ['push_run_branch', 'send_run_message', 'review_run']) expect(byName[name]?.destructiveHint, name).toBe(false);
    expect(byName.push_run_branch?.idempotentHint).toBe(true);
    expect(byName.send_run_message?.idempotentHint).toBe(false);
    expect(byName.review_run?.idempotentHint).toBe(false);
  });

  it('read-only mode does not register the write tools at all', async () => {
    const mcp = await connect({}, { readOnly: true });
    const names = (await mcp.listTools()).tools.map((t) => t.name);
    expect(names.sort()).toEqual(ALL_TOOLS.filter((n) => !WRITE_TOOLS.includes(n)).sort());
    await expect(mcp.callTool({ name: 'start_run', arguments: { workflow: 'quick-task', task: 'x' } })).rejects.toThrow(
      /Tool start_run not found/,
    );
    for (const name of ['push_run_branch', 'send_run_message', 'review_run']) {
      await expect(mcp.callTool({ name, arguments: { runId: 'r1' } }), name).rejects.toThrow(new RegExp(`Tool ${name} not found`));
    }
  });

  it('argument names are camelCase, like the contract', async () => {
    const mcp = await connect({});
    for (const tool of (await mcp.listTools()).tools) {
      for (const key of Object.keys(tool.inputSchema.properties ?? {})) expect(key, `${tool.name}.${key}`).toMatch(/^[a-z][a-zA-Z]*$/);
    }
  });
});

describe('cez mcp tools: reads', () => {
  it('list_projects reads the workspace registry and keeps only the summary fields', async () => {
    const mcp = await connect({
      'GET /api/v1/projects': {
        body: {
          bootProject: 'p1',
          projectsDir: '/x',
          projects: [{ id: 'p1', name: 'app', root: '/r/app', status: 'ok', branch: 'main', addedAt: '', lastOpenedAt: '', source: 'local', tags: ['a'] }],
        },
      },
    });
    const result = await mcp.callTool({ name: 'list_projects', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      bootProject: 'p1',
      projects: [{ id: 'p1', name: 'app', root: '/r/app', status: 'ok', branch: 'main' }],
    });
    expect(JSON.parse(textOf(result))).toEqual(result.structuredContent);
  });

  it('list_workflows names each step', async () => {
    const mcp = await connect({
      'GET /api/v1/p/default/workflows': {
        body: {
          workflows: [{ name: 'quick-task', source: 'built-in', steps: [{ id: 'agent', name: 'Agent', prompt: '{{task}}' }, { id: 'c', skill: 'review' }] }],
          issues: [],
        },
      },
    });
    const result = await mcp.callTool({ name: 'list_workflows', arguments: {} });
    expect(result.structuredContent).toEqual({ workflows: [{ name: 'quick-task', source: 'built-in', steps: ['Agent', 'review'] }] });
  });

  it('list_runs filters the cross-project index and caps the rows', async () => {
    const row = (id: string, projectId: string, status: string, createdAt: string, archived = false) => ({
      id, projectId, status, createdAt, archived, title: `t-${id}`, workflow: 'quick-task',
    });
    const mcp = await connect({
      'GET /api/v1/workspace/runs-index': {
        body: {
          runs: [row('a', 'p1', 'done', '2026-09-01'), row('b', 'p1', 'running', '2026-09-03'), row('c', 'p2', 'running', '2026-09-02'), row('d', 'p1', 'running', '2026-09-04', true)],
          truncated: [],
          perProjectLimit: 200,
          referenceStatuses: {},
        },
      },
    });
    const result = await mcp.callTool({ name: 'list_runs', arguments: { status: ['running'], limit: 1 } });
    const body = result.structuredContent as { runs: Array<{ id: string }>; total: number; more?: number };
    expect(body.runs.map((r) => r.id)).toEqual(['b']);
    expect(body.total).toBe(2);
    expect(body.more).toBe(1);
    const p2 = await mcp.callTool({ name: 'list_runs', arguments: { projectId: 'p2' } });
    expect((p2.structuredContent as { runs: Array<{ id: string }> }).runs.map((r) => r.id)).toEqual(['c']);
  });

  it("list_runs takes projectId 'default' as the boot project, like every other tool", async () => {
    const row = (id: string, projectId: string) => ({ id, projectId, status: 'done', createdAt: '2026-09-01', archived: false, title: id, workflow: 'q' });
    const mcp = await connect({
      'GET /api/v1/workspace/runs-index': { body: { runs: [row('a', 'boot'), row('b', 'p2')], truncated: [], perProjectLimit: 200, referenceStatuses: {} } },
      'GET /api/v1/projects': { body: { bootProject: 'boot', projectsDir: '/', projects: [] } },
    });
    const result = await mcp.callTool({ name: 'list_runs', arguments: { projectId: 'default' } });
    expect((result.structuredContent as { runs: Array<{ id: string }> }).runs.map((r) => r.id)).toEqual(['a']);
  });

  it('list_runs stays inside the answer budget and counts the rest as more', async () => {
    const runs = Array.from({ length: 200 }, (_, i) => ({
      id: `r${String(i).padStart(3, '0')}`, projectId: 'p', status: 'done', createdAt: `2026-09-01T00:00:${String(i % 60).padStart(2, '0')}Z`,
      archived: false, title: 'x'.repeat(2_000), workflow: 'q', branch: 'b'.repeat(200),
    }));
    const mcp = await connect({ 'GET /api/v1/workspace/runs-index': { body: { runs, truncated: [], perProjectLimit: 200, referenceStatuses: {} } } });
    const result = await mcp.callTool({ name: 'list_runs', arguments: { limit: 200 } });
    const body = result.structuredContent as { runs: unknown[]; total: number; more: number };
    expect(textOf(result).length).toBeLessThanOrEqual(RESPONSE_BUDGET_CHARS);
    expect(body.total).toBe(200);
    expect(body.runs.length + body.more).toBe(200);
    expect(body.runs.length).toBeGreaterThan(10);
  });

  it('get_run of a pathological record stays inside the answer budget', async () => {
    const steps = Array.from({ length: 200 }, (_, i) => ({ id: `s${i}`, status: 'done', output: 'y'.repeat(5_000) }));
    const mcp = await connect({ 'GET /api/v1/p/default/runs/r1': { body: run('r1', 'done', { steps }) } });
    const result = await mcp.callTool({ name: 'get_run', arguments: { runId: 'r1' } });
    expect(result.isError).toBeFalsy();
    expect(textOf(result).length).toBeLessThanOrEqual(RESPONSE_BUDGET_CHARS);
    expect(JSON.stringify(result.structuredContent).length).toBeLessThanOrEqual(RESPONSE_BUDGET_CHARS);
    expect((result.structuredContent as { id: string }).id).toBe('r1');
  });

  it('project-scoped tools hit the /p/:projectId spelling, defaulting to the cockpit default project', async () => {
    const calls: Call[] = [];
    const mcp = await connect(
      {
        'GET /api/v1/p/default/runs/r1': { body: run('r1', 'running', { task: 'long task' }) },
        'GET /api/v1/p/other/runs/r1': { body: run('r1', 'done') },
      },
      { calls },
    );
    const a = await mcp.callTool({ name: 'get_run_status', arguments: { runId: 'r1' } });
    const b = await mcp.callTool({ name: 'get_run_status', arguments: { runId: 'r1', projectId: 'other' } });
    expect(a.structuredContent).toEqual({ id: 'r1', projectId: 'default', status: 'running', title: 't-r1', workflow: 'quick-task', createdAt: '2026-10-13T10:00:00.000Z' });
    expect(b.structuredContent).toMatchObject({ projectId: 'other', status: 'done' });
    expect(calls.map((c) => c.url.pathname)).toEqual(['/api/v1/p/default/runs/r1', '/api/v1/p/other/runs/r1']);
  });

  it('get_run returns the record with long strings clipped and unknown keys kept', async () => {
    const mcp = await connect({ 'GET /api/v1/p/default/runs/r1': { body: run('r1', 'review', { task: 'x'.repeat(5_000), futureKey: 1 }) } });
    const result = await mcp.callTool({ name: 'get_run', arguments: { runId: 'r1' } });
    const body = result.structuredContent as { task: string; futureKey: number; status: string };
    expect(body.task.length).toBeLessThan(2_100);
    expect(body.task).toContain('more chars]');
    expect(body.futureKey).toBe(1);
  });

  describe('a run outside the default project, without projectId', () => {
    const index = { body: { runs: [{ id: 'r1', projectId: 'p2', status: 'done', createdAt: '2026-09-01', archived: false, title: 't', workflow: 'q' }], truncated: [], perProjectLimit: 200, referenceStatuses: {} } };
    const routes = (): Routes => ({
      'GET /api/v1/workspace/runs-index': index,
      'GET /api/v1/p/p2/runs/r1': { body: run('r1', 'done') },
      'GET /api/v1/p/p2/runs/r1/history': { body: { events: [{ seq: 1, ts: 't', type: 'text' }], itemCount: 1, liveCursor: 'l', asOfSeq: 1, hasOlder: false } },
      'POST /api/v1/p/p2/runs/r1/cancel': { body: { cancelled: true } },
    });

    it.each([
      ['get_run', {}],
      ['get_run_status', {}],
      ['list_run_events', {}],
      ['wait_for_runs', { runIds: ['r1'] }],
    ])('%s finds its project through the cross-project index', async (name, extra) => {
      const calls: Call[] = [];
      const mcp = await connect(routes(), { calls });
      const result = await mcp.callTool({ name, arguments: name === 'wait_for_runs' ? extra : { runId: 'r1', ...extra } });
      expect(result.isError, textOf(result)).toBeFalsy();
      expect(calls.map((c) => c.url.pathname)).toContain('/api/v1/workspace/runs-index');
      expect(calls.at(-1)?.url.pathname.startsWith('/api/v1/p/p2/runs/r1')).toBe(true);
    });

    it('wait_for_runs looks the project up once, not on every poll', async () => {
      const calls: Call[] = [];
      let n = 0;
      const mcp = await connect(
        { ...routes(), 'GET /api/v1/p/p2/runs/r1': () => ({ body: run('r1', (n += 1) < 3 ? 'running' : 'done') }) },
        { calls },
      );
      await mcp.callTool({ name: 'wait_for_runs', arguments: { runIds: ['r1'], timeoutSeconds: 10 } });
      expect(calls.filter((c) => c.url.pathname === '/api/v1/workspace/runs-index')).toHaveLength(1);
    });

    it('cancel_run does not guess: it names the project instead', async () => {
      const calls: Call[] = [];
      const mcp = await connect(routes(), { calls });
      const result = await mcp.callTool({ name: 'cancel_run', arguments: { runId: 'r1' } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe('cezar refused: 404: not found — run r1 belongs to project "p2"; pass projectId: "p2"');
      expect(calls.filter((c) => c.method === 'POST').map((c) => c.url.pathname)).toEqual(['/api/v1/p/default/runs/r1/cancel']);
    });

    it('a run no project has: says so, instead of pointing at a projectId', async () => {
      const mcp = await connect({ 'GET /api/v1/workspace/runs-index': { body: { ...index.body, runs: [] } } });
      const result = await mcp.callTool({ name: 'get_run_status', arguments: { runId: 'r1' } });
      expect(textOf(result)).toBe('cezar refused: 404: not found — no project of this cockpit has a run r1 — check the id (list_runs)');
    });

    it('a run past the index cap may still exist: the hint names the capped projects', async () => {
      const mcp = await connect({ 'GET /api/v1/workspace/runs-index': { body: { ...index.body, runs: [], truncated: ['p2'] } } });
      const result = await mcp.callTool({ name: 'get_run_status', arguments: { runId: 'r1' } });
      expect(textOf(result)).toMatch(/run r1 is in no project's recent runs \(older runs of p2 are not indexed\) — check the id, or pass its projectId$/);
    });

    it('without the index, the hint stays the generic one', async () => {
      const mcp = await connect({ 'GET /api/v1/workspace/runs-index': { status: 500 } });
      const result = await mcp.callTool({ name: 'get_run_status', arguments: { runId: 'r1' } });
      expect(textOf(result)).toMatch(/run r1 is not in the default project; pass its projectId/);
    });

    it.each(['get_run_status', 'get_run', 'wait_for_runs'])('%s names the project it followed the run to', async (name) => {
      const mcp = await connect(routes());
      const result = await mcp.callTool({ name, arguments: name === 'wait_for_runs' ? { runIds: ['r1'] } : { runId: 'r1' } });
      const body = result.structuredContent as { projectId?: string; runs?: Array<{ projectId?: string }> };
      expect(body.runs?.[0]?.projectId ?? body.projectId).toBe('p2');
    });
  });

  it('a refusal from the cockpit is a readable tool error, not a protocol error', async () => {
    const mcp = await connect({});
    const result = await mcp.callTool({ name: 'get_run', arguments: { runId: 'missing' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^cezar refused: 404: not found — run missing is not in the default project/);
  });

  it('an answer in an unknown shape is a readable tool error', async () => {
    const mcp = await connect({ 'GET /api/v1/projects': { body: { projects: 'nope' } } });
    const result = await mcp.callTool({ name: 'list_projects', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/shape this cez mcp does not recognize/);
  });

  it('an unreachable cockpit is a readable tool error, and a read is retried once after it', async () => {
    let attempts = 0;
    const mcp = await connect({}, {
      cockpit: async () => {
        attempts += 1;
        throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:4321') });
      },
    });
    const result = await mcp.callTool({ name: 'list_projects', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('cannot reach the cezar cockpit (connect ECONNREFUSED 127.0.0.1:4321)');
    expect(attempts).toBe(2);
  });

  it('a write is never retried after a connection error', async () => {
    let attempts = 0;
    const mcp = await connect({}, {
      cockpit: async () => {
        attempts += 1;
        throw new TypeError('fetch failed');
      },
    });
    const result = await mcp.callTool({ name: 'cancel_run', arguments: { runId: 'r1' } });
    expect(result.isError).toBe(true);
    expect(attempts).toBe(1);
  });

  it('get_pr_status sends the numbers comma-joined and degrades in the payload', async () => {
    const calls: Call[] = [];
    const mcp = await connect(
      { 'GET /api/v1/p/default/github/ref-status': { body: { available: false, reason: 'no gh', recheckAfterMs: null } } },
      { calls },
    );
    const result = await mcp.callTool({ name: 'get_pr_status', arguments: { prs: [1, 2], issues: [3] } });
    expect(result.structuredContent).toEqual({ available: false, reason: 'no gh', recheckAfterMs: null });
    expect(calls[0]?.url.search).toBe('?prs=1%2C2&issues=3');
    const empty = await mcp.callTool({ name: 'get_pr_status', arguments: {} });
    expect(empty.isError).toBe(true);
  });
});

describe('cez mcp tools: list_run_events', () => {
  const ev = (seq: number) => ({ seq, ts: '2026-10-13T10:00:00.000Z', type: 'text', text: `e${seq}` });
  const page = (from: number, to: number, olderCursor?: string) => ({
    events: Array.from({ length: to - from + 1 }, (_, i) => ev(from + i)),
    itemCount: to - from + 1,
    liveCursor: 'live',
    asOfSeq: 1_000,
    hasOlder: olderCursor !== undefined,
    ...(olderCursor ? { olderCursor } : {}),
  });

  it('without arguments returns the newest page, oldest first, with the cursor to page back', async () => {
    const mcp = await connect({ 'GET /api/v1/p/default/runs/r1/history': { body: page(901, 1_000, 'c1') } });
    const result = await mcp.callTool({ name: 'list_run_events', arguments: { runId: 'r1' } });
    const body = result.structuredContent as { events: Array<{ seq: number }>; olderCursor?: string; asOfSeq: number };
    expect(body.events[0]?.seq).toBe(901);
    expect(body.events.at(-1)?.seq).toBe(1_000);
    expect(body.olderCursor).toBe('c1');
    expect(body.asOfSeq).toBe(1_000);
  });

  it('afterSeq walks back from the tip until it is covered, and returns only newer events', async () => {
    const calls: Call[] = [];
    const pages: Record<string, ReturnType<typeof page>> = { tip: page(901, 1_000, 'c1'), c1: page(800, 901, 'c2'), c2: page(700, 800, 'c3') };
    const mcp = await connect(
      { 'GET /api/v1/p/default/runs/r1/history': (url) => ({ body: pages[url.searchParams.get('cursor') ?? 'tip'] }) },
      { calls },
    );
    const result = await mcp.callTool({ name: 'list_run_events', arguments: { runId: 'r1', afterSeq: 850 } });
    const body = result.structuredContent as { events: Array<{ seq: number }>; gap?: boolean; olderCursor?: string };
    expect(body.events.map((e) => e.seq)).toEqual(Array.from({ length: 150 }, (_, i) => 851 + i));
    expect(body.gap).toBeUndefined();
    expect(body.olderCursor).toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it('afterSeq too far back stops after a bounded walk and says there is a gap', async () => {
    const calls: Call[] = [];
    const mcp = await connect(
      {
        'GET /api/v1/p/default/runs/r1/history': (url) => {
          const n = Number(url.searchParams.get('cursor') ?? 0);
          const top = 10_000 - n * 100;
          return { body: page(top - 99, top, String(n + 1)) };
        },
      },
      { calls },
    );
    const result = await mcp.callTool({ name: 'list_run_events', arguments: { runId: 'r1', afterSeq: 5 } });
    const body = result.structuredContent as { events: Array<{ seq: number }>; gap?: boolean; olderCursor?: string };
    expect(calls).toHaveLength(1 + EVENTS_MAX_WALK_PAGES);
    expect(body.gap).toBe(true);
    expect(body.olderCursor).toBe(String(EVENTS_MAX_WALK_PAGES + 1));
    expect(body.events[0]?.seq).toBe(10_000 - (EVENTS_MAX_WALK_PAGES + 1) * 100 + 1);
  });

  it("a page's leading turn opener does not count as coverage, and seq gaps do not stop the walk", async () => {
    // As `/history` really pages a long turn: every page leads with the turn's opener (seq 6),
    // and ephemeral deltas leave every third seq out of the file.
    const opener = { seq: 6, ts: '2026-10-13T10:00:00.000Z', type: 'turn.started' };
    const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i).filter((s) => s % 3 !== 0).map(ev);
    const pages: Record<string, unknown> = {
      tip: { ...page(0, -1, 'c1'), events: [opener, ...range(202, 400)] },
      c1: { ...page(0, -1, 'c2'), events: [opener, ...range(102, 201)] },
      c2: { ...page(0, -1), events: [opener, ...range(7, 101)] },
    };
    const mcp = await connect({ 'GET /api/v1/p/default/runs/r1/history': (url) => ({ body: pages[url.searchParams.get('cursor') ?? 'tip'] }) });
    const result = await mcp.callTool({ name: 'list_run_events', arguments: { runId: 'r1', afterSeq: 100 } });
    const body = result.structuredContent as { events: Array<{ seq: number }>; gap?: boolean };
    expect(body.gap).toBeUndefined();
    expect(body.events[0]?.seq).toBe(101);
    expect(body.events.at(-1)?.seq).toBe(400);
    expect(body.events.map((e) => e.seq)).toEqual(range(101, 400).map((e) => e.seq));
  });

  describe('the answer budget', () => {
    /** 100 events of ~3 kB text each: ~300 kB of history, like a long real run's page. */
    const big = (from: number, to: number, olderCursor?: string) => ({
      ...page(from, to, olderCursor),
      events: Array.from({ length: to - from + 1 }, (_, i) => ({ seq: from + i, ts: '2026-10-13T10:00:00.000Z', type: 'tool.result', text: 'z'.repeat(3_000), extra: 'q'.repeat(3_000) })),
    });
    const history = (pages: Record<string, unknown>) =>
      ({ 'GET /api/v1/p/default/runs/r1/history': (url: URL) => ({ body: pages[url.searchParams.get('cursor') ?? 'tip'] }) }) satisfies Routes;
    type Body = { events: Array<{ seq: number }>; truncated?: boolean; nextAfterSeq?: number; skippedAfterSeq?: number; gap?: boolean };

    it('without arguments keeps the newest events inside the budget, text and structuredContent alike', async () => {
      const mcp = await connect(history({ tip: big(901, 1_000, 'c1') }));
      const result = await mcp.callTool({ name: 'list_run_events', arguments: { runId: 'r1' } });
      const body = result.structuredContent as Body;
      expect(textOf(result).length).toBeLessThanOrEqual(RESPONSE_BUDGET_CHARS);
      expect(JSON.stringify(body).length).toBeLessThanOrEqual(RESPONSE_BUDGET_CHARS);
      expect(body.truncated).toBe(true);
      expect(body.events.at(-1)?.seq).toBe(1_000);
      expect(body.skippedAfterSeq).toBe(900);
    });

    it('nextAfterSeq / skippedAfterSeq read every event exactly once, without losing one', async () => {
      const mcp = await connect(history({ tip: big(901, 1_000, 'c1'), c1: big(801, 900, 'c2'), c2: big(701, 800) }));
      const seen: number[] = [];
      const first = (await mcp.callTool({ name: 'list_run_events', arguments: { runId: 'r1' } })).structuredContent as Body;
      const tail = first.events.map((e) => e.seq);
      let afterSeq = first.skippedAfterSeq!;
      for (let i = 0; i < 20 && afterSeq < tail[0]! - 1; i += 1) {
        const result = await mcp.callTool({ name: 'list_run_events', arguments: { runId: 'r1', afterSeq } });
        expect(textOf(result).length).toBeLessThanOrEqual(RESPONSE_BUDGET_CHARS);
        const body = result.structuredContent as Body;
        seen.push(...body.events.map((e) => e.seq).filter((s) => s < tail[0]!));
        if (!body.nextAfterSeq) break;
        afterSeq = body.nextAfterSeq;
      }
      expect([...seen, ...tail]).toEqual(Array.from({ length: 100 }, (_, i) => 901 + i));
    });

    it('afterSeq: 0 on a long run answers in the budget and says where to continue', async () => {
      const mcp = await connect(history({ tip: big(901, 1_000, 'c1'), c1: big(801, 900, 'c2'), c2: big(701, 800, 'c3'), c3: big(601, 700, 'c4'), c4: big(501, 600, 'c5'), c5: big(401, 500, 'c6') }));
      const result = await mcp.callTool({ name: 'list_run_events', arguments: { runId: 'r1', afterSeq: 0 } });
      const body = result.structuredContent as Body & { olderCursor?: string };
      expect(textOf(result).length).toBeLessThanOrEqual(RESPONSE_BUDGET_CHARS);
      expect(body.gap).toBe(true);
      expect(body.olderCursor).toBe('c6');
      expect(body.events[0]?.seq).toBe(401);
      expect(body.nextAfterSeq).toBe(body.events.at(-1)?.seq);
    });

    it('with a cursor, continues inside the same page through cursor + afterSeq', async () => {
      const calls: Call[] = [];
      const mcp = await connect(history({ tip: big(901, 1_000, 'c1'), c1: big(801, 900, 'c2') }), { calls });
      const a = (await mcp.callTool({ name: 'list_run_events', arguments: { runId: 'r1', cursor: 'c1' } })).structuredContent as Body;
      expect(a.events[0]?.seq).toBe(801);
      const b = (await mcp.callTool({ name: 'list_run_events', arguments: { runId: 'r1', cursor: 'c1', afterSeq: a.nextAfterSeq } })).structuredContent as Body;
      expect(b.events[0]?.seq).toBe(a.nextAfterSeq! + 1);
      expect(calls.every((c) => c.url.searchParams.get('cursor') === 'c1')).toBe(true);
    });

    it('maxEvents caps the count; one event bigger than the budget is clipped, never stalls the cursor', async () => {
      const mcp = await connect(history({ tip: { ...page(1, 3), events: [1, 2, 3].map((seq) => ({ seq, ts: 't', type: 'x', ...Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, 'w'.repeat(20_000)])) })) } }));
      const capped = (await mcp.callTool({ name: 'list_run_events', arguments: { runId: 'r1', afterSeq: 0, maxEvents: 1, maxChars: 20_000 } })).structuredContent as Body;
      expect(capped.events.map((e) => e.seq)).toEqual([1]);
      expect(capped.nextAfterSeq).toBe(1);
      expect(JSON.stringify(capped).length).toBeLessThanOrEqual(RESPONSE_BUDGET_CHARS);
    });
  });

  it('a cursor is passed through to /history', async () => {
    const calls: Call[] = [];
    const mcp = await connect({ 'GET /api/v1/p/default/runs/r1/history': { body: page(1, 10) } }, { calls });
    await mcp.callTool({ name: 'list_run_events', arguments: { runId: 'r1', cursor: 'abc' } });
    expect(calls[0]?.url.searchParams.get('cursor')).toBe('abc');
  });
});

describe('cez mcp tools: start_run and cancel_run', () => {
  it('start_run posts a named-workflow body and answers with the compact record', async () => {
    const calls: Call[] = [];
    const mcp = await connect(
      { 'POST /api/v1/p/default/runs': { status: 201, body: run('r9', 'queued', { title: 'Fix', task: 'Fix it' }) } },
      { calls },
    );
    const result = await mcp.callTool({ name: 'start_run', arguments: { workflow: 'quick-task', task: 'Fix it', runner: 'codex' } });
    expect(result.structuredContent).toEqual({
      id: 'r9',
      projectId: 'default',
      status: 'queued',
      title: 'Fix',
      workflow: 'quick-task',
      createdAt: '2026-10-13T10:00:00.000Z',
    });
    expect(calls[0]?.body).toEqual({ workflow: 'quick-task', task: 'Fix it', runner: 'codex' });
  });

  it('start_run names the project the run went to', async () => {
    const api = createApiClient({
      baseUrl: 'http://127.0.0.1:4321',
      fetch: stubFetch({ 'POST /api/v1/p/repob/runs': { status: 201, body: run('r9', 'queued') } }),
    });
    const mcp = await connect({}, { cockpit: async () => ({ api, defaultProjectId: 'repob' }) });
    const result = await mcp.callTool({ name: 'start_run', arguments: { workflow: 'quick-task', task: 'x' } });
    expect((result.structuredContent as { projectId: string }).projectId).toBe('repob');
  });

  it('start_run without projectId refuses when the project holding the cwd is unknown; with one it goes ahead', async () => {
    const calls: Call[] = [];
    const api = createApiClient({
      baseUrl: 'http://127.0.0.1:4321',
      fetch: stubFetch({ 'POST /api/v1/p/repob/runs': { status: 201, body: run('r9', 'queued') } }, calls),
    });
    const projectUnknown = 'could not read the project list of http://127.0.0.1:4321 (503), so which project holds /r is unknown — pass projectId';
    const mcp = await connect({}, { cockpit: async () => ({ api, defaultProjectId: 'default', projectUnknown }) });
    const refused = await mcp.callTool({ name: 'start_run', arguments: { workflow: 'quick-task', task: 'x' } });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toBe(projectUnknown);
    expect(calls).toEqual([]);
    const named = await mcp.callTool({ name: 'start_run', arguments: { workflow: 'quick-task', task: 'x', projectId: 'repob' } });
    expect(named.isError, textOf(named)).toBeFalsy();
    expect(calls.map((c) => c.url.pathname)).toEqual(['/api/v1/p/repob/runs']);
  });

  it.each([
    ['an empty task', { workflow: 'quick-task', task: '' }],
    ['no workflow', { task: 'x' }],
    ['inline steps', { task: 'x', steps: [{ id: 'a', prompt: 'p' }] }],
    ['an unknown runner', { workflow: 'quick-task', task: 'x', runner: 'gpt' }],
  ])('start_run refuses %s before anything reaches the cockpit', async (_, args) => {
    const calls: Call[] = [];
    const mcp = await connect({}, { calls });
    const result = await mcp.callTool({ name: 'start_run', arguments: args });
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it("start_run relays the route's refusal (unknown workflow)", async () => {
    const mcp = await connect({ 'POST /api/v1/p/default/runs': { status: 404, body: { error: 'unknown workflow: nope' } } });
    const result = await mcp.callTool({ name: 'start_run', arguments: { workflow: 'nope', task: 'x' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('cezar refused: 404: unknown workflow: nope');
  });

  it('cancel_run posts to the cancel route', async () => {
    const calls: Call[] = [];
    const mcp = await connect({ 'POST /api/v1/p/default/runs/r1/cancel': { body: { cancelled: true } } }, { calls });
    const result = await mcp.callTool({ name: 'cancel_run', arguments: { runId: 'r1' } });
    expect(result.structuredContent).toEqual({ cancelled: true });
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual(['POST /api/v1/p/default/runs/r1/cancel']);
  });
});

describe('cez mcp tools: push_run_branch, send_run_message, review_run', () => {
  const R = '/api/v1/p/default/runs/r1';
  const posts = (calls: Call[]) => calls.filter((c) => c.method === 'POST').map((c) => c.url.pathname);

  describe('push_run_branch', () => {
    it('posts to git/push with no body and names the branch, remote and newest commit', async () => {
      const calls: Call[] = [];
      const mcp = await connect(
        {
          [`GET ${R}`]: { body: run('r1', 'review') },
          [`POST ${R}/git/push`]: { body: { pushed: true, branch: 'cez/r1', remote: 'origin', upstreamSet: true } },
          [`GET ${R}/commits`]: {
            body: { commits: [{ sha: 'abc123', subject: 'fix: it', author: 'a', when: 'now' }, { sha: 'def', subject: 'b', author: 'a', when: 'then' }] },
          },
        },
        { calls },
      );
      const result = await mcp.callTool({ name: 'push_run_branch', arguments: { runId: 'r1' } });
      expect(result.isError, textOf(result)).toBeFalsy();
      expect(result.structuredContent).toEqual({
        pushed: true,
        branch: 'cez/r1',
        remote: 'origin',
        upstreamSet: true,
        projectId: 'default',
        runId: 'r1',
        head: { sha: 'abc123', subject: 'fix: it' },
        commits: 2,
      });
      expect(posts(calls)).toEqual([`${R}/git/push`]);
      expect(calls.find((c) => c.method === 'POST')?.body).toBeUndefined();
    });

    it('takes no force, remote or branch argument', async () => {
      const mcp = await connect({});
      const tool = (await mcp.listTools()).tools.find((t) => t.name === 'push_run_branch');
      expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual(['projectId', 'runId']);
    });

    it('a pushed branch whose log cannot be read still reports the push', async () => {
      const mcp = await connect({
        [`GET ${R}`]: { body: run('r1', 'done') },
        [`POST ${R}/git/push`]: { body: { pushed: true, branch: 'b', remote: 'origin', upstreamSet: false } },
        [`GET ${R}/commits`]: { status: 409, body: { error: 'no worktree' } },
      });
      const result = await mcp.callTool({ name: 'push_run_branch', arguments: { runId: 'r1' } });
      expect(result.structuredContent).toEqual({ pushed: true, branch: 'b', remote: 'origin', upstreamSet: false, projectId: 'default', runId: 'r1' });
    });

    it.each([
      ['this cockpit', 'push rejected: [rejected] cez/r1 -> cez/r1 (non-fast-forward)', /non-fast-forward\)\. cez mcp does not force-push: have the run merge the remote branch/],
      ['an older cockpit', 'To /srv/bare.git', /only the destination line; usually the remote branch has commits this branch lacks\)\. cez mcp does not force-push$/],
    ])('a rejected push from %s is a readable error, sent once', async (_, reason, expected) => {
      const calls: Call[] = [];
      const mcp = await connect(
        { [`GET ${R}`]: { body: run('r1', 'review') }, [`POST ${R}/git/push`]: { status: 409, body: { error: reason } } },
        { calls },
      );
      const result = await mcp.callTool({ name: 'push_run_branch', arguments: { runId: 'r1' } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(new RegExp(`^cezar refused: 409: ${reason.replace(/[[\]()/.]/g, '\\$&')} — `));
      expect(textOf(result)).toMatch(expected);
      expect(posts(calls)).toEqual([`${R}/git/push`]);
    });

    it('any other refusal is relayed as is', async () => {
      const mcp = await connect({
        [`GET ${R}`]: { body: run('r1', 'done') },
        [`POST ${R}/git/push`]: { status: 409, body: { error: 'no remote configured — add one with `git remote add origin <url>`' } },
      });
      const result = await mcp.callTool({ name: 'push_run_branch', arguments: { runId: 'r1' } });
      expect(textOf(result)).toBe('cezar refused: 409: no remote configured — add one with `git remote add origin <url>`');
    });
  });

  describe('send_run_message', () => {
    it.each([
      ['waiting', { delivered: true }],
      ['running', { delivered: true }],
      ['queued', { queued: true, message: { id: 'm1', text: 'and this', createdAt: '2026-10-13T10:00:00.000Z' } }],
    ])('at %s posts the text to /messages and relays the answer', async (status, answer) => {
      const calls: Call[] = [];
      const mcp = await connect({ [`GET ${R}`]: { body: run('r1', status) }, [`POST ${R}/messages`]: { body: answer } }, { calls });
      const result = await mcp.callTool({ name: 'send_run_message', arguments: { runId: 'r1', text: 'Yes, use option B' } });
      expect(result.isError, textOf(result)).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ ...answer, projectId: 'default', runId: 'r1', status });
      expect(posts(calls)).toEqual([`${R}/messages`]);
      expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ text: 'Yes, use option B' });
    });

    it.each([
      ['done', /run r1 is done: send_run_message reaches only a waiting, running or queued run — it is finished — cez mcp does not reopen finished runs/],
      ['failed', /run r1 is failed: .* does not reopen finished runs/],
      ['cancelled', /run r1 is cancelled: .* does not reopen finished runs/],
      ['review', /run r1 is review: .* — decide with review_run$/],
    ])('at %s refuses with the status, and posts nothing', async (status, expected) => {
      const calls: Call[] = [];
      const mcp = await connect({ [`GET ${R}`]: { body: run('r1', status) } }, { calls });
      const result = await mcp.callTool({ name: 'send_run_message', arguments: { runId: 'r1', text: 'hi' } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(expected);
      expect(posts(calls)).toEqual([]);
    });

    it("a session that closed after the status read is the route's 409 with the status it ended at", async () => {
      let reads = 0;
      const mcp = await connect({
        [`GET ${R}`]: () => ({ body: run('r1', (reads += 1) === 1 ? 'waiting' : 'done') }),
        [`POST ${R}/messages`]: { status: 409, body: { error: 'session closed' } },
      });
      const result = await mcp.callTool({ name: 'send_run_message', arguments: { runId: 'r1', text: 'hi' } });
      expect(textOf(result)).toMatch(/^cezar refused: 409: session closed — run r1 is done: /);
    });

    it('refuses an empty message before anything reaches the cockpit', async () => {
      const calls: Call[] = [];
      const mcp = await connect({}, { calls });
      const result = await mcp.callTool({ name: 'send_run_message', arguments: { runId: 'r1', text: '   ' } });
      expect(result.isError).toBe(true);
      expect(calls).toEqual([]);
    });
  });

  describe('review_run', () => {
    it('accept posts /finish — and nothing else — and reports the status after it', async () => {
      const calls: Call[] = [];
      let reads = 0;
      const mcp = await connect(
        { [`GET ${R}`]: () => ({ body: run('r1', (reads += 1) === 1 ? 'review' : 'done') }), [`POST ${R}/finish`]: { body: { finished: true } } },
        { calls },
      );
      const result = await mcp.callTool({ name: 'review_run', arguments: { runId: 'r1', decision: 'accept' } });
      expect(result.isError, textOf(result)).toBeFalsy();
      expect(result.structuredContent).toEqual({ finished: true, projectId: 'default', runId: 'r1', decision: 'accept', status: 'done' });
      expect(posts(calls)).toEqual([`${R}/finish`]);
    });

    it('send_back posts the notes to /continue with the review panel\'s prefix', async () => {
      const calls: Call[] = [];
      let reads = 0;
      const mcp = await connect(
        { [`GET ${R}`]: () => ({ body: run('r1', (reads += 1) === 1 ? 'review' : 'running') }), [`POST ${R}/continue`]: { body: { continued: true } } },
        { calls },
      );
      const result = await mcp.callTool({ name: 'review_run', arguments: { runId: 'r1', decision: 'send_back', notes: '  Rename foo to bar.  ' } });
      expect(result.structuredContent).toEqual({ continued: true, projectId: 'default', runId: 'r1', decision: 'send_back', status: 'running' });
      expect(posts(calls)).toEqual([`${R}/continue`]);
      expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ text: 'Review feedback:\nRename foo to bar.' });
    });

    it.each(['waiting', 'running', 'done', 'failed'])('at %s refuses with the status, and posts nothing', async (status) => {
      const calls: Call[] = [];
      const mcp = await connect({ [`GET ${R}`]: { body: run('r1', status) } }, { calls });
      for (const decision of ['accept', 'send_back']) {
        const result = await mcp.callTool({ name: 'review_run', arguments: { runId: 'r1', decision, ...(decision === 'send_back' ? { notes: 'x' } : {}) } });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toBe(`run r1 is ${status}, not review — review_run only decides at the review gate`);
      }
      expect(posts(calls)).toEqual([]);
    });

    it.each([
      [{ decision: 'send_back' }, 'send_back needs notes: write what to change'],
      [{ decision: 'send_back', notes: '  ' }, 'send_back needs notes: write what to change'],
      [{ decision: 'accept', notes: 'looks good' }, 'accept takes no notes — use send_back to send them to the agent'],
    ])('%j is refused before anything reaches the cockpit', async (args, expected) => {
      const calls: Call[] = [];
      const mcp = await connect({}, { calls });
      const result = await mcp.callTool({ name: 'review_run', arguments: { runId: 'r1', ...args } });
      expect(textOf(result)).toBe(expected);
      expect(calls).toEqual([]);
    });

    it.each([
      ['accept', 'finish', 'no open session'],
      ['send_back', 'continue', 'run is still active'],
    ])("%s relays the route's 409 and says the run may still be settling", async (decision, route, reason) => {
      const mcp = await connect({
        [`GET ${R}`]: { body: run('r1', 'review') },
        [`POST ${R}/${route}`]: { status: 409, body: { error: reason } },
      });
      const result = await mcp.callTool({ name: 'review_run', arguments: { runId: 'r1', decision, ...(decision === 'send_back' ? { notes: 'x' } : {}) } });
      expect(textOf(result)).toBe(`cezar refused: 409: ${reason} — the run is still being resumed or settled; wait_for_runs, then decide again`);
    });

    it('send_back answers once its continuation has started, not with the stale review', async () => {
      // /continue starts the session asynchronously: the record reads review, its step pending, for a moment.
      const states = [
        run('r1', 'review', { steps: [{ id: 'task', status: 'done' }] }),
        run('r1', 'review', { steps: [{ id: 'task', status: 'done' }, { id: 'continue-1', status: 'pending' }] }),
        run('r1', 'review', { steps: [{ id: 'task', status: 'done' }, { id: 'continue-1', status: 'pending' }] }),
        run('r1', 'running', { steps: [{ id: 'task', status: 'done' }, { id: 'continue-1', status: 'running' }] }),
      ];
      let reads = 0;
      const mcp = await connect({
        [`GET ${R}`]: () => ({ body: states[Math.min((reads += 1) - 1, states.length - 1)] }),
        [`POST ${R}/continue`]: { body: { continued: true } },
      });
      const result = await mcp.callTool({ name: 'review_run', arguments: { runId: 'r1', decision: 'send_back', notes: 'x' } });
      expect((result.structuredContent as { status: string }).status).toBe('running');
      expect(reads).toBe(4);
    });

    it('send_back that already re-parked at review says review, without waiting it out', async () => {
      const parked = run('r1', 'review', { steps: [{ id: 'task', status: 'done' }, { id: 'continue-1', status: 'done' }] });
      let reads = 0;
      const mcp = await connect({
        [`GET ${R}`]: () => ({ body: (reads += 1) === 1 ? run('r1', 'review') : parked }),
        [`POST ${R}/continue`]: { body: { continued: true } },
      });
      const result = await mcp.callTool({ name: 'review_run', arguments: { runId: 'r1', decision: 'send_back', notes: 'x' } });
      expect((result.structuredContent as { status: string }).status).toBe('review');
      expect(reads).toBe(2);
    });
  });

  describe('choosing the project', () => {
    const index = (runs: Array<{ id: string; projectId: string }>) => ({
      body: { runs: runs.map((r) => ({ ...r, status: 'review', createdAt: '2026-09-01', archived: false, title: 't', workflow: 'q' })), truncated: [], perProjectLimit: 200, referenceStatuses: {} },
    });
    const projects = { body: { bootProject: 'a', projectsDir: '/', projects: [{ id: 'a', name: 'Repo A', root: '/a', status: 'ok' }, { id: 'b', name: 'b', root: '/b', status: 'ok' }] } };
    const args = { push_run_branch: {}, send_run_message: { text: 'hi' }, review_run: { decision: 'accept' } };

    it.each(Object.entries(args))('%s does not follow a run into another project: it names it', async (name, extra) => {
      const calls: Call[] = [];
      const mcp = await connect({ 'GET /api/v1/workspace/runs-index': index([{ id: 'r1', projectId: 'b' }]), 'GET /api/v1/projects': projects }, { calls });
      const result = await mcp.callTool({ name, arguments: { runId: 'r1', ...extra } });
      expect(textOf(result)).toBe('cezar refused: 404: not found — run r1 belongs to project "b"; pass projectId: "b"');
      expect(posts(calls)).toEqual([]);
    });

    it.each(Object.entries(args))('%s with a run no project places: lists the projects and asks for projectId', async (name, extra) => {
      const mcp = await connect({ 'GET /api/v1/workspace/runs-index': index([]), 'GET /api/v1/projects': projects });
      const result = await mcp.callTool({ name, arguments: { runId: 'r1', ...extra } });
      expect(textOf(result)).toBe(
        'cezar refused: 404: not found — no project of this cockpit has a run r1 — check the id (list_runs); ' +
          'this cockpit serves 2 projects (a (Repo A), b) — pass projectId to say which one holds it',
      );
    });

    it('a named project is used as is', async () => {
      const calls: Call[] = [];
      const mcp = await connect(
        { 'GET /api/v1/p/b/runs/r1': { body: run('r1', 'review') }, 'POST /api/v1/p/b/runs/r1/finish': { body: { finished: true } } },
        { calls },
      );
      const result = await mcp.callTool({ name: 'review_run', arguments: { projectId: 'b', runId: 'r1', decision: 'accept' } });
      expect((result.structuredContent as { projectId: string }).projectId).toBe('b');
      expect(posts(calls)).toEqual(['/api/v1/p/b/runs/r1/finish']);
    });

    it.each(Object.entries(args))('%s refuses when discovery could not rule out another cockpit', async (name, extra) => {
      const calls: Call[] = [];
      const api = createApiClient({ baseUrl: 'http://127.0.0.1:4321', fetch: stubFetch({}, calls) });
      const mcp = await connect({}, { cockpit: async () => ({ api, defaultProjectId: 'default', writeRefused: 'port 4322 did not answer' }) });
      const result = await mcp.callTool({ name, arguments: { runId: 'r1', ...extra } });
      expect(textOf(result)).toBe('port 4322 did not answer');
      expect(calls).toEqual([]);
    });
  });
});

describe('cez mcp tools: wait_for_runs', () => {
  /** A run whose status follows `script`, one entry per poll, sticking at the last. */
  const scripted = (id: string, script: string[], polls: Record<string, number>) => () => {
    const n = polls[id] ?? 0;
    polls[id] = n + 1;
    return { body: run(id, script[Math.min(n, script.length - 1)]!) };
  };

  it('polls at once and returns as soon as one run settles (mode any)', async () => {
    const polls: Record<string, number> = {};
    const mcp = await connect({
      'GET /api/v1/p/default/runs/r1': scripted('r1', ['running', 'running', 'review'], polls),
      'GET /api/v1/p/default/runs/r2': scripted('r2', ['running'], polls),
    });
    const result = await mcp.callTool({ name: 'wait_for_runs', arguments: { runIds: ['r1', 'r2'], timeoutSeconds: 10 } });
    const body = result.structuredContent as { runs: Array<{ id: string; status: string }>; timedOut: boolean };
    expect(body.timedOut).toBe(false);
    expect(body.runs.map((r) => [r.id, r.status])).toEqual([
      ['r1', 'review'],
      ['r2', 'running'],
    ]);
    expect(polls).toEqual({ r1: 3, r2: 3 });
  });

  it('an already-settled run answers on the first poll', async () => {
    const polls: Record<string, number> = {};
    const mcp = await connect({ 'GET /api/v1/p/default/runs/r1': scripted('r1', ['done'], polls) });
    const result = await mcp.callTool({ name: 'wait_for_runs', arguments: { runIds: ['r1'] } });
    expect((result.structuredContent as { timedOut: boolean }).timedOut).toBe(false);
    expect(polls.r1).toBe(1);
  });

  it('mode all waits for every run', async () => {
    const polls: Record<string, number> = {};
    const mcp = await connect({
      'GET /api/v1/p/default/runs/r1': scripted('r1', ['done'], polls),
      'GET /api/v1/p/default/runs/r2': scripted('r2', ['running', 'running', 'running', 'failed'], polls),
    });
    const result = await mcp.callTool({ name: 'wait_for_runs', arguments: { runIds: ['r1', 'r2'], mode: 'all', timeoutSeconds: 10 } });
    const body = result.structuredContent as { runs: Array<{ status: string }>; timedOut: boolean };
    expect(body.runs.map((r) => r.status)).toEqual(['done', 'failed']);
    expect(polls.r2).toBe(4);
  });

  it('gives up at its timeout, says so, and stops polling', async () => {
    const polls: Record<string, number> = {};
    const mcp = await connect({ 'GET /api/v1/p/default/runs/r1': scripted('r1', ['running'], polls) }, { pollIntervalMs: 100 });
    const started = Date.now();
    const result = await mcp.callTool({ name: 'wait_for_runs', arguments: { runIds: ['r1'], timeoutSeconds: 1 } });
    const elapsed = Date.now() - started;
    expect(result.structuredContent).toMatchObject({ runs: [{ id: 'r1', status: 'running' }], timedOut: true });
    expect(elapsed).toBeGreaterThanOrEqual(950);
    expect(elapsed).toBeLessThan(3_000);
    const after = polls.r1;
    await new Promise((r) => setTimeout(r, 300));
    expect(polls.r1).toBe(after);
  });

  it('a cockpit that stalls mid-poll is cut off by the same timeout', async () => {
    const mcp = await connect({
      'GET /api/v1/p/default/runs/r1': (_url, init) =>
        new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))),
    });
    const started = Date.now();
    const result = await mcp.callTool({ name: 'wait_for_runs', arguments: { runIds: ['r1'], timeoutSeconds: 1 } });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(result.structuredContent).toEqual({ runs: [{ id: 'r1', status: 'unknown' }], timedOut: true });
  });

  it("stops polling when the client cancels the call", async () => {
    const polls: Record<string, number> = {};
    const mcp = await connect({ 'GET /api/v1/p/default/runs/r1': scripted('r1', ['running'], polls) }, { pollIntervalMs: 50 });
    const controller = new AbortController();
    const pending = mcp.callTool({ name: 'wait_for_runs', arguments: { runIds: ['r1'], timeoutSeconds: 30 } }, { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 200));
    controller.abort();
    await expect(pending).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 100));
    const after = polls.r1;
    await new Promise((r) => setTimeout(r, 300));
    expect(polls.r1).toBe(after);
  });

  it('reports progress on every poll when the client asks for it', async () => {
    const polls: Record<string, number> = {};
    const mcp = await connect({ 'GET /api/v1/p/default/runs/r1': scripted('r1', ['queued', 'running', 'done'], polls) });
    const progress: Array<{ progress: number; message?: string }> = [];
    await mcp.callTool({ name: 'wait_for_runs', arguments: { runIds: ['r1'] } }, { onprogress: (p) => progress.push(p) });
    expect(progress.map((p) => p.progress)).toEqual([1, 2, 3]);
    expect(progress.map((p) => p.message)).toEqual(['r1: queued', 'r1: running', 'r1: done']);
  });

  it('an unknown run is a tool error, not a wait', async () => {
    const mcp = await connect({});
    const result = await mcp.callTool({ name: 'wait_for_runs', arguments: { runIds: ['nope'] } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^cezar refused: 404: not found — run nope/);
  });

  it('a failed poll ends the polls still in flight', async () => {
    let stalled: AbortSignal | undefined;
    const mcp = await connect({
      'GET /api/v1/p/default/runs/bad': { status: 500, body: { error: 'boom' } },
      'GET /api/v1/p/default/runs/slow': (_url, init) => {
        stalled = init?.signal ?? undefined;
        return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
      },
    });
    const result = await mcp.callTool({ name: 'wait_for_runs', arguments: { runIds: ['slow', 'bad'], timeoutSeconds: 30 } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('cezar refused: 500: boom');
    expect(stalled?.aborted).toBe(true);
  });

  it(`refuses a timeout past the client-safe ceiling of ${WAIT_MAX_SECONDS} s`, async () => {
    const mcp = await connect({});
    const result = await mcp.callTool({ name: 'wait_for_runs', arguments: { runIds: ['r1'], timeoutSeconds: WAIT_MAX_SECONDS + 1 } });
    expect(result.isError).toBe(true);
  });
});
