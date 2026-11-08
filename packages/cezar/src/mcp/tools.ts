/**
 * The `cez mcp` tool set (#1109).
 *
 * Every tool is a thin call to an existing `/api/v1` route, never to `RunManager`/`RunStore`
 * directly: the cockpit process is the single writer of run state, and the route handlers own
 * the policy (workflow lookup, provider gates, capability checks, project scoping).
 *
 * Every tool states all four hints explicitly — the test next to this file fails on one that
 * leaves a hint to the client's default. `readOnly: true` is a hard filter: write tools are not
 * registered at all, not merely annotated.
 *
 * Output: each tool's `outputSchema` is cut from the contract's response schema, and the answer
 * is PARSED through it, so `structuredContent` can never drift from what `tools/list` advertised.
 * Run statuses are widened to strings (as `cez runs` does): a cockpit newer than this CLI may add
 * one, and that must not turn every answer into a validation error.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { McpServer } from '@modelcontextprotocol/server';
import type { CallToolResult, ServerContext, ToolAnnotations } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  apiRunSchema,
  cancelResponseSchema,
  continueResponseSchema,
  createRunInputBaseSchema,
  finishResponseSchema,
  githubRefStatusDataSchema,
  gitPushResponseSchema,
  messageInputSchema,
  messageResponseSchema,
  modelDiscoveryRunnerSchema,
  projectListEntrySchema,
  projectsResponseSchema,
  REFERENCE_STATUS_MAX,
  runHistoryCursorSchema,
  runHistoryEventSchema,
  runCommitSchema,
  runCommitsResponseSchema,
  runHistoryPageSchema,
  runIdParamSchema,
  runIndexEntrySchema,
  runnerModelCatalogResponseSchema,
  runsIndexResponseSchema,
  runStatusSchema,
  workflowDefSchema,
  workflowLoadIssueSchema,
} from '@open-mercato/cezar-contract';
import { CezarApiError, isConnectionError, longDeadline, readJson, type CezarClient } from './api.ts';

/** A reachable cockpit: its client, and the project a tool call targets when it names none. */
export interface Cockpit {
  api: CezarClient;
  defaultProjectId: string;
  /** Set when the project holding the cwd could not be determined: why. Reads still use
   *  `defaultProjectId`; `start_run` without a `projectId` refuses with this instead of guessing. */
  projectUnknown?: string;
  /** Set when discovery could not rule out another cockpit (a port that stalled): why. Every
   *  write refuses with this; reads go ahead. */
  writeRefused?: string;
  /** What this answer was made without (a stalled port, an unread registry), shown with every
   *  answer so the model sees it, not just stderr. */
  warnings?: string[];
}

export interface ProjectChoice {
  id: string;
  name?: string;
}

/** `"2 projects (a (Repo A), b)"` — what start_run asks the model to choose from. */
export function describeProjectChoice(projects: ProjectChoice[]): string {
  const listed = projects.map((p) => (p.name && p.name !== p.id ? `${p.id} (${p.name})` : p.id)).join(', ');
  return `${projects.length} project${projects.length === 1 ? '' : 's'} (${listed || 'none registered'})`;
}

export interface McpToolsOptions {
  /** Resolves the cockpit lazily — stdio discovers it on first use, not at spawn. */
  cockpit: () => Promise<Cockpit>;
  version: string;
  /** Register only the read-only tools. */
  readOnly?: boolean;
  /** `wait_for_runs` poll interval; tests shorten it. */
  pollIntervalMs?: number;
}

/** Statuses at which a run stops needing nobody: finished, or parked on the user. */
const SETTLED = new Set(['done', 'failed', 'cancelled', 'waiting', 'review']);
/** Codex cuts a tool call at 60 s by default; stay under it with room for the round trip. */
export const WAIT_MAX_SECONDS = 45;
export const WAIT_DEFAULT_SECONDS = 40;
export const WAIT_POLL_MS = 2_000;
/** review_run send_back waits for its continuation to start for at most this many reads, `WAIT_POLL_MS / 8` apart (~5 s). */
const SEND_BACK_POLLS = 20;
/** `GET /models` may ask a vendor CLI first, bounded at 15 s server-side — past the 10 s default. */
const MODELS_TIMEOUT_MS = 30_000;
/** Without `afterSeq` on `/history`, catching up walks back at most this many pages (100 items each). */
export const EVENTS_MAX_WALK_PAGES = 5;
/** One tool answer, serialized. It travels twice (text + structuredContent) and Claude Code refuses
 *  results past ~25k tokens; a long run's history page alone was ~344k chars. */
export const RESPONSE_BUDGET_CHARS = 40_000;
export const EVENTS_DEFAULT_MAX = 200;
export const EVENTS_MAX = 500;

// ---- inputs ----------------------------------------------------------------------------------

const projectIdArg = z
  .string()
  .min(1)
  .max(128)
  .optional()
  .describe('Project id from list_projects. Omit for the default project.');
const runIdArg = runIdParamSchema.shape.id.describe('Run id (from list_runs or start_run).');
const runArgs = z.object({ projectId: projectIdArg, runId: runIdArg });

/** `start_run` posts exactly this to `POST /runs` — a named workflow only (no inline steps, no
 *  variants, no attachments), with every bound the route itself enforces. */
export const startRunInputSchema = createRunInputBaseSchema
  .pick({ task: true, model: true, runner: true, agentProfile: true, worktree: true, autonomous: true })
  .extend({
    projectId: projectIdArg,
    workflow: createRunInputBaseSchema.shape.workflow.unwrap().describe('Workflow name from list_workflows (e.g. "quick-task").'),
    task: createRunInputBaseSchema.shape.task.describe('What the agent should do — the prompt.'),
  });

