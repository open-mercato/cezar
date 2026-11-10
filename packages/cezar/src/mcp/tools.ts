/**
 * The `cez mcp` tool set (spec 2026-11-08-cez-mcp, #1109): each tool is one call to an existing
 * `/api/v1` route, its answer parsed through an output schema cut from the contract. Read-only
 * mode does not register the write tools at all. Statuses are widened to strings, as in `cez runs`.
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { McpServer, type CallToolResult, type ToolAnnotations, type ToolContext } from './jsonrpc.ts';
import { z } from 'zod';
import {
  apiRunSchema,
  cancelResponseSchema,
  continueResponseSchema,
  createRunInputBaseSchema,
  finishResponseSchema,
  gitPushResponseSchema,
  messageInputSchema,
  messageResponseSchema,
  modelDiscoveryRunnerSchema,
  projectListEntrySchema,
  projectsResponseSchema,
  runHistoryCursorSchema,
  runHistoryEventSchema,
  runHistoryPageSchema,
  runIdParamSchema,
  runIndexEntrySchema,
  runnerModelCatalogResponseSchema,
  runsIndexResponseSchema,
  runStatusSchema,
  workflowDefSchema,
  workflowLoadIssueSchema,
} from '@open-mercato/cezar-contract';
import { CezarApiError, isConnectionError, longDeadline, readJson, withCallSignal, type CezarClient } from './api.ts';

/** A reachable cockpit: its client, and the project a tool call targets when it names none. */
export interface Cockpit {
  api: CezarClient;
  defaultProjectId: string;
  /** Set when no project is known to hold the cwd: why `start_task` needs a `projectId`. */
  projectUnknown?: string;
}

export interface McpToolsOptions {
  /** Resolves the cockpit lazily — stdio discovers it on first use, not at spawn. */
  cockpit: () => Promise<Cockpit>;
  version: string;
  /** Register only the read-only tools. */
  readOnly?: boolean;
  /** Running inside a cezar task: read-only, and sub-tasks go through `cez task create`. */
  insideTask?: boolean;
  /** `wait_for_tasks` poll interval; tests shorten it. */
  pollIntervalMs?: number;
}

/** Statuses at which a run stops needing nobody: finished, or parked on the user. */
const SETTLED = new Set(['done', 'failed', 'cancelled', 'waiting', 'review']);
/** Codex cuts a tool call at 60 s by default; stay under it with room for the round trip. */
export const WAIT_MAX_SECONDS = 45;
export const WAIT_DEFAULT_SECONDS = 40;
export const WAIT_POLL_MS = 2_000;
/** review_task send_back waits for its continuation to start for at most this many reads, `WAIT_POLL_MS / 8` apart (~5 s). */
const SEND_BACK_POLLS = 20;
/** `GET /models` may ask a vendor CLI first, bounded at 15 s server-side — past the 10 s default. */
const MODELS_TIMEOUT_MS = 30_000;
/** Without `afterSeq` on `/history`, catching up walks back at most this many pages (100 items each). */
export const EVENTS_MAX_WALK_PAGES = 5;
/** One answer, serialized: it travels twice (text + structuredContent), and Claude Code refuses ~25k tokens. */
export const RESPONSE_BUDGET_CHARS = 40_000;
export const EVENTS_DEFAULT_MAX = 200;
export const EVENTS_MAX = 500;

const projectIdArg = z.string().min(1).max(128).optional().describe('Project id from list_projects. Omit for the default project.');
const runIdArg = runIdParamSchema.shape.id.describe('Task id (from list_tasks or start_task).');
const runArgs = z.object({ projectId: projectIdArg, taskId: runIdArg });

/** `start_task` posts exactly this to `POST /runs`: a named workflow, with the route's own bounds. */
export const startRunInputSchema = createRunInputBaseSchema
  .pick({ task: true, model: true, runner: true, agentProfile: true, worktree: true, autonomous: true })
  .extend({
    projectId: projectIdArg,
    workflow: createRunInputBaseSchema.shape.workflow.unwrap().describe('Workflow name from list_workflows (e.g. "quick-task").'),
    task: createRunInputBaseSchema.shape.task.trim().min(1).describe('What the agent should do — the prompt.'),
    worktree: createRunInputBaseSchema.shape.worktree.describe(
      'Default true (own git worktree). false: work in the repository checkout itself — finishing such a task may commit ' +
        'to the base branch, so review_task will not accept it (the cockpit does).',
    ),
  });

