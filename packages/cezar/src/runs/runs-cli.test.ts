import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { runRunsCommand, type RunsCliIo } from './runs-cli.ts';

/** `cez runs` is a thin read-only client: what is pinned is the URL it builds, the filtering and
 *  the printed rows — never the route, which has its own tests. */
describe('cez runs', () => {
  const env = { CEZ_API_URL: 'http://127.0.0.1:4321/', CEZ_PROJECT_ID: 'proj' };

  const run = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    title: `task ${id}`,
    workflow: 'quick-task',
    task: 'do it',
    status: 'done',
    createdAt: '2026-09-01T10:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...overrides,
  });

  const harness = (reply: { status: number; body: unknown }) => {
    const calls: string[] = [];
    const out: string[] = [];
    const err: string[] = [];
    const io: RunsCliIo = {
      fetch: (async (url: string | URL | Request) => {
        calls.push(String(url));
        return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
      log: (line) => out.push(line),
      error: (line) => err.push(line),
    };
    return { calls, out, err, io };
  };

  const runs = [
    run('aaaaaaaa-1', { createdAt: '2026-09-01T10:00:00.000Z', costUsd: 1.5, branch: 'cez/aaaaaaaa' }),
    run('bbbbbbbb-2', { createdAt: '2026-09-03T10:00:00.000Z', status: 'running', activity: 'monitoring' }),
    run('cccccccc-3', { createdAt: '2026-09-02T10:00:00.000Z', archived: true }),
  ];

  it('list reads the project-scoped runs and prints the unarchived ones newest first', async () => {
    const h = harness({ status: 200, body: runs });
    expect(await runRunsCommand(['list'], env, h.io)).toBe(0);
    expect(h.calls).toEqual(['http://127.0.0.1:4321/api/v1/p/proj/runs']);
    expect(h.out).toEqual([
      'bbbbbbbb  running/monitoring  task bbbbbbbb-2',
      'aaaaaaaa  done  $1.50  task aaaaaaaa-1  [cez/aaaaaaaa]',
    ]);
  });

  it('--all includes archived tasks, --status filters, and the unscoped API is used without a project', async () => {
    const h = harness({ status: 200, body: runs });
    expect(await runRunsCommand(['list', '--all', '--status', 'done'], { CEZ_API_URL: 'http://127.0.0.1:1' }, h.io)).toBe(0);
    expect(h.calls).toEqual(['http://127.0.0.1:1/api/v1/runs']);
    expect(h.out).toEqual([
      'cccccccc  done  task cccccccc-3  (archived)',
      'aaaaaaaa  done  $1.50  task aaaaaaaa-1  [cez/aaaaaaaa]',
    ]);
  });

  it('--json prints the matching records untouched', async () => {
    const h = harness({ status: 200, body: runs });
    expect(await runRunsCommand(['list', '--json', '--status', 'running'], env, h.io)).toBe(0);
    expect(JSON.parse(h.out[0]!)).toEqual([runs[1]]);
  });

  it('refuses an unknown status before calling the cockpit', async () => {
    const h = harness({ status: 200, body: runs });
    expect(await runRunsCommand(['list', '--status', 'finished'], env, h.io)).toBe(1);
    expect(h.err[0]).toContain('--status wants queued, running, waiting, review, done, failed, cancelled, not "finished"');
    expect(h.calls).toHaveLength(0);
  });

  it('relays a server error with a non-zero exit', async () => {
    const h = harness({ status: 404, body: { error: 'unknown project: proj' } });
    expect(await runRunsCommand(['list'], env, h.io)).toBe(1);
    expect(h.err[0]).toBe('cez runs: could not list runs — unknown project: proj');
  });

  it('says so when nothing matches', async () => {
    const empty = harness({ status: 200, body: [] });
    await runRunsCommand(['list'], env, empty.io);
    expect(empty.out).toEqual(['no tasks']);
    const none = harness({ status: 200, body: runs });
    await runRunsCommand(['list', '--status', 'failed'], env, none.io);
    expect(none.out).toEqual(['no tasks match']);
  });

  it('without an address it explains how to set one and never guesses a cockpit', async () => {
    const h = harness({ status: 200, body: runs });
    expect(await runRunsCommand(['list'], {}, h.io)).toBe(2);
    expect(h.err[0]).toContain('CEZ_API_URL=http://127.0.0.1:4321 cez runs list');
    expect(h.calls).toHaveLength(0);
  });

  it('prints usage for help and refuses an unknown command', async () => {
    const help = harness({ status: 200, body: [] });
    expect(await runRunsCommand(['--help'], env, help.io)).toBe(0);
    expect(help.out[0]).toContain('cez runs list');
    const unknown = harness({ status: 200, body: [] });
    expect(await runRunsCommand(['cancel', 'x'], env, unknown.io)).toBe(2);
    expect(unknown.err[0]).toContain('unknown command "cancel"');
    expect(unknown.calls).toHaveLength(0);
  });

  it('prints the agent-updated titleSummary instead of the prompt-derived title', async () => {
    const h = harness({ status: 200, body: [run('aaaaaaaa-1', { titleSummary: 'shorter title' })] });
    expect(await runRunsCommand(['list'], env, h.io)).toBe(0);
    expect(h.out).toEqual(['aaaaaaaa  done  shorter title']);
  });

  it('--json keeps titleSummary on the untouched record', async () => {
    const record = run('aaaaaaaa-1', { titleSummary: 'shorter title' });
    const h = harness({ status: 200, body: [record] });
    expect(await runRunsCommand(['list', '--json'], env, h.io)).toBe(0);
    expect(JSON.parse(h.out[0]!)).toEqual([record]);
  });

  it('lists a run whose status this CLI does not recognize instead of dropping it', async () => {
    const h = harness({ status: 200, body: [run('aaaaaaaa-1', { status: 'blocked-by-approval' })] });
    expect(await runRunsCommand(['list'], env, h.io)).toBe(0);
    expect(h.out).toEqual(['aaaaaaaa  blocked-by-approval  task aaaaaaaa-1']);
  });

  it('reports and skips genuinely malformed records (mixed validity), keeping the exit code 0', async () => {
    const good = run('aaaaaaaa-1');
    const malformed = { title: 'no id', status: 'done', createdAt: '2026-09-01T10:00:00.000Z', archived: false };
    const h = harness({ status: 200, body: [good, malformed] });
    expect(await runRunsCommand(['list'], env, h.io)).toBe(0);
    expect(h.err).toEqual(['cez runs: ignored 1 record the cockpit sent in a shape this CLI does not recognize']);
    expect(h.out).toEqual(['aaaaaaaa  done  task aaaaaaaa-1']);
  });

  it('reports and fails when every record is malformed instead of claiming there are no tasks', async () => {
    const malformed = [{ title: 'no id' }, { title: 'also no id' }];
    const h = harness({ status: 200, body: malformed });
    expect(await runRunsCommand(['list'], env, h.io)).toBe(1);
    expect(h.err).toEqual(['cez runs: ignored 2 records the cockpit sent in a shape this CLI does not recognize']);
    expect(h.out).toHaveLength(0);

    const jsonH = harness({ status: 200, body: malformed });
    expect(await runRunsCommand(['list', '--json'], env, jsonH.io)).toBe(1);
    expect(JSON.parse(jsonH.out[0]!)).toEqual([]);
  });
});

