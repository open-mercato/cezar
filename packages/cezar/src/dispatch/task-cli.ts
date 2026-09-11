/**
 * `cez task …` — the CLI a running agent uses to dispatch other tasks and to report
 * (spec `.ai/specs/2026-09-10-dispatch.md`).
 *
 * It is a thin HTTP client over the dispatch family, addressed by three variables the engine puts
 * in every agent's environment while `CEZ_DISPATCH=1`: `CEZ_API_URL` (the cockpit), `CEZ_PROJECT_ID`
 * (which project the run belongs to) and `CEZ_TASK_ID` (the run itself). A human at a shell can
 * set the same three and use it too. No server, no dispatch: the command says so and exits 2.
 */
import { parseArgs } from 'node:util';

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

const USAGE = `cez task — dispatch cezar tasks from inside a task (needs CEZ_DISPATCH=1 on the cockpit)

  cez task create "<objective>" [--title "…"] [--kind implement|review] [--review-of <branch|run>]
                  [--scope "…"] [--budget <usd>] [--success "…"] [--evidence "…"] [--tools A,B]
                  [--runner claude|codex|opencode] [--model <model>] [--retry-limit <0-3>]
  cez task report --status done|partial|failed|blocked --result "…" [--evidence "…"]…
                  [--verdict approve|changes|reject] [--suggestions "…"]… [--confidence <0-1>]
                  [--side-effect "…"]… [--error "…"]… [--next "…"]
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
    io.error('cez task: CEZ_API_URL is not set — this command only works inside a task run by a cockpit started with CEZ_DISPATCH=1. Do not substitute sub-agents or do the delegated work yourself: stop and report that dispatch is unavailable.');
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
          },
        });
        const objective = positionals.join(' ').trim();
        if (!objective) throw new Error('an objective is required: cez task create "<objective>"');
        if (!env.CEZ_TASK_ID) throw new Error('CEZ_TASK_ID is not set — only a running task can dispatch');
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