/** `POST /runs/:id/messages` takes text and attachments; the tool sends text only. */
const messageText = messageInputSchema.shape.text.unwrap();
/** The review panel's Send back prefixes the notes exactly like this (review-panel.tsx). */
export const REVIEW_FEEDBACK_PREFIX = 'Review feedback:\n';
/** Statuses `POST /messages` delivers or stacks a message in; anything else answers 409. */
const LIVE_STATUSES = new Set(['queued', 'running', 'waiting']);

const projectsOutput = projectsResponseSchema.pick({ bootProject: true }).extend({
  projects: z.array(projectListEntrySchema.pick({ id: true, name: true, root: true, status: true, branch: true })),
});

const workflowsOutput = z.object({
  workflows: z.array(workflowDefSchema.pick({ name: true, description: true, source: true }).extend({ steps: z.array(z.string()).describe('Step names, in order.') })),
  issues: z.array(workflowLoadIssueSchema).optional(),
});

const runRowOutput = runIndexEntrySchema
  .pick({ projectId: true, id: true, workflow: true, branch: true, createdAt: true, finishedAt: true, costUsd: true, idleClosedAt: true })
  .extend({ title: z.string(), status: z.string(), activity: z.string().optional() });
const runsOutput = runsIndexResponseSchema.pick({ truncated: true }).extend({
  tasks: z.array(runRowOutput),
  total: z.number().int(),
  more: z.number().int().optional(),
});

/** What an orchestrating agent needs to decide its next step, without the transcript. */
const runStatusOutput = apiRunSchema
  .pick({
    id: true, title: true, titleSummary: true, workflow: true, branch: true, createdAt: true, startedAt: true, finishedAt: true,
    autoResumeAt: true, awaitingAnswerSince: true, idleClosedAt: true, currentStepId: true, error: true, pullRequestUrl: true,
    prNumber: true, costUsd: true,
  })
  .extend({
    projectId: z.string().describe('The project the task belongs to — pass it as projectId to address the task.'),
    status: z.string(),
    activity: z.string().optional().describe('"closed · idle": the failed status is a session closed after inactivity, not an error.'),
  });
type RunStatusOutput = z.infer<typeof runStatusOutput>;

/** The whole record, long strings clipped; loose because the record grows with every release. */
const runOutput = apiRunSchema
  .pick({ id: true, title: true, workflow: true, task: true, createdAt: true })
  .extend({ projectId: z.string(), status: z.string() })
  .loose();

const eventsOutput = runHistoryPageSchema.pick({ asOfSeq: true, olderCursor: true, newerCursor: true }).extend({
  events: z.array(runHistoryEventSchema).describe('Oldest first.'),
  gap: z.boolean().optional().describe('true: events between afterSeq and the first one returned were not read — page back with olderCursor.'),
  truncated: z.boolean().optional().describe('true: more events matched than fit in one answer — see nextAfterSeq / skippedAfterSeq.'),
  nextAfterSeq: z.number().int().optional().describe('Newer events were left out: call again with afterSeq set to this (and the same cursor, if you passed one).'),
  skippedAfterSeq: z.number().int().optional().describe('Older events of the newest page were left out: call with afterSeq set to this to read them.'),
});

const waitOutput = z.object({
  tasks: z.array(runStatusOutput.partial().extend({ id: z.string(), status: z.string() })),
  timedOut: z.boolean().describe('true: nothing settled in time — call wait_for_tasks again.'),
});

const runRef = { projectId: z.string(), taskId: z.string() };
const pushOutput = gitPushResponseSchema.extend(runRef);

