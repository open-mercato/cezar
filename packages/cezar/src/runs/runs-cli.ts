/**
 * `cez runs …` — read a running cockpit's tasks from a shell (#1080).
 *
 * A thin, read-only HTTP client over `GET /api/v1/runs`, addressed like `cez task` and
 * `cez automation`: `CEZ_API_URL` (the cockpit) and optionally `CEZ_PROJECT_ID` (which project;
 * without it the cockpit answers for the project it was started in). No server: the command says
 * so and exits 2 — the address is never guessed, see `cockpit-address.ts`.
 *
 * Read-only on purpose. Cancelling or relaunching a task from a shell is a separate surface with
 * its own questions (which verbs, what an agent may do with them); listing is what a person needs
 * first, instead of reading `.ai/cezar/runs.json` by hand.
 *
 * The request carries a bounded deadline (`AbortSignal.timeout`, covering the body read as well as
 * connect/headers — measured in `runs-cli.test.ts`): a cockpit that stalls or a proxy that keeps an
 * incomplete response open must not hang a shell or an agent turn forever.
 */
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { runRecordSchema, runStatusSchema, type RunStatus } from '@open-mercato/cezar-contract';
import { missingCockpitMessage } from '../cockpit-address.ts';

export interface RunsCliEnv {
  CEZ_API_URL?: string;
  CEZ_PROJECT_ID?: string;
  CEZ_TASK_ID?: string;
}