/** `POST /runs/:id/messages` takes text and attachments; the tool sends text only. */
const messageText = messageInputSchema.shape.text.unwrap();
/** The review panel's Send back prefixes the notes exactly like this (review-panel.tsx). */
export const REVIEW_FEEDBACK_PREFIX = 'Review feedback:\n';
/** Statuses `POST /messages` delivers or stacks a message in; anything else answers 409. */
const LIVE_STATUSES = new Set(['queued', 'running', 'waiting']);

// ---- outputs ---------------------------------------------------------------------------------

const warningsField = z
  .array(z.string())
  .optional()
  .describe('What this answer was made without (e.g. a cockpit port that did not answer) — it may come from the wrong cockpit.');

const projectsOutput = projectsResponseSchema.pick({ bootProject: true }).extend({
  warnings: warningsField,
  projects: z.array(projectListEntrySchema.pick({ id: true, name: true, root: true, status: true, branch: true })),
});

const workflowsOutput = z.object({
  workflows: z.array(
    workflowDefSchema
      .pick({ name: true, description: true, source: true })
      .extend({ steps: z.array(z.string()).describe('Step names, in order.') }),
  ),
  issues: z.array(workflowLoadIssueSchema).optional(),
  warnings: warningsField,
});

const runRowOutput = runIndexEntrySchema
  .pick({ projectId: true, id: true, workflow: true, branch: true, createdAt: true, finishedAt: true, costUsd: true })
  .extend({ title: z.string(), status: z.string(), activity: z.string().optional() });
const runsOutput = runsIndexResponseSchema.pick({ truncated: true }).extend({
  runs: z.array(runRowOutput),
  total: z.number().int(),
  more: z.number().int().optional(),
  warnings: warningsField,
});

/** What an orchestrating agent needs to decide its next step, without the transcript. */
const runStatusOutput = apiRunSchema
  .pick({
    id: true,
    title: true,
    titleSummary: true,
    workflow: true,
    branch: true,
    createdAt: true,
    startedAt: true,
    finishedAt: true,
    autoResumeAt: true,
    awaitingAnswerSince: true,
    currentStepId: true,
    error: true,
    pullRequestUrl: true,
    prNumber: true,
    costUsd: true,
  })
  .extend({
    projectId: z.string().describe('The project the run belongs to — pass it as projectId to address the run.'),
    status: z.string(),
    activity: z.string().optional(),
    warnings: warningsField,
  });
type RunStatusOutput = z.infer<typeof runStatusOutput>;

/** The whole record, long strings clipped; loose because the record grows with every release. */
const runOutput = apiRunSchema
  .pick({ id: true, title: true, workflow: true, task: true, createdAt: true })
  .extend({ projectId: z.string(), status: z.string(), warnings: warningsField })
  .loose();

const eventsOutput = runHistoryPageSchema.pick({ asOfSeq: true, olderCursor: true, newerCursor: true }).extend({
  events: z.array(runHistoryEventSchema).describe('Oldest first.'),
  gap: z
    .boolean()
    .optional()
    .describe('true: events between afterSeq and the first one returned were not read — page back with olderCursor.'),
  truncated: z.boolean().optional().describe('true: more events matched than fit in one answer — see nextAfterSeq / skippedAfterSeq.'),
  nextAfterSeq: z
    .number()
    .int()
    .optional()
    .describe('Newer events were left out: call again with afterSeq set to this (and the same cursor, if you passed one).'),
  skippedAfterSeq: z
    .number()
    .int()
    .optional()
    .describe('Older events of the newest page were left out: call with afterSeq set to this to read them.'),
  warnings: warningsField,
});

const waitOutput = z.object({
  runs: z.array(runStatusOutput.partial().extend({ id: z.string(), status: z.string() })),
  timedOut: z.boolean().describe('true: nothing settled in time — call wait_for_runs again.'),
  warnings: warningsField,
});

/** `/github/ref-status` answers a union; an MCP output schema must be one object, so it is the
 *  available branch with the unavailable branch's `reason` beside it. */
const [refStatusAvailable] = githubRefStatusDataSchema.options;
const prStatusOutput = refStatusAvailable
  .partial({ prs: true, issues: true })
  .extend({ available: z.boolean(), reason: z.string().optional(), warnings: warningsField });

const modelsOutput = runnerModelCatalogResponseSchema.extend({ warnings: warningsField });

const runRef = { projectId: z.string(), runId: z.string() };

const pushOutput = gitPushResponseSchema.extend({
  ...runRef,
  head: runCommitSchema
    .pick({ sha: true, subject: true })
    .optional()
    .describe("The branch's newest commit after the push — what the remote now has."),
  commits: z.number().int().optional().describe('Commits on the branch past its base.'),
  warnings: warningsField,
});

/** `/messages` answers a union; an MCP output schema must be one object, so its members are merged. */
const [delivered, queued, deferred] = messageResponseSchema.options;
const messageOutput = delivered
  .partial()
  .extend(queued.partial().shape)
  .extend(deferred.partial().shape)
  .extend({ ...runRef, status: z.string().describe('The run status the message was sent at.'), warnings: warningsField });

const reviewOutput = finishResponseSchema
  .partial()
  .extend(continueResponseSchema.partial().shape)
  .extend({
    ...runRef,
    decision: z.enum(['accept', 'send_back']),
    status: z.string().optional().describe('The run status right after the decision.'),
    warnings: warningsField,
  });