/** `/messages` answers a union; an MCP output schema must be one object, so its members are merged. */
const [delivered, queued, deferred] = messageResponseSchema.options;
const messageOutput = delivered
  .partial()
  .extend(queued.partial().shape)
  .extend(deferred.partial().shape)
  .extend({ ...runRef, status: z.string().describe('The task status the message was sent at.') });

const reviewOutput = finishResponseSchema
  .partial()
  .extend(continueResponseSchema.partial().shape)
  .extend({ ...runRef, decision: z.enum(['accept', 'send_back']), status: z.string().optional().describe('The task status right after the decision.') });

/** How the cockpit reads a `failed` task the inactivity timer closed (spec 2026-11-04-idle-closed-attention-state). */
const IDLE_CLOSED = 'closed · idle';
function withIdle<T extends { status: string; idleClosedAt?: string | undefined; activity?: string | undefined }>(run: T): T {
  return run.status === 'failed' && run.idleClosedAt ? { ...run, activity: IDLE_CLOSED } : run;
}

const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function ok(data: Record<string, unknown>): CallToolResult {
  const fitted = fitToBudget(data);
  return { content: [{ type: 'text', text: JSON.stringify(fitted) }], structuredContent: fitted };
}

const sizeOf = (value: unknown) => JSON.stringify(value).length;

/** Last-resort net under every answer: clip strings harder, then cap arrays, until it fits. Tools
 *  that grow by rows (list_tasks, list_task_events) cut rows themselves first and say so. */
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

function instructionsFor(options: McpToolsOptions, readOnly: boolean): string {
  const base =
    'Cezar runs AI agent tasks in git worktrees. Start with list_projects / list_tasks. ' +
    'Follow a task with wait_for_tasks (bounded — on timedOut, call it again) or get_task_status. ';
  if (options.insideTask) {
    return (
      base +
      'This cez mcp runs inside a cezar task, so it is read-only: start a sub-task with `cez task create` ' +
      '(dispatch, whose limits and budget apply), not through MCP.'
    );
  }
  if (readOnly) return `${base}Tasks parked at "waiting" or "review" need a human in the cezar cockpit.`;
  return (
    `${base}start_task returns at once with a task id. ` +
    'A task parked at "waiting" takes an answer through send_task_message; one at "review" a decision through review_task. ' +
    'push_task_branch publishes its branch.'
  );
}