export interface RunsCliIo {
  fetch: typeof fetch;
  log: (line: string) => void;
  error: (line: string) => void;
  /** The `GET /runs` request's deadline; injectable so tests use a short one instead of the real
   *  `RUNS_REQUEST_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/** No sibling CLI client (`task-cli.ts`, `automation-cli.ts`) had a request timeout to borrow from
 *  (#1133 review) — a plain, generous bound for a call to a cockpit on the same machine. */
const RUNS_REQUEST_TIMEOUT_MS = 10_000;

const USAGE = `cez runs — read the tasks of a running cockpit from a shell (CEZ_API_URL, optional CEZ_PROJECT_ID)

  cez runs list [--status <status>[,<status>]] [--all] [--json]
                    this project's tasks, newest first: id, status, cost, title and branch;
                    --status keeps only ${runStatusSchema.options.join('|')};
                    --all includes archived tasks; --json prints the matching records as the API sends them`;

/**
 * The keys `list` prints. The rest of each record travels untouched to `--json`.
 *
 * `status` is deliberately widened to `z.string()` instead of the contract's `runStatusSchema`: a
 * cockpit newer than this CLI can add a status this build does not know the name of, and that must
 * still list (with the raw name) and reach `--json` rather than making the whole record vanish as
 * if it failed validation. `parseStatuses` below stays strict about what `--status` itself accepts
 * — you cannot ask to filter on a status this build has never heard of.
 */
const listedRunSchema = runRecordSchema
  .pick({
    id: true,
    title: true,
    titleSummary: true,
    activity: true,
    createdAt: true,
    costUsd: true,
    branch: true,
    archived: true,
  })
  .extend({ status: z.string() });

function base(env: RunsCliEnv): string | null {
  const url = env.CEZ_API_URL?.replace(/\/+$/, '');
  if (!url) return null;
  return env.CEZ_PROJECT_ID ? `${url}/api/v1/p/${encodeURIComponent(env.CEZ_PROJECT_ID)}` : `${url}/api/v1`;
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

/** `AbortSignal.timeout(ms)` fires a `DOMException`/`Error` named `TimeoutError` — whether while
 *  `fetch()` itself is still connecting or while a later `response.json()` reads the body, since
 *  both hang off the one signal and its one deadline (measured in `runs-cli.test.ts`). */
function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError';
}

function formatDuration(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}

function parseStatuses(value: string | undefined): Set<RunStatus> | null {
  if (value === undefined) return null;
  const statuses = new Set<RunStatus>();
  for (const part of value.split(',').map((status) => status.trim()).filter(Boolean)) {
    const parsed = runStatusSchema.safeParse(part);
    if (!parsed.success) throw new Error(`--status wants ${runStatusSchema.options.join(', ')}, not "${part}"`);
    statuses.add(parsed.data);
  }
  if (statuses.size === 0) throw new Error('--status needs at least one status');
  return statuses;
}

export async function runRunsCommand(
  args: string[],
  env: RunsCliEnv = process.env,
  io: RunsCliIo = { fetch, log: console.log, error: console.error },
): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === 'help' || command === '--help') {
    io.log(USAGE);
    return command ? 0 : 2;
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    io.log(USAGE);
    return 0;
  }
  if (command !== 'list') {
    io.error(`cez runs: unknown command "${command}"\n\n${USAGE}`);
    return 2;
  }
  const scope = base(env);
  if (!scope) {
    io.error(missingCockpitMessage({
      command: 'cez runs',
      example: 'cez runs list',
      insideTask: 'this cockpit did not give the task an address. Read your own task tree with `cez task list` instead, or stop and report that the cockpit is unreachable.',
    }, env));
    return 2;
  }

  try {
    const { values } = parseArgs({
      args: rest,
      allowPositionals: false,
      options: {
        status: { type: 'string' },
        all: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
      },
    });
    const statuses = parseStatuses(values.status);
    const timeoutMs = io.timeoutMs ?? RUNS_REQUEST_TIMEOUT_MS;
    let response: Response;
    try {
      response = await io.fetch(`${scope}/runs`, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw isTimeout(error) ? new Error(`the cockpit did not answer within ${formatDuration(timeoutMs)}`) : error;
    }
    if (!response.ok) throw new Error(`could not list runs — ${await readError(response)}`);
    let raw: unknown;
    try {
      raw = await response.json();
    } catch (error) {
      throw isTimeout(error) ? new Error(`the cockpit did not answer within ${formatDuration(timeoutMs)}`) : error;
    }
    const parsed = z.array(z.unknown()).safeParse(raw);
    if (!parsed.success) throw new Error('the cockpit answered GET /runs with something other than a list');
    const runs = parsed.data.flatMap((record) => {
      const run = listedRunSchema.safeParse(record);
      return run.success ? [{ run: run.data, record }] : [];
    });
    // A record can fail `listedRunSchema` only by missing/mistyping a required field (id, title,
    // createdAt, archived) — an unrecognized `status` no longer disqualifies it, see above. That
    // makes a rejection worth surfacing rather than quietly presenting a shorter list as complete
    // (#1133 review); when EVERY record was rejected, "no tasks" would be an outright lie, so this
    // fails instead of printing it.
    const rejected = parsed.data.length - runs.length;
    const allRejected = parsed.data.length > 0 && runs.length === 0;
    if (rejected > 0) {
      io.error(`cez runs: ignored ${rejected} record${rejected === 1 ? '' : 's'} the cockpit sent in a shape this CLI does not recognize`);
    }
    const kept = runs
      .filter(({ run }) => (values.all || !run.archived) && (!statuses || statuses.has(run.status as RunStatus)))
      .sort((a, b) => b.run.createdAt.localeCompare(a.run.createdAt));
    if (values.json) {
      io.log(JSON.stringify(kept.map(({ record }) => record), null, 2));
      return allRejected ? 1 : 0;
    }
    if (allRejected) return 1;
    if (kept.length === 0) {
      io.log(runs.length === 0 ? 'no tasks' : 'no tasks match');
      return 0;
    }
    for (const { run } of kept) {
      const title = run.titleSummary ?? run.title;
      const status = run.activity ? `${run.status}/${run.activity}` : run.status;
      const cost = run.costUsd !== undefined ? `  $${run.costUsd.toFixed(2)}` : '';
      const archived = run.archived ? '  (archived)' : '';
      io.log(`${run.id.slice(0, 8)}  ${status}${cost}  ${title}${run.branch ? `  [${run.branch}]` : ''}${archived}`);
    }
    return 0;
  } catch (error) {
    io.error(`cez runs: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