// ---- plumbing --------------------------------------------------------------------------------

const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function ok(data: Record<string, unknown>, warnings?: string[]): CallToolResult {
  const fitted = fitToBudget(warnings?.length ? { ...data, warnings } : data);
  return {
    content: [
      { type: 'text', text: JSON.stringify(fitted) },
      ...(warnings?.length ? [{ type: 'text' as const, text: `warning: ${warnings.join('; ')}` }] : []),
    ],
    structuredContent: fitted,
  };
}

const sizeOf = (value: unknown) => JSON.stringify(value).length;

/** Last-resort net under every answer: clip strings harder, then cap arrays, until it fits the
 *  budget. Tools that can grow by rows (list_runs, list_run_events) cut rows themselves first and
 *  say so in the answer; this only keeps a pathological record from flooding the client. */
export function fitToBudget<T>(data: T, budget = RESPONSE_BUDGET_CHARS): T {
  if (sizeOf(data) <= budget) return data;
  let fitted = data;
  for (const max of [1_000, 500, 200]) {
    fitted = clip(data, max);
    if (sizeOf(fitted) <= budget) return fitted;
  }
  for (const items of [20, 5, 1]) {
    fitted = capArrays(clip(data, 200), items);
    if (sizeOf(fitted) <= budget) return fitted;
  }
  return fitted;
}

function capArrays<T>(value: T, items: number): T {
  if (Array.isArray(value)) return value.slice(0, items).map((v: unknown) => capArrays(v, items)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, capArrays(v, items)])) as T;
  }
  return value;
}

function fail(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** One readable line for the model, whatever went wrong on the way to the cockpit. */
export function describeError(error: unknown): string {
  if (error instanceof CezarApiError) return `cezar refused: ${error.message}`;
  if (error instanceof z.ZodError) {
    const where = error.issues[0]?.path.join('.') || 'the answer';
    return `the cockpit answered in a shape this cez mcp does not recognize (at ${where}) — is it the same cezar version?`;
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') return 'the cezar cockpit did not answer in time';
    const cause = error.cause instanceof Error ? ` (${error.cause.message})` : '';
    if (isConnectionError(error)) return `cannot reach the cezar cockpit${cause}`;
    return error.message + cause;
  }
  return String(error);
}

/** Collapse long string values so one tool-call result or event can't flood the model's context. */
function clip<T>(value: T, max: number): T {
  if (typeof value === 'string') {
    return (value.length > max ? `${value.slice(0, max)}… [${value.length - max} more chars]` : value) as T;
  }
  if (Array.isArray(value)) return value.map((v: unknown) => clip(v, max)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clip(v, max)])) as T;
  }
  return value;
}

