import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { connect as connectClient, connectStreams, type TestClient } from './client.testkit.ts';
import type { McpServer } from './jsonrpc.ts';
import { longDeadline, type CezarFetch as CezarFetchLike } from './api.ts';
import type { RuntimeInspection } from '../runtime/cockpit-runtime.ts';
import {
  createCockpitResolver,
  findCockpitUrl,
  inspectLocalCockpits,
  parseHeader,
  runMcpCommand,
  serveOnStdio,
  type McpCliIo,
} from './mcp-cli.ts';

/** `cez mcp` flags, cockpit discovery and the stdio transport (#1109). The tool set has its own
 *  tests (`tools.test.ts`, `tools.routes.test.ts`). */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const health = (repoRoot = 'x') => json({ version: '0.15.0', capabilities: {}, repoRoot });

type Project = { id: string; root: string; name?: string; status?: string };

/**
 * A fetch answering like cockpits on the given ports. Like real cockpits on one machine they share
 * ONE project registry (`~/.cezar`); what differs is the project each was booted in. A port may
 * instead carry its own registry, as a cockpit with its own `CEZ_HOME` does.
 */
function cockpits(
  shared: Project[],
  bootByPort: Record<number, string | { boot: string; registry: Project[] }>,
  probed: string[] = [],
) {
  return async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    probed.push(url.href);
    const entry = bootByPort[Number(url.port)];
    if (entry === undefined) throw new TypeError('fetch failed');
    const { boot, registry } = typeof entry === 'string' ? { boot: entry, registry: shared } : entry;
    if (url.pathname === '/api/v1/health') return health();
    if (url.pathname === '/api/v1/projects') return json({ bootProject: boot, projectsDir: '/', projects: registry });
    return json({ error: 'not found' }, 404);
  };
}

const REGISTRY: Project[] = [
  { id: 'other', root: '/work/other' },
  { id: 'mono', root: '/work/mono' },
  { id: 'pkg', root: '/work/mono/packages/pkg' },
];

/** Runtime records as `inspectLocalCockpits` reads them: a verified cockpit on `port`, or none. */
const runtimeAt = (port?: number | (() => number | undefined)) => async (): Promise<RuntimeInspection[]> => {
  const at = typeof port === 'function' ? port() : port;
  return at === undefined
    ? [{ kind: 'absent' }]
    : [{ kind: 'verified', runtime: { origin: `http://127.0.0.1:${at}` } as Extract<RuntimeInspection, { kind: 'verified' }>['runtime'] }];
};

describe('cockpit discovery', () => {
  it('takes the cockpit its runtime record names, without probing 4321', async () => {
    const probed: string[] = [];
    expect(await findCockpitUrl(cockpits([], { 4330: 'a' }, probed), runtimeAt(4330))).toBe('http://127.0.0.1:4330');
    expect(probed).toEqual([]);
  });

  it('without a record, looks once at the default address (a cockpit too old to publish one)', async () => {
    const probed: string[] = [];
    expect(await findCockpitUrl(cockpits([], { 4321: 'a' }, probed), runtimeAt())).toBe('http://127.0.0.1:4321');
    expect(probed).toEqual(['http://127.0.0.1:4321/api/v1/health']);
    // a dead owner's record is ignored the same way
    expect(await findCockpitUrl(cockpits([], { 4321: 'a' }), async () => [{ kind: 'dead' }])).toBe('http://127.0.0.1:4321');
  });

  it('never scans past the default port', async () => {
    const probed: string[] = [];
    await expect(findCockpitUrl(cockpits([], { 4322: 'a' }, probed), runtimeAt())).rejects.toThrow(/no running cezar cockpit found/);
    expect(probed).toEqual(['http://127.0.0.1:4321/api/v1/health']);
  });

  it('a port that answers but is not a cockpit is not one', async () => {
    const notCockpit: CezarFetchLike = async () => json({ hello: 'world' });
    await expect(findCockpitUrl(notCockpit, runtimeAt())).rejects.toThrow(/no running cezar cockpit found/);
  });

  it('a live owner that cannot be verified is an error, not a guess at 4321', async () => {
    const probed: string[] = [];
    const stuck = async (): Promise<RuntimeInspection[]> => [{ kind: 'unavailable', reason: 'health answered 503' }];
    await expect(findCockpitUrl(cockpits([], { 4321: 'a' }, probed), stuck)).rejects.toThrow(/running but could not be verified \(health answered 503\).*--url/);
    expect(probed).toEqual([]);
  });

  it('with nothing running, says how to fix it', async () => {
    await expect(findCockpitUrl(cockpits([], {}), runtimeAt())).rejects.toThrow(/npx cezar-run[\s\S]*CEZ_API_URL=http:\/\/127\.0\.0\.1:4321 cez mcp --read-only/);
  });

  it('reads the interactive slot of this CEZ_HOME', async () => {
    expect(await inspectLocalCockpits()).toEqual([{ kind: 'absent' }]);
  });
});

