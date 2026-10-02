import { describe, expect, it } from 'vitest';
import { runTaskCommand, type TaskCliIo } from './task-cli.ts';

/** The `cez task` CLI is a thin client: what is pinned is the request it builds from flags and
 *  env, and how it answers a refusal — never the engine, which has its own tests. */
describe('cez task', () => {
  const env = { CEZ_API_URL: 'http://127.0.0.1:4321/', CEZ_PROJECT_ID: 'proj', CEZ_TASK_ID: 'run-1' };

  const harness = (reply: { status: number; body: unknown }) => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const out: string[] = [];
    const err: string[] = [];
    const io: TaskCliIo = {
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
      log: (line) => out.push(line),
      error: (line) => err.push(line),
    };
    return { calls, out, err, io };
  };

  it('create posts the task order to the parent’s dispatch route, scoped to the project', async () => {
    const h = harness({ status: 201, body: { id: 'child-1', branch: 'cez/child1' } });
    const code = await runTaskCommand(
      ['create', 'Review the login flow', '--title', 'Review login', '--kind', 'review', '--review-of', 'cez/abc', '--budget', '2.5', '--tools', 'Read,Bash', '--scope', 'src/auth/**'],
      env,
      h.io,
    );
    expect(code).toBe(0);
    expect(h.calls[0]?.url).toBe('http://127.0.0.1:4321/api/v1/p/proj/runs/run-1/dispatch');
    expect(JSON.parse(String(h.calls[0]?.init?.body))).toEqual({
      objective: 'Review the login flow',
      title: 'Review login',
      kind: 'review',
      review_of: ['cez/abc'],
      scope: 'src/auth/**',
      max_cost: 2.5,
      allowed_tools: ['Read', 'Bash'],
    });
    expect(h.out[0]).toContain('dispatched child-1 on branch cez/child1');
  });

  it('create surfaces a refusal with the server’s reason and a non-zero exit', async () => {
    const h = harness({ status: 409, body: { error: 'no budget left' } });
    expect(await runTaskCommand(['create', 'x'], env, h.io)).toBe(1);
    expect(h.err[0]).toContain('dispatch refused — no budget left');
  });

  it('report posts the report with array defaults filled and the verdict', async () => {
    const h = harness({ status: 200, body: { ok: true } });
    const code = await runTaskCommand(
      ['report', '--status', 'done', '--result', 'all green', '--evidence', 'npm test → 3 passed', '--evidence', 'src/a.ts:1', '--verdict', 'approve', '--suggestions', 'split billing'],
      env,
      h.io,
    );
    expect(code).toBe(0);
    expect(h.calls[0]?.url).toBe('http://127.0.0.1:4321/api/v1/p/proj/runs/run-1/report');
    expect(JSON.parse(String(h.calls[0]?.init?.body))).toEqual({
      status: 'done',
      result: 'all green',
      evidence: ['npm test → 3 passed', 'src/a.ts:1'],
      side_effects: [],
      errors: [],
      suggestions: ['split billing'],
      verdict: 'approve',
    });
  });

  it('falls back to the unscoped API without a project id, and refuses without a server', async () => {
    const h = harness({ status: 200, body: { ok: true } });
    await runTaskCommand(['report', '--status', 'done', '--result', 'r'], { CEZ_API_URL: 'http://127.0.0.1:1', CEZ_TASK_ID: 'r1' }, h.io);
    expect(h.calls[0]?.url).toBe('http://127.0.0.1:1/api/v1/runs/r1/report');
    const none = harness({ status: 200, body: {} });
    expect(await runTaskCommand(['create', 'x'], {}, none.io)).toBe(2);
    expect(none.err[0]).toContain('CEZ_API_URL is not set');
    expect(none.calls).toHaveLength(0);
  });

  it('answers --help on a subcommand instead of refusing it as an unknown option', async () => {
    const h = harness({ status: 200, body: {} });
    expect(await runTaskCommand(['create', '--help'], env, h.io)).toBe(0);
    expect(h.out[0]).toContain('cez task create');
    expect(h.calls).toHaveLength(0);
  });

  describe('land-check', () => {
    /** A harness whose replies are a SEQUENCE: the POST, then however many polls the case needs. */
    const sequence = (replies: Array<{ status: number; body: unknown }>) => {
      const calls: Array<{ url: string; init?: RequestInit }> = [];
      const out: string[] = [];
      const err: string[] = [];
      let index = 0;
      let slept = 0;
      const io: TaskCliIo = {
        fetch: (async (url: string | URL | Request, init?: RequestInit) => {
          calls.push({ url: String(url), init });
          const reply = replies[Math.min(index, replies.length - 1)] ?? { status: 200, body: {} };
          index += 1;
          return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
        }) as typeof fetch,
        log: (line) => out.push(line),
        error: (line) => err.push(line),
        sleep: async () => {
          slept += 1;
        },
      };
      return { calls, out, err, io, slept: () => slept };
    };

    it('posts the flags for the calling task and prints the check run with its cockpit page', async () => {
      const h = sequence([{ status: 201, body: { runId: 'check-1', ofRunId: 'run-1' } }]);
      const code = await runTaskCommand(
        ['land-check', '--sources', 'cez/a, cez/b', '--commands', 'npm run typecheck', '--commands', 'npm test\nnpm run build'],
        env,
        h.io,
      );
      expect(code).toBe(0);
      expect(h.calls[0]?.url).toBe('http://127.0.0.1:4321/api/v1/p/proj/runs/run-1/land-check');
      // Comma-splitting is for SOURCES only (a ref never contains one); a command may, so each
      // `--commands` value is one command and a multi-line value is several.
      expect(JSON.parse(String(h.calls[0]?.init?.body))).toEqual({
        sources: ['cez/a', 'cez/b'],
        commands: ['npm run typecheck', 'npm test', 'npm run build'],
      });
      expect(h.out[0]).toContain('landing check check-1 started for run-1');
      expect(h.out[0]).toContain('http://127.0.0.1:4321/p/proj/tasks/check-1');
    });

    it('takes an explicit run id positionally and sends an empty request when nothing is named', async () => {
      const h = sequence([{ status: 201, body: { runId: 'check-2', ofRunId: 'other-run' } }]);
      expect(await runTaskCommand(['land-check', 'other-run'], env, h.io)).toBe(0);
      expect(h.calls[0]?.url).toBe('http://127.0.0.1:4321/api/v1/p/proj/runs/other-run/land-check');
      expect(JSON.parse(String(h.calls[0]?.init?.body))).toEqual({});
    });

    it('--wait follows the check run to its verdict: exit 0 only for passed', async () => {
      const green = sequence([
        { status: 201, body: { runId: 'check-1', ofRunId: 'run-1' } },
        { status: 200, body: { status: 'running', landingCheck: {} } },
        { status: 200, body: { status: 'done', landingCheck: { verdict: 'passed' } } },
      ]);
      expect(await runTaskCommand(['land-check', '--wait'], env, green.io)).toBe(0);
      expect(green.calls[1]?.url).toBe('http://127.0.0.1:4321/api/v1/p/proj/runs/check-1');
      expect(green.out.at(-1)).toContain('landing check verdict — passed');
      expect(green.slept()).toBe(1);

      // A check that could not run is not a check that passed — every other verdict exits 1.
      const red = sequence([
        { status: 201, body: { runId: 'check-1', ofRunId: 'run-1' } },
        { status: 200, body: { status: 'failed', landingCheck: { verdict: 'conflict', reason: 'merge-conflict' } } },
      ]);
      expect(await runTaskCommand(['land-check', '--wait'], env, red.io)).toBe(1);
      expect(red.out.at(-1)).toContain('conflict (merge-conflict)');
    });

    it('surfaces a refusal and refuses to run without a cockpit, like every other verb', async () => {
      const refused = sequence([{ status: 409, body: { error: 'a landing check is already in flight' } }]);
      expect(await runTaskCommand(['land-check'], env, refused.io)).toBe(1);
      expect(refused.err[0]).toContain('landing check refused — a landing check is already in flight');

      const none = sequence([]);
      expect(await runTaskCommand(['land-check'], {}, none.io)).toBe(2);
      expect(none.err[0]).toContain('CEZ_API_URL is not set');
      expect(none.calls).toHaveLength(0);
    });
  });

  it('list prints the tree this task belongs to, indented, with status, cost and verdicts', async () => {
    const h = harness({
      status: 200,
      body: [
        { id: 'root-0000', title: 'Root', status: 'running', costUsd: 1.5, dispatch: { rootRunId: 'root-0000' } },
        { id: 'run-1', title: 'Me', status: 'running', costUsd: 0.2, branch: 'cez/run1', dispatch: { rootRunId: 'root-0000', parentRunId: 'root-0000' } },
        { id: 'kid-0000', title: 'Kid', status: 'done', costUsd: 0.1, dispatch: { rootRunId: 'root-0000', parentRunId: 'run-1', kind: 'review', report: { status: 'done', verdict: 'approve' } } },
        { id: 'other', title: 'Unrelated', status: 'done' },
      ],
    });
    expect(await runTaskCommand(['list'], env, h.io)).toBe(0);
    expect(h.out).toEqual([
      'root-000  running $1.50  Root',
      '  run-1  running $0.20  Me  [cez/run1]',
      '    kid-0000  done $0.10  Kid → done (approve)',
    ]);
  });
});