export function buildMcpServer(options: McpToolsOptions): McpServer {
  const server = new McpServer(
    { name: 'cezar', title: 'Cezar', version: options.version },
    {
      instructions:
        'Cezar runs AI agent tasks ("runs") in git worktrees. Start with list_projects / list_runs. ' +
        'start_run returns immediately with a run id; follow it with wait_for_runs (bounded — on timedOut, call it again) ' +
        'or get_run_status. ' +
        (options.readOnly
          ? 'Runs parked at "waiting" or "review" need a human in the cezar cockpit.'
          : 'A run parked at "waiting" takes an answer through send_run_message; one at "review" a decision through review_run. ' +
            'push_run_branch publishes its branch.'),
    },
  );
  const projectOf = (c: Cockpit, projectId: string | undefined) => projectId ?? c.defaultProjectId;
  const pollMs = options.pollIntervalMs ?? WAIT_POLL_MS;

  /** Run one tool body against the cockpit. A read that could not reach it is tried once more:
   *  the resolver has dropped the address by then, so a cockpit restarted on another port is
   *  found again. A write is never retried — the first attempt may have landed. */
  const call = async (
    fn: (c: Cockpit) => Promise<Record<string, unknown>>,
    { retry }: { retry: boolean },
  ): Promise<CallToolResult> => {
    const attempt = async () => {
      const c = await options.cockpit();
      return ok(await fn(c), c.warnings);
    };
    try {
      return await attempt();
    } catch (error) {
      if (retry && isConnectionError(error)) {
        try {
          return await attempt();
        } catch (again) {
          return fail(describeError(again));
        }
      }
      return fail(describeError(error));
    }
  };
  const read = (fn: (c: Cockpit) => Promise<Record<string, unknown>>) => call(fn, { retry: true });
  const write = (fn: (c: Cockpit) => Promise<Record<string, unknown>>) =>
    call(async (c) => {
      if (c.writeRefused) throw new Error(c.writeRefused);
      return fn(c);
    }, { retry: false });

  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description: 'Projects (repositories) this cezar cockpit serves, with their ids, roots and current branch.',
      outputSchema: projectsOutput,
      annotations: READ,
    },
    () => read(async ({ api }) => projectsOutput.parse(await readJson(await api.api.v1.projects.$get()))),
  );

  server.registerTool(
    'list_workflows',
    {
      title: 'List workflows',
      description: 'Workflows a run can be started with (start_run.workflow), with their steps.',
      inputSchema: z.object({ projectId: projectIdArg }),
      outputSchema: workflowsOutput,
      annotations: READ,
    },
    ({ projectId }) =>
      read(async (c) => {
        const body = await readJson(await c.api.api.v1.p[':projectId'].workflows.$get({ param: { projectId: projectOf(c, projectId) } }));
        return workflowsOutput.parse({
          workflows: body.workflows.map((w) => ({ ...w, steps: w.steps.map((s) => s.name ?? s.skill ?? s.id) })),
          ...(body.issues.length ? { issues: body.issues } : {}),
        });
      }),
  );

  server.registerTool(
    'list_models',
    {
      title: 'List models',
      description: 'Models the given agent runner can use on this host (start_run.model).',
      inputSchema: z.object({ runner: modelDiscoveryRunnerSchema.describe('Agent runner.') }),
      outputSchema: modelsOutput,
      // Discovery asks the vendor's own CLI, which may ask the vendor.
      annotations: { ...READ, openWorldHint: true },
    },
    ({ runner }) =>
      read(async ({ api }) => {
        const init = { signal: longDeadline(MODELS_TIMEOUT_MS) };
        return runnerModelCatalogResponseSchema.parse(await readJson(await api.api.v1.models.$get({ query: { runner } }, { init })));
      }),
  );

  server.registerTool(
    'list_runs',
    {
      title: 'List runs',
      description: 'Recent runs across all projects, newest first. Filter by project and status.',
      inputSchema: z.object({
        projectId: z.string().min(1).max(128).optional().describe('Only this project. Omit for all projects.'),
        status: z.array(runStatusSchema).max(7).optional().describe('Only runs in these statuses.'),
        includeArchived: z.boolean().optional().describe('Include archived runs (default false).'),
        limit: z.number().int().min(1).max(200).optional().describe('Max rows (default 20).'),
      }),
      outputSchema: runsOutput,
      annotations: READ,
    },
    ({ projectId, status, includeArchived, limit }) =>
      read(async ({ api }) => {
        const body = await readJson(await api.api.v1.workspace['runs-index'].$get());
        // Index rows carry real ids; `default` means the boot project, as on every other tool.
        const only = projectId === 'default' ? (await readJson(await api.api.v1.projects.$get())).bootProject : projectId;
        const wanted = status ? new Set<string>(status) : undefined;
        const rows = body.runs
          .filter((r) => (only ? r.projectId === only : true))
          .filter((r) => (wanted ? wanted.has(r.status) : true))
          .filter((r) => (includeArchived ? true : !r.archived))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const picked = rows.slice(0, limit ?? 20).map((r) => runRowOutput.parse(clip({ ...r, title: r.titleSummary ?? r.title }, 300)));
        // Rows past the budget become `more`, like rows past the limit.
        let room = RESPONSE_BUDGET_CHARS - sizeOf({ runs: [], total: rows.length, more: rows.length, truncated: body.truncated });
        const runs = picked.filter((r) => (room -= sizeOf(r) + 1) >= 0);
        return runsOutput.parse({
          runs,
          total: rows.length,
          ...(rows.length > runs.length ? { more: rows.length - runs.length } : {}),
          truncated: body.truncated,
        });
      }),
  );

  /** The project a run lives in, from the cross-project index, and the projects whose older runs
   *  the index — capped per project — leaves out. */
  const findRunProject = async (c: Cockpit, runId: string) => {
    const index = await readJson(await c.api.api.v1.workspace['runs-index'].$get());
    return { found: index.runs.find((r) => r.id === runId)?.projectId, capped: index.truncated };
  };
  const isNotFound = (error: unknown) => error instanceof CezarApiError && error.status === 404;
  const notFoundHint = (runId: string, error: CezarApiError, lookup?: { found?: string; capped: string[] }, choice?: string) => {
    const hint = !lookup
      ? `run ${runId} is not in the default project; pass its projectId (list_runs shows it)`
      : lookup.found
        ? `run ${runId} belongs to project "${lookup.found}"; pass projectId: "${lookup.found}"`
        : lookup.capped.length
          ? `run ${runId} is in no project's recent runs (older runs of ${lookup.capped.join(', ')} are not indexed) — check the id, or pass its projectId`
          : `no project of this cockpit has a run ${runId} — check the id (list_runs)`;
    const choose = choice && !lookup?.found ? `; this cockpit serves ${choice} — pass projectId to say which one holds it` : '';
    return new CezarApiError(404, `${error.message} — ${hint}${choose}`);
  };
  const projectChoice = async (c: Cockpit) => describeProjectChoice((await readJson(await c.api.api.v1.projects.$get())).projects);
  /**
   * Run `fn` against the run's project. Named: that one. Not named: the default project, and on a
   * 404 the project the cross-project index places the run in — a run id is global, so a read may
   * follow it. Writes pass `follow: false` and get the hint instead of a guess — with the
   * project list when the index cannot place the run.
   */
  const inRunProject = async <T>(
    c: Cockpit,
    projectId: string | undefined,
    runId: string,
    fn: (projectId: string) => Promise<T>,
    { follow = true }: { follow?: boolean } = {},
  ): Promise<T> => {
    if (projectId) return fn(projectId);
    try {
      return await fn(c.defaultProjectId);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      const lookup = await findRunProject(c, runId).catch(() => undefined);
      const found = lookup?.found;
      if (follow && found && found !== c.defaultProjectId) return fn(found);
      const choice = follow || found ? undefined : await projectChoice(c).catch(() => undefined);
      throw notFoundHint(runId, error as CezarApiError, lookup, choice);
    }
  };
  const readRun = async (c: Cockpit, projectId: string, runId: string, signal?: AbortSignal) =>
    readJson(await c.api.api.v1.p[':projectId'].runs[':id'].$get({ param: { projectId, id: runId } }, signal ? { init: { signal } } : undefined));
  /** The run record, with the project it was read from. */
  const getRun = (c: Cockpit, projectId: string | undefined, runId: string) =>
    inRunProject(c, projectId, runId, async (pid) => ({ ...(await readRun(c, pid, runId)), projectId: pid }));
  const statusOf = (run: object, projectId: string): RunStatusOutput => {
    const status = runStatusOutput.parse({ ...run, projectId });
    return { ...clip(status, 300), ...(status.error === undefined ? {} : { error: clip(status.error, 500) }) };
  };

  server.registerTool(
    'get_run',
    {
      title: 'Get run',
      description: 'The full run record: task, steps, branch, PR, usage. Long text fields are clipped.',
      inputSchema: runArgs,
      outputSchema: runOutput,
      annotations: READ,
    },
    ({ projectId, runId }) => read(async (c) => runOutput.parse(clip(await getRun(c, projectId, runId), 2_000))),
  );

  server.registerTool(
    'get_run_status',
    {
      title: 'Get run status',
      description: 'Compact status of one run — cheap to poll.',
      inputSchema: runArgs,
      outputSchema: runStatusOutput,
      annotations: READ,
    },
    ({ projectId, runId }) =>
      read(async (c) => {
        const run = await getRun(c, projectId, runId);
        return statusOf(run, run.projectId);
      }),
  );

  server.registerTool(
    'list_run_events',
    {
      title: 'List run events',
      description:
        'Transcript events of a run, oldest first, from one page (100 transcript items) at a time, capped at ' +
        `${RESPONSE_BUDGET_CHARS} characters per answer. Without arguments: the newest events. ` +
        'Remember asOfSeq and pass it back as afterSeq to read only what happened since; pass olderCursor / newerCursor ' +
        'from a previous answer to page. truncated: true means events were left out for size — continue with afterSeq: nextAfterSeq ' +
        '(plus the same cursor, if you passed one), or read the skipped older ones with afterSeq: skippedAfterSeq. ' +
        'Cursors are short-lived — a seq is what to keep between calls.',
      inputSchema: runArgs.extend({
        cursor: runHistoryCursorSchema.optional().describe('olderCursor or newerCursor from a previous call.'),
        afterSeq: z.number().int().nonnegative().optional().describe('Only events with a seq greater than this.'),
        maxChars: z.number().int().min(100).max(20_000).optional().describe('Clip each text field to this (default 1000).'),
        maxEvents: z
          .number()
          .int()
          .min(1)
          .max(EVENTS_MAX)
          .optional()
          .describe(`At most this many events (default ${EVENTS_DEFAULT_MAX}). The answer is also capped at ${RESPONSE_BUDGET_CHARS} characters.`),
      }),
      outputSchema: eventsOutput,
      annotations: READ,
    },
    ({ projectId, runId, cursor, afterSeq, maxChars, maxEvents }) =>
      read((c) =>
        inRunProject(c, projectId, runId, async (pid) => {
          const param = { projectId: pid, id: runId };
          const page = async (at?: string) =>
            readJson(await c.api.api.v1.p[':projectId'].runs[':id'].history.$get({ param, query: at ? { cursor: at } : {} }));
          const first = await page(cursor);
          const bySeq = new Map(first.events.map((e) => [e.seq, e]));
          let olderCursor = first.hasOlder ? first.olderCursor : undefined;
          let coveredFrom = pageStart(first.events);
          // Every event from `coveredFrom` on has been read, so the range is reached once it is at
          // most `afterSeq + 1` (seqs are integers).
          const covers = () => afterSeq === undefined || coveredFrom <= afterSeq + 1;
          // `/history` has no `afterSeq` yet (a separate PR, #1109): walk back from the tip, bounded,
          // until a page starts at or below `afterSeq`.
          if (afterSeq !== undefined && cursor === undefined) {
            for (let walked = 0; olderCursor && !covers() && walked < EVENTS_MAX_WALK_PAGES; walked += 1) {
              const older = await page(olderCursor);
              for (const e of older.events) bySeq.set(e.seq, e);
              coveredFrom = Math.min(coveredFrom, pageStart(older.events));
              olderCursor = older.hasOlder ? older.olderCursor : undefined;
            }
          }
          const reached = covers() || !olderCursor;
          const events = [...bySeq.values()]
            // With a gap, a page's leading turn opener sits below the read range — drop it, so
            // "between afterSeq and the first event" is exactly what is left unread.
            .filter((e) => (afterSeq === undefined ? true : e.seq > afterSeq && (reached || e.seq >= coveredFrom)))
            .sort((a, b) => a.seq - b.seq)
            .map((e) => clip(e, maxChars ?? 1_000));
          const envelope = {
            asOfSeq: first.asOfSeq,
            ...(olderCursor && (afterSeq === undefined || !reached) ? { olderCursor } : {}),
            ...(first.newerCursor ? { newerCursor: first.newerCursor } : {}),
            ...(reached ? {} : { gap: true }),
          };
          // Without a position, the caller asked for the newest: keep the tail and name where the
          // cut-off head starts. With one, keep the head and name where to continue.
          const newest = afterSeq === undefined && cursor === undefined;
          const kept = fitEvents(newest ? [...events].reverse() : events, {
            max: maxEvents ?? EVENTS_DEFAULT_MAX,
            room: RESPONSE_BUDGET_CHARS - sizeOf({ ...envelope, events: [], truncated: true, nextAfterSeq: first.asOfSeq, skippedAfterSeq: first.asOfSeq }),
          });
          if (newest) kept.reverse();
          const cut = events.length - kept.length;
          return eventsOutput.parse({
            ...envelope,
            events: kept,
            ...(cut > 0 ? { truncated: true } : {}),
            ...(cut > 0 && !newest ? { nextAfterSeq: kept.at(-1)!.seq } : {}),
            ...(cut > 0 && newest ? { skippedAfterSeq: pageStart(events.slice(0, cut)) - 1 } : {}),
          });
        }),
      ),
  );

  server.registerTool(
    'wait_for_runs',
    {
      title: 'Wait for runs',
      description:
        `Wait until runs settle (done, failed, cancelled, or parked at waiting/review) or the timeout ` +
        `(max ${WAIT_MAX_SECONDS} s) passes, then answer with their status. mode "any" returns at the first settled run — ` +
        'at once if one already is — and "all" when every one has. "failed" settles a run even when autoResumeAt is set ' +
        '(a usage limit: cezar resumes it at that time on its own, so wait again after it). On timedOut: true, just call it again.',
      inputSchema: z.object({
        projectId: projectIdArg,
        runIds: z.array(runIdArg).min(1).max(20),
        mode: z.enum(['any', 'all']).optional().describe('Default "any".'),
        timeoutSeconds: z
          .number()
          .int()
          .min(1)
          .max(WAIT_MAX_SECONDS)
          .optional()
          .describe(`Default ${WAIT_DEFAULT_SECONDS}.`),
      }),
      outputSchema: waitOutput,
      annotations: READ,
    },
    // Not retried: a second wait would carry the call past the client's own tool timeout. The
    // dropped address is still re-discovered on the next call.
    ({ projectId, runIds, mode, timeoutSeconds }, ctx) => {
      const found = new Map<string, string>();
      return call((c) =>
        waitForRuns(ctx, {
          runIds: [...new Set(runIds)],
          mode: mode ?? 'any',
          timeoutMs: (timeoutSeconds ?? WAIT_DEFAULT_SECONDS) * 1000,
          pollMs,
          // A followed run's project is looked up once, not on every poll.
          fetchRun: (id, signal) =>
            inRunProject(c, projectId ?? found.get(id), id, async (pid) => {
              const run = await readRun(c, pid, id, signal);
              found.set(id, pid);
              return statusOf(run, pid);
            }),
        }),
        { retry: false },
      );
    },
  );

  server.registerTool(
    'get_pr_status',
    {
      title: 'Get PR status',
      description: "Status (open/merged/closed, checks, review) of pull requests and issues in a project's GitHub repository.",
      inputSchema: z.object({
        projectId: projectIdArg,
        prs: z.array(z.number().int().positive()).max(REFERENCE_STATUS_MAX).optional(),
        issues: z.array(z.number().int().positive()).max(REFERENCE_STATUS_MAX).optional(),
      }),
      outputSchema: prStatusOutput,
      annotations: { ...READ, openWorldHint: true },
    },
    ({ projectId, prs, issues }) =>
      read(async (c) => {
        if (!prs?.length && !issues?.length) throw new Error('name at least one pr or issue number');
        const query = {
          ...(prs?.length ? { prs: prs.join(',') } : {}),
          ...(issues?.length ? { issues: issues.join(',') } : {}),
        };
        return prStatusOutput.parse(
          await readJson(await c.api.api.v1.p[':projectId'].github['ref-status'].$get({ param: { projectId: projectOf(c, projectId) }, query })),
        );
      }),
  );

  if (options.readOnly) return server;

  server.registerTool(
    'start_run',
    {
      title: 'Start run',
      description:
        'Start an agent run from a named workflow (list_workflows). Returns at once with the run id — ' +
        'the agent works in the background; follow it with wait_for_runs or get_run_status. Costs agent usage.',
      inputSchema: startRunInputSchema,
      outputSchema: runStatusOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ projectId, ...body }) =>
      write(async (c) => {
        if (!projectId && c.projectUnknown) throw new Error(c.projectUnknown);
        const pid = projectOf(c, projectId);
        return statusOf(await readJson(await c.api.api.v1.p[':projectId'].runs.$post({ param: { projectId: pid }, json: body })), pid);
      }),
  );

  server.registerTool(
    'cancel_run',
    {
      title: 'Cancel run',
      description: 'Stop a queued or running run. Its agent is killed; the worktree is kept. cancelled: false means it had already settled.',
      inputSchema: runArgs,
      outputSchema: cancelResponseSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ projectId, runId }) =>
      write(async (c) =>
        cancelResponseSchema.parse(
          await inRunProject(
            c,
            projectId,
            runId,
            async (pid) => readJson(await c.api.api.v1.p[':projectId'].runs[':id'].cancel.$post({ param: { projectId: pid, id: runId } })),
            { follow: false },
          ),
        ),
      ),
  );

  /** The run a write targets, read first so the tool can check its status — never followed into
   *  another project (`inRunProject`). */
  const runForWrite = (c: Cockpit, projectId: string | undefined, runId: string) =>
    inRunProject(c, projectId, runId, async (pid) => ({ pid, run: await readRun(c, pid, runId) }), { follow: false });
  const statusNow = async (c: Cockpit, pid: string, runId: string) => (await readRun(c, pid, runId).catch(() => undefined))?.status;
  /** `/continue` starts the session asynchronously, so the record reads `review` for a moment
   *  after it answers — and a `wait_for_runs` then would return that stale `review` at once. Wait,
   *  bounded, until the send-back's step has started; its status is then the honest answer. */
  const sentBackStatus = async (c: Cockpit, pid: string, runId: string) => {
    let status: string | undefined;
    for (let i = 0; i < SEND_BACK_POLLS; i += 1) {
      const run = await readRun(c, pid, runId).catch(() => undefined);
      if (!run) return status;
      status = run.status;
      const step = [...run.steps].reverse().find((s) => s.id.startsWith('continue-'));
      if (status !== 'review' || (step && step.status !== 'pending')) return status;
      await sleep(pollMs / 8);
    }
    return status;
  };

  server.registerTool(
    'push_run_branch',
    {
      title: 'Push run branch',
      description:
        "Push the run's worktree branch to its remote — the cockpit's Push button (POST /runs/:id/git/push). " +
        'Commits only what is already committed, sets the upstream on the first push, and never force-pushes: ' +
        'a rejection (the remote has commits the branch lacks) is returned as an error, not retried. ' +
        'The remote is the cockpit\'s own choice (its push remote, usually origin). Answers with the branch, remote and newest commit.',
      inputSchema: runArgs,
      outputSchema: pushOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ projectId, runId }) =>
      write(async (c) => {
        const { pid } = await runForWrite(c, projectId, runId);
        const param = { projectId: pid, id: runId };
        const pushed = await readJson(await c.api.api.v1.p[':projectId'].runs[':id'].git.push.$post({ param })).catch((error: unknown) => {
          throw describePushRefusal(error);
        });
        // The route names no commit; the branch log does. Best-effort: the push itself has landed.
        const log = await c.api.api.v1.p[':projectId'].runs[':id'].commits
          .$get({ param })
          .then((res) => readJson(res))
          .then((body) => runCommitsResponseSchema.parse(body).commits)
          .catch(() => undefined);
        const [head] = log ?? [];
        return pushOutput.parse({
          ...gitPushResponseSchema.parse(pushed),
          projectId: pid,
          runId,
          ...(head ? { head: { sha: head.sha, subject: clip(head.subject, 300) } } : {}),
          ...(log ? { commits: log.length } : {}),
        });
      }),
  );

  server.registerTool(
    'send_run_message',
    {
      title: 'Send run message',
      description:
        "Answer a run — the cockpit's composer (POST /runs/:id/messages). At \"waiting\" (the agent asked or finished a turn) " +
        'the text goes into its open session and the run works again; at "running" it reaches the agent mid-turn; at ' +
        '"queued" it is added to the prompt. Any other status is an error: it never reopens a finished run, and a run at ' +
        '"review" takes review_run instead. The agent acts on the message — it costs agent usage.',
      inputSchema: runArgs.extend({ text: messageText.trim().min(1).describe('The message, as the user would type it.') }),
      outputSchema: messageOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ projectId, runId, text }) =>
      write(async (c) => {
        const { pid, run } = await runForWrite(c, projectId, runId);
        if (!LIVE_STATUSES.has(run.status)) throw new Error(notLive(runId, run.status));
        const param = { projectId: pid, id: runId };
        const answer = await readJson(await c.api.api.v1.p[':projectId'].runs[':id'].messages.$post({ param, json: { text } })).catch(
          async (error: unknown) => {
            // The session closed between the read and the post.
            if (error instanceof CezarApiError && error.status === 409) {
              const now = await statusNow(c, pid, runId);
              throw new Error(`${describeError(error)}${now ? ` — ${notLive(runId, now)}` : ''}`);
            }
            throw error;
          },
        );
        return messageOutput.parse({ ...messageResponseSchema.parse(answer), projectId: pid, runId, status: run.status });
      }),
  );

  server.registerTool(
    'review_run',
    {
      title: 'Review run',
      description:
        'Decide on a run parked at "review" — the cockpit\'s review gate. ' +
        '"accept" (✓ Accept, POST /runs/:id/finish) only marks the run done: nothing is merged, committed, pushed or opened as a PR, ' +
        'and the worktree and branch stay as they are — publish with push_run_branch. ' +
        '"send_back" (↩ Send back, POST /runs/:id/continue) sends notes into the agent\'s session prefixed "Review feedback:"; ' +
        'the agent works on them (costs agent usage) and parks again at waiting or review; the answer comes once the agent ' +
        'has picked them up (at most ~5 s). ' +
        'Any status other than "review" is an error.',
      inputSchema: runArgs.extend({
        decision: z.enum(['accept', 'send_back']).describe('"accept" or "send_back".'),
        notes: messageText
          .max(messageText.maxLength! - REVIEW_FEEDBACK_PREFIX.length)
          .optional()
          .describe('What to change — required for send_back, refused with accept.'),
      }),
      outputSchema: reviewOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ projectId, runId, decision, notes }) =>
      write(async (c) => {
        const feedback = notes?.trim();
        if (decision === 'send_back' && !feedback) throw new Error('send_back needs notes: write what to change');
        if (decision === 'accept' && feedback) throw new Error('accept takes no notes — use send_back to send them to the agent');
        const { pid, run } = await runForWrite(c, projectId, runId);
        if (run.status !== 'review') throw new Error(`run ${runId} is ${run.status}, not review — review_run only decides at the review gate`);
        const param = { projectId: pid, id: runId };
        const route = c.api.api.v1.p[':projectId'].runs[':id'];
        // Both routes refuse (409, nothing changed) while the engine still holds a run that reads
        // `review` — a send-back that has not started yet, or one still settling.
        const busy = (error: unknown) => {
          if (!(error instanceof CezarApiError) || error.status !== 409) throw error;
          throw new Error(`${describeError(error)} — the run is still being resumed or settled; wait_for_runs, then decide again`);
        };
        const answer =
          decision === 'accept'
            ? finishResponseSchema.parse(await readJson(await route.finish.$post({ param })).catch(busy))
            : continueResponseSchema.parse(
                await readJson(await route.continue.$post({ param, json: { text: `${REVIEW_FEEDBACK_PREFIX}${feedback}` } })).catch(busy),
              );
        const status = decision === 'accept' ? await statusNow(c, pid, runId) : await sentBackStatus(c, pid, runId);
        return reviewOutput.parse({ ...answer, projectId: pid, runId, decision, ...(status ? { status } : {}) });
      }),
  );

  return server;
}