export function buildMcpServer(options: McpToolsOptions): McpServer {
  const readOnly = Boolean(options.readOnly || options.insideTask);
  const server = new McpServer({ name: 'cezar', title: 'Cezar', version: options.version }, instructionsFor(options, readOnly));
  const projectOf = (c: Cockpit, projectId: string | undefined) => projectId ?? c.defaultProjectId;
  const pollMs = options.pollIntervalMs ?? WAIT_POLL_MS;

  /** One tool body against the cockpit, every request bound to the call's cancel. A read that
   *  could not reach the cockpit is tried once more (rediscovered); a write never is. */
  const call = async (
    ctx: ToolContext,
    fn: (c: Cockpit) => Promise<Record<string, unknown>>,
    { retry }: { retry: boolean },
  ): Promise<CallToolResult> => {
    const attempt = () => withCallSignal(ctx.signal, async () => ok(await fn(await options.cockpit())));
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
  const read = (ctx: ToolContext, fn: (c: Cockpit) => Promise<Record<string, unknown>>) => call(ctx, fn, { retry: true });
  const write = (ctx: ToolContext, fn: (c: Cockpit) => Promise<Record<string, unknown>>) => call(ctx, fn, { retry: false });

  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description: 'Projects (repositories) this cezar cockpit serves, with their ids, roots and current branch.',
      outputSchema: projectsOutput,
      annotations: READ,
    },
    async (_args, ctx) => read(ctx, async ({ api }) => projectsOutput.parse(await readJson(await api.api.v1.projects.$get()))),
  );

  server.registerTool(
    'list_workflows',
    {
      title: 'List workflows',
      description: 'Workflows a task can be started with (start_task.workflow), with their steps.',
      inputSchema: z.object({ projectId: projectIdArg }),
      outputSchema: workflowsOutput,
      annotations: READ,
    },
    ({ projectId }, ctx) =>
      read(ctx, async (c) => {
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
      description: 'Models the given agent runner can use on this host (start_task.model).',
      inputSchema: z.object({ runner: modelDiscoveryRunnerSchema.describe('Agent runner.') }),
      outputSchema: runnerModelCatalogResponseSchema,
      // Discovery asks the vendor's own CLI, which may ask the vendor.
      annotations: { ...READ, openWorldHint: true },
    },
    ({ runner }, ctx) =>
      read(ctx, async ({ api }) => {
        const init = { signal: longDeadline(MODELS_TIMEOUT_MS) };
        return runnerModelCatalogResponseSchema.parse(await readJson(await api.api.v1.models.$get({ query: { runner } }, { init })));
      }),
  );

  server.registerTool(
    'list_tasks',
    {
      title: 'List tasks',
      description: 'Recent tasks across all projects, newest first. Filter by project and status.',
      inputSchema: z.object({
        projectId: z.string().min(1).max(128).optional().describe('Only this project. Omit for all projects.'),
        status: z.array(runStatusSchema).max(7).optional().describe('Only tasks in these statuses.'),
        includeArchived: z.boolean().optional().describe('Include archived tasks (default false).'),
        limit: z.number().int().min(1).max(200).optional().describe('Max rows (default 20).'),
      }),
      outputSchema: runsOutput,
      annotations: READ,
    },
    ({ projectId, status, includeArchived, limit }, ctx) =>
      read(ctx, async ({ api }) => {
        const body = await readJson(await api.api.v1.workspace['runs-index'].$get());
        // Index rows carry real ids; `default` means the boot project, as on every other tool.
        const only = projectId === 'default' ? (await readJson(await api.api.v1.projects.$get())).bootProject : projectId;
        const wanted = status ? new Set<string>(status) : undefined;
        const rows = body.runs
          .filter((r) => (only ? r.projectId === only : true))
          .filter((r) => (wanted ? wanted.has(r.status) : true))
          .filter((r) => (includeArchived ? true : !r.archived))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const picked = rows
          .slice(0, limit ?? 20)
          .map((r) => runRowOutput.parse(clip(withIdle({ ...r, title: r.titleSummary ?? r.title }), 300)));
        // Rows past the budget become `more`, like rows past the limit.
        let room = RESPONSE_BUDGET_CHARS - sizeOf({ tasks: [], total: rows.length, more: rows.length, truncated: body.truncated });
        const tasks = picked.filter((r) => (room -= sizeOf(r) + 1) >= 0);
        return runsOutput.parse({
          tasks,
          total: rows.length,
          ...(rows.length > tasks.length ? { more: rows.length - tasks.length } : {}),
          truncated: body.truncated,
        });
      }),
  );

  /** Run `fn` in the task's project — the named one, else the default; a 404 there says to name it. */
  const inProject = async <T>(c: Cockpit, projectId: string | undefined, taskId: string, fn: (pid: string) => Promise<T>): Promise<T> => {
    try {
      return await fn(projectOf(c, projectId));
    } catch (error) {
      if (projectId || !(error instanceof CezarApiError) || error.status !== 404) throw error;
      throw new CezarApiError(
        404,
        `${error.message} — task ${taskId} is not in the default project "${c.defaultProjectId}"; pass its projectId (list_tasks shows it)`,
      );
    }
  };
  const readRun = async (c: Cockpit, projectId: string, taskId: string, signal?: AbortSignal) =>
    readJson(await c.api.api.v1.p[':projectId'].runs[':id'].$get({ param: { projectId, id: taskId } }, signal ? { init: { signal } } : undefined));
  const statusOf = (run: object, projectId: string): RunStatusOutput => {
    const status = withIdle(runStatusOutput.parse({ ...run, projectId }));
    return { ...clip(status, 300), ...(status.error === undefined ? {} : { error: clip(status.error, 500) }) };
  };

  server.registerTool(
    'get_task',
    {
      title: 'Get task',
      description: 'The full task record: prompt, steps, branch, PR, usage. Long text fields are clipped.',
      inputSchema: runArgs,
      outputSchema: runOutput,
      annotations: READ,
    },
    ({ projectId, taskId }, ctx) =>
      read(ctx, (c) => inProject(c, projectId, taskId, async (pid) => runOutput.parse(clip({ ...(await readRun(c, pid, taskId)), projectId: pid }, 2_000)))),
  );

  server.registerTool(
    'get_task_status',
    {
      title: 'Get task status',
      description: 'Compact status of one task — cheap to poll.',
      inputSchema: runArgs,
      outputSchema: runStatusOutput,
      annotations: READ,
    },
    ({ projectId, taskId }, ctx) => read(ctx, (c) => inProject(c, projectId, taskId, async (pid) => statusOf(await readRun(c, pid, taskId), pid))),
  );

  server.registerTool(
    'list_task_events',
    {
      title: 'List task events',
      description:
        'Transcript events of a task, oldest first, from one page (100 transcript items) at a time, capped at ' +
        `${RESPONSE_BUDGET_CHARS} characters per answer. Without arguments: the newest events. ` +
        'Remember asOfSeq and pass it back as afterSeq to read only what happened since; pass olderCursor / newerCursor ' +
        'from a previous answer to page. truncated: true means events were left out for size — continue with afterSeq: nextAfterSeq ' +
        '(plus the same cursor, if you passed one), or read the skipped older ones with afterSeq: skippedAfterSeq. ' +
        'Cursors are short-lived — a seq is what to keep between calls.',
      inputSchema: runArgs.extend({
        cursor: runHistoryCursorSchema.optional().describe('olderCursor or newerCursor from a previous call.'),
        afterSeq: z.number().int().nonnegative().optional().describe('Only events with a seq greater than this.'),
        maxChars: z.number().int().min(100).max(20_000).optional().describe('Clip each text field to this (default 1000).'),
        maxEvents: z.number().int().min(1).max(EVENTS_MAX).optional().describe(
          `At most this many events (default ${EVENTS_DEFAULT_MAX}). The answer is also capped at ${RESPONSE_BUDGET_CHARS} characters.`,
        ),
      }),
      outputSchema: eventsOutput,
      annotations: READ,
    },
    ({ projectId, taskId, cursor, afterSeq, maxChars, maxEvents }, ctx) =>
      read(ctx, (c) =>
        inProject(c, projectId, taskId, async (pid) => {
          const param = { projectId: pid, id: taskId };
          const page = async (at?: string) =>
            readJson(await c.api.api.v1.p[':projectId'].runs[':id'].history.$get({ param, query: at ? { cursor: at } : {} }));
          const first = await page(cursor);
          const bySeq = new Map(first.events.map((e) => [e.seq, e]));
          let olderCursor = first.hasOlder ? first.olderCursor : undefined;
          // Every event from `coveredFrom` on has been read; seqs are integers.
          let coveredFrom = pageStart(first.events);
          const covers = () => afterSeq === undefined || coveredFrom <= afterSeq + 1;
          // `/history` has no `afterSeq` (spec § list_task_events): walk back from the tip, bounded.
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
            // With a gap, drop a page's leading turn opener below the range: what is left unread is exactly the gap.
            .filter((e) => (afterSeq === undefined ? true : e.seq > afterSeq && (reached || e.seq >= coveredFrom)))
            .sort((a, b) => a.seq - b.seq)
            .map((e) => clip(e, maxChars ?? 1_000));
          const envelope = {
            asOfSeq: first.asOfSeq,
            ...(olderCursor && (afterSeq === undefined || !reached) ? { olderCursor } : {}),
            ...(first.newerCursor ? { newerCursor: first.newerCursor } : {}),
            ...(reached ? {} : { gap: true }),
          };
          // No position asked: keep the newest and name where the cut head starts; else keep the head and name where to go on.
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
    'wait_for_tasks',
    {
      title: 'Wait for tasks',
      description:
        `Wait until tasks settle (done, failed, cancelled, or parked at waiting/review) or the timeout ` +
        `(max ${WAIT_MAX_SECONDS} s) passes, then answer with their status. mode "any" returns at the first settled task — ` +
        'at once if one already is — and "all" when every one has. "failed" settles a task even when autoResumeAt is set ' +
        '(a usage limit: cezar resumes it at that time on its own, so wait again after it). On timedOut: true, just call it again.',
      inputSchema: z.object({
        projectId: projectIdArg,
        taskIds: z.array(runIdArg).min(1).max(20),
        mode: z.enum(['any', 'all']).optional().describe('Default "any".'),
        timeoutSeconds: z.number().int().min(1).max(WAIT_MAX_SECONDS).optional().describe(`Default ${WAIT_DEFAULT_SECONDS}.`),
      }),
      outputSchema: waitOutput,
      annotations: READ,
    },
    // Not retried: a second wait would carry the call past the client's own tool timeout.
    ({ projectId, taskIds, mode, timeoutSeconds }, ctx) =>
      call(
        ctx,
        (c) =>
          waitForRuns(ctx, {
            taskIds: [...new Set(taskIds)],
            mode: mode ?? 'any',
            timeoutMs: (timeoutSeconds ?? WAIT_DEFAULT_SECONDS) * 1000,
            pollMs,
            fetchRun: (id, signal) => inProject(c, projectId, id, async (pid) => statusOf(await readRun(c, pid, id, signal), pid)),
          }),
        { retry: false },
      ),
  );

  if (readOnly) return server;

  server.registerTool(
    'start_task',
    {
      title: 'Start task',
      description:
        'Start an agent task from a named workflow (list_workflows). Returns at once with the task id — ' +
        'the agent works in the background; follow it with wait_for_tasks or get_task_status. Costs agent usage.',
      inputSchema: startRunInputSchema,
      outputSchema: runStatusOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ projectId, ...body }, ctx) =>
      write(ctx, async (c) => {
        if (!projectId && c.projectUnknown) throw new Error(c.projectUnknown);
        const pid = projectOf(c, projectId);
        return statusOf(await readJson(await c.api.api.v1.p[':projectId'].runs.$post({ param: { projectId: pid }, json: body })), pid);
      }),
  );

  server.registerTool(
    'cancel_task',
    {
      title: 'Cancel task',
      description: 'Stop a queued or running task. Its agent is killed; the worktree is kept. cancelled: false means it had already settled.',
      inputSchema: runArgs,
      outputSchema: cancelResponseSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ projectId, taskId }, ctx) =>
      write(ctx, (c) =>
        inProject(c, projectId, taskId, async (pid) =>
          cancelResponseSchema.parse(await readJson(await c.api.api.v1.p[':projectId'].runs[':id'].cancel.$post({ param: { projectId: pid, id: taskId } }))),
        ),
      ),
  );

  /** The run a write targets, read first so the tool can check its status. */
  const runForWrite = (c: Cockpit, projectId: string | undefined, taskId: string) =>
    inProject(c, projectId, taskId, async (pid) => ({ pid, run: await readRun(c, pid, taskId) }));
  const statusNow = async (c: Cockpit, pid: string, taskId: string) => (await readRun(c, pid, taskId).catch(() => undefined))?.status;
  /** `/continue` starts the session asynchronously, so the record reads a stale `review` for a
   *  moment; wait, bounded, until the send-back's step has started. */
  const sentBackStatus = async (c: Cockpit, pid: string, taskId: string) => {
    let status: string | undefined;
    for (let i = 0; i < SEND_BACK_POLLS; i += 1) {
      const run = await readRun(c, pid, taskId).catch(() => undefined);
      if (!run) return status;
      status = run.status;
      const step = [...run.steps].reverse().find((s) => s.id.startsWith('continue-'));
      if (status !== 'review' || (step && step.status !== 'pending')) return status;
      await sleep(pollMs / 8);
    }
    return status;
  };

  server.registerTool(
    'push_task_branch',
    {
      title: 'Push task branch',
      description:
        "Push the task's worktree branch to its remote — the cockpit's Push button (POST /runs/:id/git/push). " +
        'Commits only what is already committed, sets the upstream on the first push, and never force-pushes: ' +
        'a rejection (the remote has commits the branch lacks) is returned as an error, not retried. ' +
        "The remote is the cockpit's own choice (its push remote, usually origin). Answers with the branch, the remote " +
        'and whether the upstream was set.',
      inputSchema: runArgs,
      outputSchema: pushOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ projectId, taskId }, ctx) =>
      write(ctx, (c) =>
        inProject(c, projectId, taskId, async (pid) => {
          const param = { projectId: pid, id: taskId };
          const pushed = await readJson(await c.api.api.v1.p[':projectId'].runs[':id'].git.push.$post({ param })).catch((error: unknown) => {
            throw describePushRefusal(error);
          });
          return pushOutput.parse({ ...pushed, projectId: pid, taskId });
        }),
      ),
  );

  server.registerTool(
    'send_task_message',
    {
      title: 'Send task message',
      description:
        "Answer a task — the cockpit's composer (POST /runs/:id/messages). At \"waiting\" (the agent asked or finished a turn) " +
        'the text goes into its open session and the task works again; at "running" it reaches the agent mid-turn; at ' +
        '"queued" it is added to the prompt. Any other status is an error: it never reopens a finished task, and a task at ' +
        '"review" takes review_task instead. The agent acts on the message — it costs agent usage.',
      inputSchema: runArgs.extend({ text: messageText.trim().min(1).describe('The message, as the user would type it.') }),
      outputSchema: messageOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ projectId, taskId, text }, ctx) =>
      write(ctx, async (c) => {
        const { pid, run } = await runForWrite(c, projectId, taskId);
        if (!LIVE_STATUSES.has(run.status)) throw new Error(notLive(taskId, run.status));
        const param = { projectId: pid, id: taskId };
        const answer = await readJson(await c.api.api.v1.p[':projectId'].runs[':id'].messages.$post({ param, json: { text, idempotencyKey: randomUUID() } })).catch(
          async (error: unknown) => {
            // The session closed between the read and the post.
            if (error instanceof CezarApiError && error.status === 409) {
              const now = await statusNow(c, pid, taskId);
              throw new Error(`${describeError(error)}${now ? ` — ${notLive(taskId, now)}` : ''}`);
            }
            throw error;
          },
        );
        return messageOutput.parse({ ...messageResponseSchema.parse(answer), projectId: pid, taskId, status: run.status });
      }),
  );

  server.registerTool(
    'review_task',
    {
      title: 'Review task',
      description:
        'Decide on a task parked at "review" — the cockpit\'s review gate. ' +
        '"accept" (✓ Accept, POST /runs/:id/finish) only marks the task done: nothing is merged, committed, pushed or opened as a PR, ' +
        'and the worktree and branch stay as they are — publish with push_task_branch. ' +
        'A task working in place (worktree: false, not read-only) is refused: finishing it may commit to the base branch, ' +
        'which only the cockpit does. ' +
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
    ({ projectId, taskId, decision, notes }, ctx) =>
      write(ctx, async (c) => {
        const feedback = notes?.trim();
        if (decision === 'send_back' && !feedback) throw new Error('send_back needs notes: write what to change');
        if (decision === 'accept' && feedback) throw new Error('accept takes no notes — use send_back to send them to the agent');
        const { pid, run } = await runForWrite(c, projectId, taskId);
        if (run.status !== 'review') throw new Error(`task ${taskId} is ${run.status}, not review — review_task only decides at the review gate`);
        // Finishing an in-place task may commit to the base branch (spec 2026-10-20-trunk-based-projects).
        if (decision === 'accept' && run.worktree === false && !run.readOnly) {
          throw new Error(
            `task ${taskId} works in place in the repository checkout, so accepting it may commit its changes to the base branch — ` +
              'review_task does not do that; accept it in the cezar cockpit, or send_back to ask for changes',
          );
        }
        const param = { projectId: pid, id: taskId };
        const route = c.api.api.v1.p[':projectId'].runs[':id'];
        // Both routes answer 409 (nothing changed) while a send-back is still starting or settling.
        const busy = (error: unknown) => {
          if (!(error instanceof CezarApiError) || error.status !== 409) throw error;
          throw new Error(`${describeError(error)} — the task is still being resumed or settled; wait_for_tasks, then decide again`);
        };
        const answer =
          decision === 'accept'
            ? finishResponseSchema.parse(await readJson(await route.finish.$post({ param })).catch(busy))
            : continueResponseSchema.parse(
                await readJson(await route.continue.$post({ param, json: { text: `${REVIEW_FEEDBACK_PREFIX}${feedback}`, idempotencyKey: randomUUID() } })).catch(busy),
              );
        const status = decision === 'accept' ? await statusNow(c, pid, taskId) : await sentBackStatus(c, pid, taskId);
        return reviewOutput.parse({ ...answer, projectId: pid, taskId, decision, ...(status ? { status } : {}) });
      }),
  );

  return server;
}