/** The request has a bounded deadline that covers reading the body, not only the connect/headers
 *  phase — a cockpit that stalls after answering with a 200 must not hang `cez runs list` forever
 *  (#1133 review). A real loopback server, not a hand-rolled fetch mock: the point under test is
 *  the interaction between `AbortSignal.timeout` and the platform `fetch`, which a mock would have
 *  to reimplement to be worth anything. */
describe('cez runs — request timeout', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (s) =>
          new Promise<void>((resolve) => {
            s.closeAllConnections();
            s.close(() => resolve());
          }),
      ),
    );
  });

  async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  const io = (out: string[], err: string[]): RunsCliIo => ({
    fetch,
    log: (line) => out.push(line),
    error: (line) => err.push(line),
    timeoutMs: 50,
  });

  it('times out and exits 1 when the cockpit never sends headers', async () => {
    const base = await serve(() => {
      // never writes a response — the connection just sits open
    });
    const out: string[] = [];
    const err: string[] = [];
    const code = await runRunsCommand(['list'], { CEZ_API_URL: base }, io(out, err));
    expect(code).toBe(1);
    expect(err).toEqual(['cez runs: the cockpit did not answer within 50ms']);
  });

  it('times out and exits 1 when the cockpit answers but never finishes the body', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('[');
      // never calls res.end() — the body stream stalls after the headers land
    });
    const out: string[] = [];
    const err: string[] = [];
    const code = await runRunsCommand(['list'], { CEZ_API_URL: base }, io(out, err));
    expect(code).toBe(1);
    expect(err).toEqual(['cez runs: the cockpit did not answer within 50ms']);
  });
});
