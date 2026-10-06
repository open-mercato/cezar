import { describe, expect, it } from 'vitest';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import { runTaskCommand, type TaskCliIo } from './task-cli.ts';

function containsRunnerToken(text: string, runner: string): boolean {
  return new RegExp(`(?:^|[^A-Za-z0-9_-])${runner}(?=$|[^A-Za-z0-9_-])`).test(text);
}

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

  it('advertises every supported runner in help as a standalone token', async () => {
    const h = harness({ status: 200, body: {} });
    expect(await runTaskCommand(['help'], {}, h.io)).toBe(0);
    for (const runner of RUNNER_IDS) expect(containsRunnerToken(h.out[0] ?? '', runner)).toBe(true);
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

  // ---- cross-task waits (spec 2026-10-05-cross-task-waits) ----------------------------------

  it('wait posts the target to this task’s waits route, as this task’s agent', async () => {
    const edge = { id: 'w1', target: { projectId: 'api', runId: 'abcdef1234' }, targetTitle: 'Add export', origin: 'agent', deadline: '2026-10-06T10:00:00.000Z', state: 'pending', createdAt: 'x' };
    const h = harness({ status: 200, body: { kind: 'pending', edge } });
    expect(await runTaskCommand(['wait', 'api/abcdef12', '--timeout', '90'], env, h.io)).toBe(0);
    expect(h.calls[0]?.url).toBe('http://127.0.0.1:4321/api/v1/p/proj/runs/run-1/waits');
    expect(new Headers(h.calls[0]?.init?.headers).get('x-cez-task-id')).toBe('run-1');
    expect(JSON.parse(String(h.calls[0]?.init?.body))).toEqual({ target: { projectId: 'api', runId: 'abcdef12' }, timeoutMinutes: 90 });
    expect(h.out.join('\n')).toContain('waiting for "Add export" (api/abcdef12)');
    expect(h.out.join('\n')).toContain('End your turn now');
  });

  it('wait with a bare id means this project, and prints an already-settled outcome', async () => {
    const h = harness({ status: 200, body: { kind: 'settled', outcome: { target: { projectId: 'proj', runId: 'abcdef1234' }, title: 'Done thing', status: 'review', prUrl: 'https://github.com/o/r/pull/9', costUsd: 0.5 } } });
    expect(await runTaskCommand(['wait', 'abcdef12'], env, h.io)).toBe(0);
    expect(JSON.parse(String(h.calls[0]?.init?.body))).toEqual({ target: { runId: 'abcdef12' } });
    expect(h.out[0]).toContain('has already settled — review');
    expect(h.out.join('\n')).toContain('https://github.com/o/r/pull/9');
  });

  it('wait exits 2 with a do-not-poll message when waits are off, 1 on any other refusal', async () => {
    const off = harness({ status: 409, body: { error: 'waits are disabled on this cockpit (CEZ_TASK_WAITS=0) — …' } });
    expect(await runTaskCommand(['wait', 'abc'], env, off.io)).toBe(2);
    expect(off.err[0]).toContain('Do not poll');
    const cycle = harness({ status: 409, body: { error: 'waiting would create a cycle: a → b → a' } });
    expect(await runTaskCommand(['wait', 'abc'], env, cycle.io)).toBe(1);
    expect(cycle.err[0]).toContain('cycle');
    expect(await runTaskCommand(['wait'], env, harness({ status: 200, body: {} }).io)).toBe(1);
  });

  it('waits lists this task’s edges off its run record', async () => {
    const h = harness({ status: 200, body: { id: 'run-1', waits: [
      { id: 'w1', target: { projectId: 'api', runId: 'abcdef1234' }, targetTitle: 'Add export', origin: 'agent', deadline: '2026-10-06T10:00:00.000Z', state: 'pending' },
      { id: 'w2', target: { projectId: 'proj', runId: '12345678zz' }, targetTitle: 'Old one', origin: 'user', deadline: 'x', state: 'settled', resolvedAt: '2026-10-05T11:00:00.000Z', outcome: { status: 'done', costUsd: 1 } },
    ] } });
    expect(await runTaskCommand(['waits'], env, h.io)).toBe(0);
    expect(h.calls[0]?.url).toBe('http://127.0.0.1:4321/api/v1/p/proj/runs/run-1');
    expect(h.out[0]).toContain('pending');
    expect(h.out[0]).toContain('api/abcdef12  "Add export"');
    expect(h.out[1]).toContain('target done $1.00');
    const none = harness({ status: 200, body: { id: 'run-1' } });
    expect(await runTaskCommand(['waits'], env, none.io)).toBe(0);
    expect(none.out[0]).toBe('this task waits for nothing');
  });

  it('create --project posts a create-and-wait to the waits route, not a dispatch', async () => {
    const edge = { id: 'w1', target: { projectId: 'api', runId: 'newrun1234' }, targetTitle: 'Add export', origin: 'agent', created: true, deadline: 'd', state: 'pending', createdAt: 'x' };
    const h = harness({ status: 200, body: { kind: 'pending', edge } });
    expect(await runTaskCommand(['create', 'Add the export endpoint', '--project', 'api', '--title', 'Add export', '--budget', '3', '--runner', 'codex', '--success', 'GET /export answers CSV', '--timeout', '120'], env, h.io)).toBe(0);
    expect(h.calls[0]?.url).toBe('http://127.0.0.1:4321/api/v1/p/proj/runs/run-1/waits');
    expect(JSON.parse(String(h.calls[0]?.init?.body))).toEqual({
      create: { projectId: 'api', objective: 'Add the export endpoint', title: 'Add export', budget: 3, runner: 'codex', success: 'GET /export answers CSV' },
      timeoutMinutes: 120,
    });
    expect(h.out[0]).toContain('created and waiting for "Add export" (api/newrun12)');
  });

  it('create --project refuses the dispatch-only flags; --timeout without --project is an error', async () => {
    const h = harness({ status: 200, body: {} });
    expect(await runTaskCommand(['create', 'x', '--project', 'api', '--kind', 'review'], env, h.io)).toBe(1);
    expect(h.err[0]).toContain('--kind cannot be combined with --project');
    expect(await runTaskCommand(['create', 'x', '--timeout', '5'], env, h.io)).toBe(1);
    expect(h.calls).toEqual([]);
  });
});