function notLive(runId: string, status: string): string {
  const next =
    status === 'review'
      ? 'decide with review_run'
      : 'it is finished — cez mcp does not reopen finished runs (the cockpit\'s Continue does)';
  return `run ${runId} is ${status}: send_run_message reaches only a waiting, running or queued run — ${next}`;
}

/** A refused push, in words the model can act on. Rejections are never retried — that would
 *  take a force. A cockpit before this fix reports only git's `To <url>` line. */
function describePushRefusal(error: unknown): unknown {
  if (!(error instanceof CezarApiError) || error.status !== 409) return error;
  if (/non-fast-forward|fetch first|\[rejected\]/.test(error.message)) {
    return new Error(
      `${describeError(error)} — the remote branch has commits this branch lacks (non-fast-forward). ` +
        'cez mcp does not force-push: have the run merge the remote branch (send_run_message), then push again',
    );
  }
  if (/^\d+: To /.test(error.message)) {
    return new Error(
      `${describeError(error)} — the remote refused the push (this cockpit reports only the destination line; ` +
        'usually the remote branch has commits this branch lacks). cez mcp does not force-push',
    );
  }
  return error;
}

/**
 * Where a `/history` page's own range begins. A page leads with the opener of the turn it starts
 * in (`pageEventSlice`, event-history.ts), which can sit far below the rest of the page; counting
 * from it would claim events that were never read. Seqs have gaps (ephemeral deltas), so the
 * range cannot be inferred from contiguity either. When the page's first item IS a turn opener,
 * this under-claims by one event — costing at most one extra page, never a missed one.
 */