describe('cockpit resolver', () => {
  it('discovers again after a connection error — a cockpit restarted on another port is found', async () => {
    const ports: Record<number, string> = { 4321: 'p' };
    const requested: string[] = [];
    let port = 4321;
    const resolve = createCockpitResolver({ fetch: cockpits([{ id: 'p', root: '/r' }], ports, requested), cwd: '/r', inspect: runtimeAt(() => port) });
    const first = await resolve();
    expect(first.defaultProjectId).toBe('p');
    expect(await resolve()).toBe(first);
    expect((await first.api.api.v1.projects.$get()).status).toBe(200);

    delete ports[4321];
    ports[4340] = 'p';
    port = 4340;
    await expect(first.api.api.v1.projects.$get()).rejects.toThrow('fetch failed');
    const second = await resolve();
    expect(second).not.toBe(first);
    expect((await second.api.api.v1.projects.$get()).status).toBe(200);
    expect(requested.at(-1)).toBe('http://127.0.0.1:4340/api/v1/projects');
  });

  it('two concurrent first calls share one discovery', async () => {
    const probed: string[] = [];
    let inspected = 0;
    const inspect = async () => ((inspected += 1), runtimeAt(4321)());
    const resolve = createCockpitResolver({ fetch: cockpits([{ id: 'p', root: '/r' }], { 4321: 'p' }, probed), cwd: '/r', inspect });
    const [a, b] = await Promise.all([resolve(), resolve()]);
    expect(a).toBe(b);
    expect(inspected).toBe(1);
    expect(probed.filter((u) => u === 'http://127.0.0.1:4321/api/v1/projects')).toHaveLength(1);
  });

  it('a failed discovery is not kept: the next call tries again', async () => {
    const ports: Record<number, string> = {};
    const resolve = createCockpitResolver({ fetch: cockpits([{ id: 'p', root: '/r' }], ports), cwd: '/r', inspect: runtimeAt() });
    await expect(resolve()).rejects.toThrow(/no running cezar cockpit found/);
    ports[4321] = 'p';
    expect((await resolve()).defaultProjectId).toBe('p');
  });

  it('an explicit URL is never probed for, and still serves the project holding the cwd', async () => {
    const probed: string[] = [];
    const fetchImpl = cockpits(REGISTRY, { 4999: 'other' }, probed);
    const resolve = createCockpitResolver({ fetch: fetchImpl, cwd: '/work/mono/packages/pkg', explicitUrl: 'http://127.0.0.1:4999' });
    expect((await resolve()).defaultProjectId).toBe('pkg');
    expect(probed).toEqual(['http://127.0.0.1:4999/api/v1/projects']);
    // no project holds the cwd: reads use the boot project, by its id
    const outside = createCockpitResolver({ fetch: fetchImpl, cwd: '/tmp/elsewhere', explicitUrl: 'http://127.0.0.1:4999' });
    expect(await outside()).toMatchObject({ defaultProjectId: 'other' });
  });

  it('no project holds the cwd: start_task must be told which, unless the cockpit serves one project', async () => {
    // QA of #1109: `--url` from another machine sent every start_task to the boot project.
    const named = REGISTRY.map((p) => ({ ...p, name: p.id === 'mono' ? 'Mono Repo' : p.id }));
    const outside = createCockpitResolver({ fetch: cockpits(named, { 4999: 'other' }), cwd: '/Users/me/code', explicitUrl: 'http://127.0.0.1:4999' });
    const many = await outside();
    expect(many.defaultProjectId).toBe('other');
    expect(many.projectUnknown).toBe(
      'no project of http://127.0.0.1:4999 holds /Users/me/code, and it serves 3 projects (other, mono (Mono Repo), pkg) — pass projectId to say which one the task belongs to, or start cez mcp with --project <id> (or CEZ_PROJECT_ID)',
    );
    // so does a discovered cockpit
    const discovered = createCockpitResolver({ fetch: cockpits(named, { 4321: 'other' }), cwd: '/Users/me/code', inspect: runtimeAt(4321) });
    expect((await discovered()).projectUnknown).toMatch(/^no project of http:\/\/127\.0\.0\.1:4321 holds/);
    // one project, the one it booted in: nothing to choose
    const single = createCockpitResolver({ fetch: cockpits([{ id: 'a', root: '/srv/a' }], { 4999: 'a' }), cwd: '/Users/me', explicitUrl: 'http://127.0.0.1:4999' });
    expect(await single()).toMatchObject({ defaultProjectId: 'a' });
    expect((await single()).projectUnknown).toBeUndefined();
    // --project / CEZ_PROJECT_ID says which
    const told = createCockpitResolver({ fetch: cockpits(named, { 4999: 'other' }), cwd: '/Users/me', explicitUrl: 'http://127.0.0.1:4999', projectId: 'pkg' });
    expect(await told()).toMatchObject({ defaultProjectId: 'pkg' });
    expect((await told()).projectUnknown).toBeUndefined();
  });

  it('an unreadable registry: reads use the boot project, start_task must be told which', async () => {
    const base = cockpits(REGISTRY, { 4999: 'other' });
    const resolve = createCockpitResolver({
      fetch: async (input) => (String(input).endsWith('/api/v1/projects') ? json({ error: 'busy' }, 503) : base(input)),
      cwd: '/work/mono',
      explicitUrl: 'http://127.0.0.1:4999',
    });
    const cockpit = await resolve();
    expect(cockpit.defaultProjectId).toBe('default');
    expect(cockpit.projectUnknown).toMatch(/^could not read the project list of http:\/\/127\.0\.0\.1:4999, so which project holds \/work\/mono is unknown — pass projectId/);
  });

  it('--project wins over the cwd, without asking the registry', async () => {
    const probed: string[] = [];
    const resolve = createCockpitResolver({
      fetch: cockpits(REGISTRY, { 4999: 'other' }, probed),
      cwd: '/work/mono',
      explicitUrl: 'http://127.0.0.1:4999',
      projectId: 'mine',
    });
    expect((await resolve()).defaultProjectId).toBe('mine');
    expect(probed).toEqual([]);
  });

  it('a request keeps its deadline when the caller passes a signal of its own', async () => {
    const stall: CezarFetchLike = (_input, init) =>
      new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
    const resolve = createCockpitResolver({ fetch: stall, cwd: '/', explicitUrl: 'http://127.0.0.1:4999', projectId: 'p', requestTimeoutMs: 100 });
    const { api } = await resolve();
    const never = new AbortController();
    const started = Date.now();
    await expect(api.api.v1.projects.$get(undefined, { init: { signal: never.signal } })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('a longDeadline signal is not shortened by the default deadline', async () => {
    const seen: AbortSignal[] = [];
    const resolve = createCockpitResolver({
      fetch: async (_input, init) => {
        seen.push(init!.signal!);
        return json({});
      },
      cwd: '/',
      explicitUrl: 'http://127.0.0.1:4999',
      projectId: 'p',
    });
    const { api } = await resolve();
    const long = longDeadline(30_000);
    await api.api.v1.projects.$get(undefined, { init: { signal: long } });
    expect(seen[0]).toBe(long);
  });

  it('inside a cezar task without CEZ_API_URL, it does not look: the cockpit withheld the address', async () => {
    const probed: string[] = [];
    let inspected = false;
    const inspect = async () => ((inspected = true), runtimeAt(4321)());
    const resolve = createCockpitResolver({ fetch: cockpits([], { 4321: 'x' }, probed), cwd: '/', insideTask: true, inspect });
    await expect(resolve()).rejects.toThrow(/^cez mcp: CEZ_API_URL is not set — the cockpit withheld its address/);
    expect(probed).toEqual([]);
    expect(inspected).toBe(false);
  });
});

describe('cez mcp flags', () => {
  const io = (overrides: Partial<McpCliIo> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const factories: McpServer[] = [];
    const harness: McpCliIo = {
      fetch: async () => json({}),
      log: (l) => out.push(l),
      error: (l) => err.push(l),
      cwd: '/',
      serve: async (server) => {
        factories.push(server);
      },
      ...overrides,
    };
    return { harness, out, err, factories };
  };

  it('parses --header as "Name: value" and refuses anything else', () => {
    expect(parseHeader('Authorization: Basic abc:def')).toEqual(['Authorization', 'Basic abc:def']);
    expect(() => parseHeader('nocolon')).toThrow(/Name: value/);
    expect(() => parseHeader(' : x')).toThrow(/Name: value/);
    expect(() => parseHeader('Bad Name: x')).toThrow(/Name: value/);
  });

  it('--help prints usage and does not start the server', async () => {
    const h = io();
    expect(await runMcpCommand(['--help'], {}, h.harness)).toBe(0);
    expect(h.out[0]).toContain('cez mcp');
    expect(h.out[0]).toContain('npx -y cezar-run mcp');
    expect(h.factories).toHaveLength(0);
  });

  it.each([[['--nope']], [['--header', 'bad']], [['--header', ' : x']], [['--url', 'ftp://x']], [['--url', '']], [['--url', ' ']]])('%j exits 2 without serving', async (args) => {
    const h = io();
    expect(await runMcpCommand(args, {}, h.harness)).toBe(2);
    expect(h.factories).toHaveLength(0);
  });

  it('serves without contacting any cockpit: discovery waits for the first tool call', async () => {
    const calls: string[] = [];
    const h = io({
      fetch: async (input) => {
        calls.push(String(input));
        return json({});
      },
    });
    expect(await runMcpCommand([], { CEZ_API_URL: 'http://127.0.0.1:4999/' }, h.harness)).toBe(0);
    expect(h.factories).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  it('--read-only reaches the server: no write tools', async () => {
    const h = io();
    await runMcpCommand(['--read-only'], {}, h.harness);
    const client = await connectClient(h.factories[0]!);
    const names = (await client.listTools()).tools.map((t) => t.name);
    await client.close();
    expect(names).not.toContain('start_task');
    for (const name of ['start_task', 'cancel_task', 'push_task_branch', 'send_task_message', 'review_task']) expect(names).not.toContain(name);
    expect(names).toContain('wait_for_tasks');
  });

  it('inside a cezar task it is read-only whatever the flags, and points at cez task create', async () => {
    // A task's agent must not start tasks past dispatch's brakes (four children, the budget).
    const h = io();
    await runMcpCommand([], { CEZ_TASK_ID: 'abc', CEZ_API_URL: 'http://127.0.0.1:4999' }, h.harness);
    const client = await connectClient(h.factories[0]!);
    const names = (await client.listTools()).tools.map((t) => t.name);
    await client.close();
    for (const name of ['start_task', 'cancel_task', 'push_task_branch', 'send_task_message', 'review_task']) expect(names).not.toContain(name);
    expect(names).toContain('wait_for_tasks');
    expect(h.factories[0]!.instructions).toMatch(/cez task create/);
  });

  it('--url from another machine: start_task without projectId lists the projects instead of using the boot one', async () => {
    const writes: string[] = [];
    const base = cockpits(
      [
        { id: 'code', root: '/srv/code', name: 'code', status: 'ok' },
        { id: 'shop', root: '/srv/shop', name: 'Shop', status: 'ok' },
      ],
      { 4321: 'code' },
    );
    const fetchImpl: CezarFetchLike = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = input instanceof Request ? input.method : (init?.method ?? 'GET');
      if (method !== 'GET') {
        writes.push(`${method} ${url.pathname}`);
        return json({ id: 'r1', title: 't', workflow: 'quick-task', status: 'queued', createdAt: '2026-10-14T00:00:00Z' }, 201);
      }
      return base(input);
    };
    const session = async (args: string[], env = {}) => {
      const h = io({ cwd: '/Users/me/code', fetch: fetchImpl });
      await runMcpCommand(['--url', 'http://127.0.0.1:4321', ...args], env, h.harness);
      return connectClient(h.factories[0]!);
    };
    const text = (r: Awaited<ReturnType<TestClient['callTool']>>) => (r.content as Array<{ text: string }>)[0]!.text;

    const plain = await session([]);
    const refused = await plain.callTool({ name: 'start_task', arguments: { workflow: 'quick-task', task: 'x' } });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/serves 2 projects \(code, shop \(Shop\)\) — pass projectId/);
    expect(writes).toEqual([]);
    // reads are unchanged: the boot project
    expect((await plain.callTool({ name: 'list_projects', arguments: {} })).isError).toBeFalsy();
    const chosen = await plain.callTool({ name: 'start_task', arguments: { workflow: 'quick-task', task: 'x', projectId: 'shop' } });
    expect(chosen.isError, text(chosen)).toBeFalsy();
    await plain.close();

    for (const [args, env] of [[['--project', 'shop'], {}], [[], { CEZ_PROJECT_ID: 'shop' }]] as const) {
      const client = await session([...args], env);
      const started = await client.callTool({ name: 'start_task', arguments: { workflow: 'quick-task', task: 'x' } });
      expect(started.isError, text(started)).toBeFalsy();
      await client.close();
    }
    expect(writes).toEqual(['POST /api/v1/p/shop/runs', 'POST /api/v1/p/shop/runs', 'POST /api/v1/p/shop/runs']);
  });
});

describe('cez mcp over stdio', () => {
  const open: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((close) => close()));
  });

  /** Runs the real `runMcpCommand` + `serveOnStdio` over in-memory pipes. */
  async function start(args: string[] = []) {
    const toServer = new PassThrough();
    const fromServer = new PassThrough();
    let closed = 0;
    const stdout: string[] = [];
    fromServer.on('data', (chunk: Buffer) => stdout.push(chunk.toString('utf8')));
    await runMcpCommand(args, { CEZ_API_URL: 'http://127.0.0.1:9' }, {
      fetch: async () => {
        throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:9') });
      },
      log: () => {},
      error: () => {},
      cwd: '/',
      serve: (server) => serveOnStdio(server, { stdin: toServer, stdout: fromServer, onClose: () => (closed += 1) }),
    });
    return { toServer, fromServer, stdout, closed: () => closed };
  }

  it('serves the 2025 initialize handshake over newline-delimited stdio', async () => {
    const pipes = await start();
    const client = connectStreams(pipes.fromServer, pipes.toServer);
    open.push(() => client.close());
    const init = await client.initialize('2025-06-18');
    expect(init).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'cezar' }, capabilities: { tools: {} } });
    expect(init.instructions).toMatch(/list_projects/);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('start_task');
    // no cockpit behind it: still a tool answer, not a broken server
    const result = await client.callTool({ name: 'list_projects', arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]?.text).toBe('cannot reach the cezar cockpit (connect ECONNREFUSED 127.0.0.1:9)');
    // stdout carried nothing but JSON-RPC
    for (const line of pipes.stdout.join('').split('\n').filter(Boolean)) expect(JSON.parse(line)).toHaveProperty('jsonrpc', '2.0');
  });

  it('leaves when the client closes stdin', async () => {
    const pipes = await start();
    pipes.toServer.end();
    await new Promise((r) => setTimeout(r, 50));
    expect(pipes.closed()).toBe(1);
  });
});
