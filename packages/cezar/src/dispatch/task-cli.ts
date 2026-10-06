/**
 * `cez task …` — the CLI a running agent uses to dispatch other tasks and to report
 * (spec `.ai/specs/2026-09-10-dispatch.md`), and to wait for other tasks — in its own project or
 * another (spec `.ai/specs/2026-10-05-cross-task-waits.md`).
 *
 * It is a thin HTTP client over the dispatch family, addressed by three variables the engine puts
 * in every agent's environment while dispatch is on (the default; `CEZ_DISPATCH=0` turns it off): `CEZ_API_URL` (the cockpit), `CEZ_PROJECT_ID`
 * (which project the run belongs to) and `CEZ_TASK_ID` (the run itself). A human at a shell can
 * set the same three and use it too. No server, no dispatch: the command says so and exits 2.
 */
import { parseArgs } from 'node:util';
import { RUNNER_IDS } from '../core/agent-runner.ts';

export interface TaskCliEnv {
  CEZ_API_URL?: string;
  CEZ_PROJECT_ID?: string;
  CEZ_TASK_ID?: string;
}

export interface TaskCliIo {
  fetch: typeof fetch;
  log: (line: string) => void;
  error: (line: string) => void;
}

const USAGE = `cez task — dispatch cezar tasks from inside a task (on by default; CEZ_DISPATCH=0 on the cockpit turns it off)

  cez task create "<objective>" [--title "…"] [--kind implement|review] [--review-of <branch|run>]
                  [--scope "…"] [--budget <usd>] [--success "…"] [--evidence "…"] [--tools A,B]
                  [--runner ${RUNNER_IDS.join('|')}] [--model <model>] [--retry-limit <0-3>]
  cez task report --status done|partial|failed|blocked --result "…" [--evidence "…"]…
                  [--verdict approve|changes|reject] [--suggestions "…"]… [--confidence <0-1>]
                  [--side-effect "…"]… [--error "…"]… [--next "…"]
  cez task create "<objective>" --project <projectId> [--title "…"] [--budget <usd>] [--runner …]
                  [--model …] [--scope "…"] [--success "…"] [--timeout <minutes>]
                                      start an independent task in ANOTHER project and wait for it
  cez task wait [<projectId>/]<runId> [--timeout <minutes>]
                                      wait for another task (a bare id means this project; 8 chars do)
  cez task waits                      this task's waits and their state
  cez task list                       the tree this task belongs to, with status and cost
  cez task tree <run id>              the tree rooted at (or containing) another run`;

function base(env: TaskCliEnv): { url: string; scope: string } | null {
  const url = env.CEZ_API_URL?.replace(/\/+$/, '');
  if (!url) return null;
  const scope = env.CEZ_PROJECT_ID ? `${url}/api/v1/p/${encodeURIComponent(env.CEZ_PROJECT_ID)}` : `${url}/api/v1`;
  return { url, scope };
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string') return body.error;
  } catch {
    // not JSON
  }
  return `${response.status} ${response.statusText}`;
}

/** The header the wait routes read to tell the agent's own declaration from the user's
 *  (`TASK_ID_HEADER` in `server/server.ts` — restated, the CLI must not import the server). */
const TASK_ID_HEADER = 'x-cez-task-id';

/** Exit code and message for a cockpit with cross-task waits turned off: exit 2 like "no
 *  cockpit", and an instruction that rules out the polling the feature exists to replace. */
const WAITS_OFF_EXIT = 2;
const WAITS_OFF_MESSAGE =
  'cez task: waits are disabled on this cockpit (CEZ_TASK_WAITS=0). Do not poll the other task instead: continue without it, or stop and report that you are blocked on it.';

/** `[<projectId>/]<runId>` → the route's `target`. */
export function parseWaitTarget(ref: string): { projectId?: string; runId: string } {
  const trimmed = ref.trim();
  const slash = trimmed.lastIndexOf('/');
  if (slash < 0) return { runId: trimmed };
  const projectId = trimmed.slice(0, slash);
  const runId = trimmed.slice(slash + 1);
  if (!projectId || !runId) throw new Error(`"${ref}" is not <projectId>/<runId>`);
  return { projectId, runId };
}