function notLive(taskId: string, status: string): string {
  const next =
    status === 'review'
      ? 'decide with review_task'
      : 'it is finished — cez mcp does not reopen finished tasks (the cockpit\'s Continue does)';
  return `task ${taskId} is ${status}: send_task_message reaches only a waiting, running or queued task — ${next}`;
}

/** A non-fast-forward push, in words the model can act on; never retried (that would take a force). */
function describePushRefusal(error: unknown): unknown {
  if (!(error instanceof CezarApiError) || error.status !== 409) return error;
  // The cockpit's wording for a rejected push (syncFailureReason, #1662).
  if (!/pull first/.test(error.message)) return error;
  return new Error(
    `${describeError(error)} — the remote branch has commits this branch lacks (non-fast-forward). ` +
      'cez mcp does not force-push: have the task merge the remote branch (send_task_message), then push again',
  );
}

/** Where a `/history` page's own range begins: a leading turn opener (`pageEventSlice`) may sit far
 *  below the rest, so it does not count. Under-claims by one at worst — an extra page, never a miss. */
function pageStart(events: ReadonlyArray<{ seq: number; type: string }>): number {
  const [head, next] = events;
  if (!head) return Number.POSITIVE_INFINITY;
  return next && (head.type === 'user-message' || head.type === 'turn.started') ? next.seq : head.seq;
}