function pageStart(events: ReadonlyArray<{ seq: number; type: string }>): number {
  const [head, next] = events;
  if (!head) return Number.POSITIVE_INFINITY;
  return next && (head.type === 'user-message' || head.type === 'turn.started') ? next.seq : head.seq;
}

/** Take events in the given order until `max` or the character room runs out. The first event is
 *  always taken, clipped harder if it must be, so a continuation can never stall on it. */
function fitEvents<E>(events: E[], { max, room }: { max: number; room: number }): E[] {
  const kept: E[] = [];
  for (const event of events) {
    if (kept.length >= max) break;
    let item = event;
    if (kept.length === 0) {
      for (const at of [500, 200, 100]) {
        if (sizeOf(item) + 1 <= room) break;
        item = clip(event, at);
      }
    }
    const cost = sizeOf(item) + 1;
    if (kept.length > 0 && cost > room) break;
    kept.push(item);
    room -= cost;
  }
  return kept;
}

interface WaitInput {
  runIds: string[];
  mode: 'any' | 'all';
  timeoutMs: number;
  pollMs: number;
  fetchRun: (runId: string, signal: AbortSignal) => Promise<RunStatusOutput>;
}

/**
 * Poll `GET /runs/:id` — at once, then every `pollMs` — until `mode` is satisfied or the timeout
 * passes (#1109). Polling, not the SSE stream: nothing is held open on the cockpit side, and one
 * `AbortController` ends the wait whichever comes first, the timeout or the client's cancel.
 */
