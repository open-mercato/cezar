import { describe, expect, it } from 'vitest';
import { dispatchInputSchema, dispatchReportSchema, taskTreeNodeSchema } from '@open-mercato/cezar-contract';
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

  // `--help` is the ONLY place an agent learns the flags (the prompt carries the decisions), so it
  // must name one for every key the two request bodies accept.
  it('--help documents a flag for every key of the dispatch and report bodies, one flag per line', async () => {
    const h = harness({ status: 200, body: {} });
    expect(await runTaskCommand(['--help'], {}, h.io)).toBe(0);
    const usage = h.out.join('\n');
    const createFlag: Record<string, string> = {
      objective: '"<objective>"', title: '--title', kind: '--kind', review_of: '--review-of', scope: '--scope',
      allowed_tools: '--tools', max_cost: '--budget', success_criteria: '--success', required_evidence: '--evidence',
      retry_limit: '--retry-limit', runner: '--runner', model: '--model',
    };
    for (const key of Object.keys(dispatchInputSchema.shape)) {
      expect(createFlag[key], `no flag mapped for dispatch key ${key}`).toBeDefined();
      expect(usage).toMatch(new RegExp(`^\\s+${createFlag[key]!.replace(/[.*+?^${}()|[\]\\"]/g, '\\$&')}\\s`, 'm'));
    }
    const reportFlag: Record<string, string> = {
      status: '--status', result: '--result', evidence: '--evidence', confidence: '--confidence', side_effects: '--side-effect',
      errors: '--error', recommended_next_action: '--next', verdict: '--verdict', suggestions: '--suggestions',
    };
    for (const key of Object.keys(dispatchReportSchema.shape)) {
      expect(reportFlag[key], `no flag mapped for report key ${key}`).toBeDefined();
      expect(usage).toContain(`  ${reportFlag[key]}`);
    }
    // The rules the prompt used to carry.
    expect(usage).toContain('At most 4 children in flight');
    expect(usage).toContain('COMMIT before dispatching');
    expect(usage).toContain('node "$CEZ_BIN" task');
    expect(usage).toContain('--json');
  });

  it('answers a subcommand’s --help without a cockpit — the reference is read before anything is sent', async () => {
    const h = harness({ status: 200, body: {} });
    expect(await runTaskCommand(['create', '--help'], {}, h.io)).toBe(0);
    expect(h.out[0]).toContain('--retry-limit');
    expect(h.err).toEqual([]);
    expect(h.calls).toHaveLength(0);
  });

  it('list --json prints the tree as one machine-readable array, root first then depth-first', async () => {
    const h = harness({
      status: 200,
      body: [
        { id: 'root-0000', title: 'Root', status: 'running', costUsd: 1.5, dispatch: { rootRunId: 'root-0000' } },
        { id: 'run-1', title: 'Me', status: 'running', branch: 'cez/run1', dispatch: { rootRunId: 'root-0000', parentRunId: 'root-0000' } },
        { id: 'kid-0000', title: 'Kid', status: 'done', costUsd: 0.1, dispatch: { rootRunId: 'root-0000', parentRunId: 'run-1', kind: 'review', report: { status: 'done', verdict: 'approve' } } },
        { id: 'other', title: 'Unrelated', status: 'done' },
      ],
    });
    expect(await runTaskCommand(['list', '--json'], env, h.io)).toBe(0);
    expect(h.out).toHaveLength(1);
    expect(JSON.parse(h.out[0]!)).toEqual([
      { id: 'root-0000', depth: 0, status: 'running', title: 'Root', costUsd: 1.5 },
      { id: 'run-1', parentRunId: 'root-0000', depth: 1, status: 'running', title: 'Me', branch: 'cez/run1' },
      { id: 'kid-0000', parentRunId: 'run-1', depth: 2, status: 'done', title: 'Kid', costUsd: 0.1, kind: 'review', report: { status: 'done', verdict: 'approve' } },
    ]);
    for (const node of JSON.parse(h.out[0]!) as unknown[]) expect(taskTreeNodeSchema.safeParse(node).success).toBe(true);
    const tree = harness({ status: 200, body: [{ id: 'root-0000', title: 'Root', status: 'done', dispatch: { rootRunId: 'root-0000' } }] });
    expect(await runTaskCommand(['tree', '--json', 'root-0000'], env, tree.io)).toBe(0);
    expect(JSON.parse(tree.out[0]!)).toEqual([{ id: 'root-0000', depth: 0, status: 'done', title: 'Root' }]);
  });

  it('tolerates a null costUsd — an old or hand-edited record must not throw through the schema', async () => {
    const h = harness({
      status: 200,
      body: [
        { id: 'run-1', title: 'Me', status: 'running', costUsd: null, dispatch: { rootRunId: 'run-1' } },
      ],
    });
    expect(await runTaskCommand(['list', '--json'], env, h.io)).toBe(0);
    expect(JSON.parse(h.out[0]!)).toEqual([{ id: 'run-1', depth: 0, status: 'running', title: 'Me' }]);
    expect(await runTaskCommand(['list'], env, h.io)).toBe(0);
    expect(h.out[1]).toBe('run-1  running  Me');
  });

  it('help says --runner and --model default to the caller\u2019s own, and how to choose a runner', async () => {
    const h = harness({ status: 200, body: {} });
    expect(await runTaskCommand(['help'], {}, h.io)).toBe(0);
    const usage = h.out.join('\n');
    expect(usage).toContain('who runs the child (default: yours)');
    expect(usage).toContain('use the runner the user named, else a cheaper or faster one');
    expect(usage).toContain("the child's model (default: yours)");
  });

  it('help keeps --budget optional so an uncapped parent does not invent a cap', async () => {
    const h = harness({ status: 200, body: {} });
    expect(await runTaskCommand(['help'], {}, h.io)).toBe(0);
    const usage = h.out.join('\n');
    expect(usage).toContain('Omit it unless the user or your order named a cost limit');
    expect(usage).toContain('under a capped parent a child without one gets the whole remainder, under an uncapped parent it is uncapped');
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
});