/** Take events in order until `max` or the room runs out; the first is always taken (clipped
 *  harder if it must be), so a continuation never stalls on it. */
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
  taskIds: string[];
  mode: 'any' | 'all';
  timeoutMs: number;
  pollMs: number;
  fetchRun: (taskId: string, signal: AbortSignal) => Promise<RunStatusOutput>;
}

/** Poll `GET /runs/:id` — at once, then every `pollMs` — until `mode` holds, the timeout passes or the client cancels. */
async function waitForRuns(ctx: ToolContext, input: WaitInput): Promise<z.infer<typeof waitOutput>> {
  const latest = new Map<string, RunStatusOutput>();
  const done = new AbortController();
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(input.timeoutMs), done.signal]);
  const settledCount = () => input.taskIds.filter((id) => SETTLED.has(latest.get(id)?.status ?? '')).length;
  const satisfied = () => (input.mode === 'any' ? settledCount() > 0 : settledCount() === input.taskIds.length);
  try {
    for (let poll = 1; ; poll += 1) {
      const runs = await Promise.all(input.taskIds.map((id) => input.fetchRun(id, signal)));
      for (const run of runs) latest.set(run.id, run);
      await ctx.progress?.(poll, runs.map((r) => `${r.id}: ${r.activity === IDLE_CLOSED ? IDLE_CLOSED : r.status}`).join(', '));
      if (satisfied()) break;
      await sleep(input.pollMs, undefined, { signal });
    }
  } catch (error) {
    // The timeout or a cancel ends the wait with what is known; anything else is the tool's error.
    if (!signal.aborted) throw error;
  } finally {
    // A failed poll leaves its siblings in flight — end them with the wait.
    done.abort();
  }
  return { tasks: input.taskIds.map((id) => latest.get(id) ?? { id, status: 'unknown' }), timedOut: !satisfied() };
}