async function waitForRuns(ctx: ServerContext, input: WaitInput): Promise<z.infer<typeof waitOutput>> {
  const latest = new Map<string, RunStatusOutput>();
  const abort = new AbortController();
  const clientSignal = ctx.mcpReq.signal;
  const onClientAbort = () => abort.abort(clientSignal.reason);
  if (clientSignal.aborted) abort.abort(clientSignal.reason);
  else clientSignal.addEventListener('abort', onClientAbort, { once: true });
  const timer = setTimeout(() => abort.abort(new DOMException('wait_for_runs timed out', 'TimeoutError')), input.timeoutMs);
  const progressToken = ctx.mcpReq._meta?.progressToken;
  const settledCount = () => input.runIds.filter((id) => SETTLED.has(latest.get(id)?.status ?? '')).length;
  const satisfied = () => (input.mode === 'any' ? settledCount() > 0 : settledCount() === input.runIds.length);

  try {
    for (let poll = 1; ; poll += 1) {
      const runs = await Promise.all(input.runIds.map((id) => input.fetchRun(id, abort.signal)));
      for (const run of runs) latest.set(run.id, run);
      if (progressToken !== undefined) {
        const message = runs.map((r) => `${r.id}: ${r.status}`).join(', ');
        await ctx.mcpReq
          .notify({ method: 'notifications/progress', params: { progressToken, progress: poll, message } })
          .catch(() => {});
      }
      if (satisfied()) break;
      await sleep(input.pollMs, undefined, { signal: abort.signal });
    }
  } catch (error) {
    // Our own abort (timeout or the client's cancel) ends the wait with what is known; anything
    // else — a 404, an unreachable cockpit — is the tool's error.
    if (!abort.signal.aborted) throw error;
  } finally {
    clearTimeout(timer);
    clientSignal.removeEventListener('abort', onClientAbort);
    // A failed poll leaves its siblings in flight — end them with the wait.
    abort.abort();
  }
  return {
    runs: input.runIds.map((id) => latest.get(id) ?? { id, status: 'unknown' }),
    timedOut: !satisfied(),
  };
}