interface WaitEdgeWire {
  id: string;
  target: { projectId: string; runId: string };
  targetTitle: string;
  origin: string;
  created?: boolean;
  deadline: string;
  state: string;
  resolvedAt?: string;
  outcome?: { status: string; prUrl?: string; costUsd?: number };
}

function edgeLine(edge: WaitEdgeWire): string {
  const ref = `${edge.target.projectId}/${edge.target.runId.slice(0, 8)}`;
  const tail = edge.state === 'pending'
    ? `until ${edge.deadline}`
    : `${edge.outcome ? `target ${edge.outcome.status}${edge.outcome.prUrl ? ` ${edge.outcome.prUrl}` : ''}${edge.outcome.costUsd !== undefined ? ` $${edge.outcome.costUsd.toFixed(2)}` : ''}` : ''}${edge.resolvedAt ? ` at ${edge.resolvedAt}` : ''}`.trim();
  return `${edge.state.padEnd(18)} ${ref}  "${edge.targetTitle}"${edge.created ? ' (created by this task)' : ''}${tail ? `  — ${tail}` : ''}`;
}

/** Print a declaration's answer, the same for `wait` and `create --project`. */
async function printDeclared(response: Response, io: TaskCliIo, what: string): Promise<number> {
  if (response.status === 409) {
    const message = await readError(response);
    if (message.includes('CEZ_TASK_WAITS=0')) {
      io.error(WAITS_OFF_MESSAGE);
      return WAITS_OFF_EXIT;
    }
    throw new Error(`${what} refused — ${message}`);
  }
  if (!response.ok) throw new Error(`${what} refused — ${await readError(response)}`);
  const body = (await response.json()) as
    | { kind: 'pending'; edge: WaitEdgeWire }
    | { kind: 'settled'; outcome: { target: { projectId: string; runId: string }; title: string; status: string; branch?: string; prUrl?: string; costUsd?: number; error?: string; report?: { status: string; result: string; verdict?: string } } };
  if (body.kind === 'settled') {
    const { outcome } = body;
    io.log(`"${outcome.title}" (${outcome.target.projectId}/${outcome.target.runId.slice(0, 8)}) has already settled — ${outcome.status}. Nothing to wait for; carry on.`);
    if (outcome.branch) io.log(`  branch: ${outcome.branch}`);
    if (outcome.prUrl) io.log(`  PR: ${outcome.prUrl}`);
    if (outcome.costUsd !== undefined) io.log(`  cost: $${outcome.costUsd.toFixed(2)}`);
    if (outcome.report) io.log(`  report: ${outcome.report.status}${outcome.report.verdict ? ` (${outcome.report.verdict})` : ''} — ${outcome.report.result}`);
    if (outcome.error) io.log(`  error: ${outcome.error}`);
    return 0;
  }
  const { edge } = body;
  io.log(`${edge.created ? 'created and ' : ''}waiting for "${edge.targetTitle}" (${edge.target.projectId}/${edge.target.runId.slice(0, 8)}) until ${edge.deadline}.`);
  io.log('End your turn now: cezar parks this task without holding a slot and wakes it with the outcome when that task settles. Do not poll it.');
  return 0;
}

function number(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a number`);
  return parsed;
}

export async function runTaskCommand(
  args: string[],
  env: TaskCliEnv = process.env,
  io: TaskCliIo = { fetch, log: console.log, error: console.error },
): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === 'help' || command === '--help') {
    io.log(USAGE);
    return command ? 0 : 2;
  }
  const api = base(env);
  if (!api) {
    io.error('cez task: CEZ_API_URL is not set — this command only works inside a task run by a cockpit with dispatch on (it is on by default; CEZ_DISPATCH=0 turns it off). Do not substitute sub-agents or do the delegated work yourself: stop and report that dispatch is unavailable.');
    return 2;
  }

  if (rest.includes('--help') || rest.includes('-h')) {
    io.log(USAGE);
    return 0;
  }

  try {
    switch (command) {
      case 'create': {
        const { values, positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: {
            title: { type: 'string' },
            kind: { type: 'string' },
            'review-of': { type: 'string', multiple: true },
            scope: { type: 'string' },
            budget: { type: 'string' },
            success: { type: 'string' },
            evidence: { type: 'string' },
            tools: { type: 'string' },
            runner: { type: 'string' },
            model: { type: 'string' },
            'retry-limit': { type: 'string' },
            project: { type: 'string' },
            timeout: { type: 'string' },
          },
        });
        const objective = positionals.join(' ').trim();
        if (!objective) throw new Error('an objective is required: cez task create "<objective>"');
        if (!env.CEZ_TASK_ID) throw new Error('CEZ_TASK_ID is not set — only a running task can dispatch');
        // `--project`: an independent task in ANOTHER project, created and waited for in one
        // request (spec 2026-10-05-cross-task-waits, Phase 2) — not a dispatch child.
        if (values.project !== undefined) {
          const unsupported = (['kind', 'review-of', 'evidence', 'tools', 'retry-limit'] as const).filter((flag) => values[flag] !== undefined);
          if (unsupported.length) throw new Error(`--${unsupported.join(', --')} cannot be combined with --project`);
          const body = {
            create: {
              projectId: values.project,
              objective,
              ...(values.title ? { title: values.title } : {}),
              ...(values.budget !== undefined ? { budget: number(values.budget, 'budget') } : {}),
              ...(values.runner ? { runner: values.runner } : {}),
              ...(values.model ? { model: values.model } : {}),
              ...(values.scope ? { scope: values.scope } : {}),
              ...(values.success ? { success: values.success } : {}),
            },
            ...(values.timeout !== undefined ? { timeoutMinutes: number(values.timeout, 'timeout') } : {}),
          };
          const response = await io.fetch(`${api.scope}/runs/${encodeURIComponent(env.CEZ_TASK_ID)}/waits`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', [TASK_ID_HEADER]: env.CEZ_TASK_ID },
            body: JSON.stringify(body),
          });
          return await printDeclared(response, io, 'create');
        }
        if (values.timeout !== undefined) throw new Error('--timeout only applies with --project (or to cez task wait)');
        const body = {
          objective,
          ...(values.title ? { title: values.title } : {}),
          ...(values.kind ? { kind: values.kind } : {}),
          ...(values['review-of']?.length ? { review_of: values['review-of'] } : {}),
          ...(values.scope ? { scope: values.scope } : {}),
          ...(values.budget !== undefined ? { max_cost: number(values.budget, 'budget') } : {}),
          ...(values.success ? { success_criteria: values.success } : {}),
          ...(values.evidence ? { required_evidence: values.evidence } : {}),
          ...(values.tools ? { allowed_tools: values.tools.split(',').map((tool) => tool.trim()).filter(Boolean) } : {}),
          ...(values.runner ? { runner: values.runner } : {}),
          ...(values.model ? { model: values.model } : {}),
          ...(values['retry-limit'] !== undefined ? { retry_limit: number(values['retry-limit'], 'retry-limit') } : {}),
        };
        const response = await io.fetch(`${api.scope}/runs/${encodeURIComponent(env.CEZ_TASK_ID)}/dispatch`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error(`dispatch refused — ${await readError(response)}`);
        const created = (await response.json()) as { id: string; branch?: string };
        io.log(`dispatched ${created.id}${created.branch ? ` on branch ${created.branch}` : ''}`);
        io.log('It reports into this session when it settles. End your turn with CEZ:MONITORING to wait for it.');
        return 0;
      }
      case 'report': {
        const { values } = parseArgs({
          args: rest,
          allowPositionals: false,
          options: {
            status: { type: 'string' },
            result: { type: 'string' },
            evidence: { type: 'string', multiple: true },
            verdict: { type: 'string' },
            suggestions: { type: 'string', multiple: true },
            confidence: { type: 'string' },
            'side-effect': { type: 'string', multiple: true },
            error: { type: 'string', multiple: true },
            next: { type: 'string' },
          },
        });
        if (!values.status || !values.result) throw new Error('--status and --result are required');
        if (!env.CEZ_TASK_ID) throw new Error('CEZ_TASK_ID is not set — only a running task can report');
        const body = {
          status: values.status,
          result: values.result,
          evidence: values.evidence ?? [],
          side_effects: values['side-effect'] ?? [],
          errors: values.error ?? [],
          suggestions: values.suggestions ?? [],
          ...(values.verdict ? { verdict: values.verdict } : {}),
          ...(values.confidence !== undefined ? { confidence: number(values.confidence, 'confidence') } : {}),
          ...(values.next ? { recommended_next_action: values.next } : {}),
        };
        const response = await io.fetch(`${api.scope}/runs/${encodeURIComponent(env.CEZ_TASK_ID)}/report`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error(`report refused — ${await readError(response)}`);
        io.log(`report recorded — status ${values.status}${values.verdict ? `, verdict ${values.verdict}` : ''}. It is delivered to your parent when this task settles.`);
        return 0;
      }
      case 'wait': {
        const { values, positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: { timeout: { type: 'string' } },
        });
        const ref = positionals[0];
        if (!ref || positionals.length > 1) throw new Error('one target is required: cez task wait [<projectId>/]<runId>');
        if (!env.CEZ_TASK_ID) throw new Error('CEZ_TASK_ID is not set — only a running task can wait');
        const body = {
          target: parseWaitTarget(ref),
          ...(values.timeout !== undefined ? { timeoutMinutes: number(values.timeout, 'timeout') } : {}),
        };
        const response = await io.fetch(`${api.scope}/runs/${encodeURIComponent(env.CEZ_TASK_ID)}/waits`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [TASK_ID_HEADER]: env.CEZ_TASK_ID },
          body: JSON.stringify(body),
        });
        return await printDeclared(response, io, 'wait');
      }
      case 'waits': {
        if (!env.CEZ_TASK_ID) throw new Error('CEZ_TASK_ID is not set');
        const response = await io.fetch(`${api.scope}/runs/${encodeURIComponent(env.CEZ_TASK_ID)}`);
        if (!response.ok) throw new Error(`could not read this task — ${await readError(response)}`);
        const run = (await response.json()) as { waits?: WaitEdgeWire[] };
        const edges = run.waits ?? [];
        if (edges.length === 0) {
          io.log('this task waits for nothing');
          return 0;
        }
        for (const edge of edges) io.log(edgeLine(edge));
        return 0;
      }
      case 'list':
      case 'tree': {
        const anchor = command === 'tree' ? rest[0] : env.CEZ_TASK_ID;
        if (!anchor) throw new Error(command === 'tree' ? 'a run id is required' : 'CEZ_TASK_ID is not set');
        const response = await io.fetch(`${api.scope}/runs`);
        if (!response.ok) throw new Error(`could not list runs — ${await readError(response)}`);
        const runs = (await response.json()) as Array<{
          id: string;
          title: string;
          status: string;
          costUsd?: number;
          branch?: string;
          dispatch?: { rootRunId: string; parentRunId?: string; kind?: string; report?: { status: string; verdict?: string } };
        }>;
        const me = runs.find((run) => run.id === anchor || run.id.startsWith(anchor));
        if (!me) throw new Error(`no run ${anchor}`);
        const rootId = me.dispatch?.rootRunId ?? me.id;
        const byParent = new Map<string, typeof runs>();
        for (const run of runs) {
          if (run.dispatch?.rootRunId !== rootId) continue;
          const key = run.dispatch.parentRunId ?? '';
          byParent.set(key, [...(byParent.get(key) ?? []), run]);
        }
        const print = (run: (typeof runs)[number], depth: number): void => {
          const cost = run.costUsd !== undefined ? ` $${run.costUsd.toFixed(2)}` : '';
          const report = run.dispatch?.report ? ` → ${run.dispatch.report.status}${run.dispatch.report.verdict ? ` (${run.dispatch.report.verdict})` : ''}` : '';
          io.log(`${'  '.repeat(depth)}${run.id.slice(0, 8)}  ${run.status}${cost}  ${run.title}${run.branch ? `  [${run.branch}]` : ''}${report}`);
          for (const child of byParent.get(run.id) ?? []) print(child, depth + 1);
        };
        const root = runs.find((run) => run.id === rootId);
        if (root) print(root, 0);
        else for (const child of byParent.get('') ?? []) print(child, 0);
        return 0;
      }
      default:
        io.error(`cez task: unknown command "${command}"\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    io.error(`cez task: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
