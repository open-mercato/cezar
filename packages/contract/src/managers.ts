import { z } from 'zod';
import { attachmentListSchema } from './runs.ts';

/**
 * Managers (spec `.ai/specs/2026-10-31-managers.md`): global, long-lived agents the user talks to
 * instead of visiting each repository. Workspace-level, so every route here is single-mount under
 * `/api/v1/workspace/managers` and never scope-prefixed.
 */

const managerIdSchema = z.string().regex(/^[a-z0-9-]{1,64}$/);

export const managerIdParamSchema = z.object({ id: managerIdSchema });
/** `pasted-<seq>-<nonce>.<ext>`: the engine's own names, so a path param cannot climb out. */
export const managerAttachmentParamSchema = z.object({
  id: managerIdSchema,
  file: z.string().regex(/^pasted-[a-z0-9-]+\.[a-z0-9]+$/),
});
export const managerActionParamSchema = z.object({ id: managerIdSchema, actionId: z.string().min(1).max(64) });
export const managerJobParamSchema = z.object({ id: managerIdSchema, jobId: z.string().min(1).max(64) });

const boundedId = z.string().min(1).max(200);
const runnerInput = z.string().max(64);
const modelInput = z.string().max(200);

/** `all` follows the registry: a project added later is connected without touching the manager. */
export const managerProjectsSchema = z.union([z.literal('all'), z.array(z.string().min(1).max(200)).min(1).max(200)]);
export type ManagerProjects = z.infer<typeof managerProjectsSchema>;

/** What a manager may do to a repository. `read` starts only read-only tasks and proposes nothing. */
export const managerAccessSchema = z.enum(['read', 'write']);
export type ManagerAccess = z.infer<typeof managerAccessSchema>;

export const managerProjectAccessSchema = z.record(z.string().min(1).max(200), managerAccessSchema);

/** One project's access: its own, else the manager's, else write. */
export function managerAccessOf(
  manager: { access?: ManagerAccess | undefined; projectAccess?: Record<string, ManagerAccess> | undefined },
  projectId: string,
): ManagerAccess {
  return manager.projectAccess?.[projectId] ?? manager.access ?? 'write';
}

export const managerEffortSchema = z.enum(['low', 'medium', 'high']);
export type ManagerEffort = z.infer<typeof managerEffortSchema>;

/** The watch check's cadence ("Chron" in the design). 0 = no watching. */
export const MANAGER_CRON_MINUTES = [0, 5, 15, 30, 60, 240, 1440] as const;
export const managerCronMinutesSchema = z.union([
  z.literal(0), z.literal(5), z.literal(15), z.literal(30), z.literal(60), z.literal(240), z.literal(1440),
]);
export const MANAGER_DEFAULT_CRON_MINUTES = 15;

/** A predefined job: a saved prompt the manager runs on its own cadence. */
export const managerJobSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(20_000),
  everyMinutes: z.number().int().min(5).max(10_080),
  enabled: z.boolean(),
  lastRunAt: z.string().optional(),
});
export type ManagerJob = z.infer<typeof managerJobSchema>;

export const managerJobInputSchema = managerJobSchema.omit({ id: true, lastRunAt: true }).extend({
  id: z.string().min(1).max(64).optional(),
});

/** The user-owned definition, persisted in `~/.cezar/managers.json`. */
export const managerSchema = z.object({
  id: managerIdSchema,
  name: z.string().trim().min(1).max(80),
  /** What the manager is for. Becomes part of its system prompt. */
  instructions: z.string().max(20_000),
  /** Index into the cockpit's avatar set; stable across renames. */
  avatar: z.number().int().min(0).max(63),
  projects: managerProjectsSchema,
  /** Every connected project's access unless `projectAccess` names it. Absent = write. */
  access: managerAccessSchema.optional(),
  projectAccess: managerProjectAccessSchema.optional(),
  runner: z.string().optional(),
  model: z.string().optional(),
  effort: managerEffortSchema.optional(),
  /** Agent account id ("Account" in the design); absent = the runner's default. */
  agentProfile: z.string().max(64).optional(),
  cronMinutes: managerCronMinutesSchema,
  /** false silences system notifications; the chat and unread dot stay. Absent = on. */
  notify: z.boolean().optional(),
  jobs: z.array(managerJobSchema).max(32),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Manager = z.infer<typeof managerSchema>;

export const managerStatusSchema = z.enum(['idle', 'working', 'error']);
export type ManagerStatus = z.infer<typeof managerStatusSchema>;

/** A manager plus what the sidebar row and the chat header show. */
export const managerSummarySchema = managerSchema.extend({
  status: managerStatusSchema,
  /** The registered projects `projects` resolves to right now — `all` included. */
  connectedProjectIds: z.array(z.string()),
  lastActivityAt: z.string().optional(),
  /** One plain-text line for the sidebar row. */
  preview: z.string().optional(),
  /** Messages the manager produced since the user last opened this chat. */
  unread: z.number().int().min(0),
  /** Those of them it judged worth interrupting the user for. */
  important: z.number().int().min(0),
  /** The newest important message's one line, for a browser notification. */
  headline: z.string().optional(),
  pendingActions: z.number().int().min(0),
  /** Question cards still waiting for an answer. */
  pendingQuestions: z.number().int().min(0),
  lastCheckAt: z.string().optional(),
  /** Absent when `cronMinutes` is 0. */
  nextCheckAt: z.string().optional(),
  /** Spend across this manager's own turns. Excludes tasks it started: they bill to the task. */
  costUsd: z.number().min(0),
});
export type ManagerSummary = z.infer<typeof managerSummarySchema>;

export const createManagerInputSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  instructions: z.string().max(20_000),
  projects: managerProjectsSchema,
  access: managerAccessSchema.optional(),
  projectAccess: managerProjectAccessSchema.optional(),
  runner: runnerInput.optional(),
  model: modelInput.optional(),
  effort: managerEffortSchema.optional(),
  agentProfile: z.string().max(64).optional(),
  cronMinutes: managerCronMinutesSchema.optional(),
  avatar: z.number().int().min(0).max(63).optional(),
});
export type CreateManagerInput = z.infer<typeof createManagerInputSchema>;

/** `null` clears an optional key back to its default. */
export const updateManagerInputSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  instructions: z.string().max(20_000).optional(),
  projects: managerProjectsSchema.optional(),
  access: managerAccessSchema.optional(),
  /** Replaces the whole map. */
  projectAccess: managerProjectAccessSchema.optional(),
  runner: runnerInput.nullable().optional(),
  model: modelInput.nullable().optional(),
  effort: managerEffortSchema.nullable().optional(),
  agentProfile: z.string().max(64).nullable().optional(),
  cronMinutes: managerCronMinutesSchema.optional(),
  avatar: z.number().int().min(0).max(63).optional(),
  notify: z.boolean().optional(),
  jobs: z.array(managerJobInputSchema).max(32).optional(),
});
export type UpdateManagerInput = z.infer<typeof updateManagerInputSchema>;

export const managerListResponseSchema = z.object({ managers: z.array(managerSummarySchema) });
export type ManagerListResponse = z.infer<typeof managerListResponseSchema>;

// ---- chat ------------------------------------------------------------------

/** Why a turn ran. Only `chat` and `job` may act or propose; `watch` only reads. */
export const managerTurnKindSchema = z.enum(['chat', 'watch', 'job']);
export type ManagerTurnKind = z.infer<typeof managerTurnKindSchema>;

/** One tool call inside a turn — the rows behind "Ran 2 commands". */
export const managerCommandSchema = z.object({
  id: z.string(),
  tool: z.string(),
  /** A short human label, e.g. the shell command. */
  summary: z.string(),
  output: z.string().optional(),
  isError: z.boolean().optional(),
});
export type ManagerCommand = z.infer<typeof managerCommandSchema>;

/** What a manager may only PROPOSE: the user approves it in the chat, the server then does it. */
export const managerActionRequestSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('merge-pr'),
    projectId: boundedId,
    number: z.number().int().positive(),
    title: z.string().max(1000).optional(),
    method: z.enum(['merge', 'squash', 'rebase']).optional(),
    /** Stamped by the server at proposal: a push after it makes the approval refuse, not merge. */
    headSha: z.string().max(200).optional(),
  }),
  z.object({
    type: z.literal('enable-automation'),
    projectId: boundedId,
    automationId: boundedId,
    name: z.string().max(1000).optional(),
    /** Stamped by the server at proposal, with what the card shows: an edit after it refuses. */
    revision: z.number().int().optional(),
    summary: z.string().max(20_000).optional(),
  }),
  /** A job runs unattended, so one the agent asks for waits for the user too. */
  z.object({
    type: z.literal('add-job'),
    name: z.string().trim().min(1).max(80),
    prompt: z.string().trim().min(1).max(20_000),
    everyMinutes: z.number().int().min(5).max(10_080),
  }),
]);
export type ManagerActionRequest = z.infer<typeof managerActionRequestSchema>;

export const managerActionStatusSchema = z.enum(['pending', 'running', 'done', 'rejected', 'failed']);
export type ManagerActionStatus = z.infer<typeof managerActionStatusSchema>;

/** The questions of a `CEZ:ASK` line, the same shape a task's ask card shows. */
export const managerAskSchema = z.object({
  questions: z.array(z.object({
    id: z.string().optional(),
    header: z.string(),
    question: z.string(),
    multiSelect: z.boolean().optional(),
    options: z.array(z.object({ label: z.string(), description: z.string().optional() })),
  })),
});
export type ManagerAsk = z.infer<typeof managerAskSchema>;

/** A file the user sent, served by `GET …/attachments/:file`. */
export const managerAttachmentSchema = z.object({
  file: z.string(),
  mediaType: z.string(),
  /** The user's own filename; a pasted screenshot has none. */
  name: z.string().optional(),
});
export type ManagerAttachment = z.infer<typeof managerAttachmentSchema>;

const managerMessageBase = { id: z.string(), seq: z.number().int().min(0), at: z.string() };

/** Messages are replaced in place by `id`, newest write wins; `seq` orders the chat. */
export const managerMessageSchema = z.discriminatedUnion('kind', [
  z.object({ ...managerMessageBase, kind: z.literal('user'), text: z.string(), attachments: z.array(managerAttachmentSchema).optional() }),
  z.object({
    ...managerMessageBase,
    kind: z.literal('assistant'),
    /** Markdown. `[[task:<projectId>/<runId>]]` and `[[pr:<projectId>/<number>]]` render as cards. */
    text: z.string(),
    turn: managerTurnKindSchema,
    jobName: z.string().optional(),
    streaming: z.boolean(),
    /** The manager's own judgement that this should interrupt the user. */
    important: z.boolean().optional(),
    headline: z.string().optional(),
    ask: managerAskSchema.optional(),
    /** What the user answered; the next message they send answers an open card. */
    askAnswer: z.string().optional(),
    commands: z.array(managerCommandSchema),
    stopped: z.boolean().optional(),
    error: z.string().optional(),
    costUsd: z.number().optional(),
  }),
  z.object({
    ...managerMessageBase,
    kind: z.literal('action'),
    action: managerActionRequestSchema,
    /** The manager's reason, shown on the approval card. */
    reason: z.string().optional(),
    status: managerActionStatusSchema,
    /** The outcome sentence once it left `pending`. */
    result: z.string().optional(),
  }),
  /** A quiet system line: "Connected to meblohand", "Merged #12". */
  z.object({ ...managerMessageBase, kind: z.literal('notice'), text: z.string() }),
]);
export type ManagerMessage = z.infer<typeof managerMessageSchema>;

export const managerMessagesQuerySchema = z.object({
  /** Page older history: only messages with a lower `seq`. */
  before: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
export const managerMessagesResponseSchema = z.object({
  messages: z.array(managerMessageSchema),
  hasMore: z.boolean(),
});
export type ManagerMessagesResponse = z.infer<typeof managerMessagesResponseSchema>;

export const sendManagerMessageInputSchema = z
  .object({ text: z.string().trim().max(100_000), images: attachmentListSchema.optional() })
  .refine((input) => input.text !== '' || (input.images?.length ?? 0) > 0, {
    message: 'write a message or attach a file',
    path: ['text'],
  });
export type SendManagerMessageInput = z.input<typeof sendManagerMessageInputSchema>;

export const managerActionDecisionInputSchema = z.object({ decision: z.enum(['approve', 'reject']) });
export type ManagerActionDecisionInput = z.infer<typeof managerActionDecisionInputSchema>;

export const managerOkResponseSchema = z.object({ ok: z.literal(true) });

// ---- what the manager sees --------------------------------------------------

export const managerAttentionKindSchema = z.enum([
  'task-needs-you',
  'task-failed',
  'task-review',
  'task-finished',
  'task-stalled',
  'pr-ready',
  'pr-checks-failing',
  'pr-conflict',
  'pr-review-requested',
  'automation-failing',
]);
export type ManagerAttentionKind = z.infer<typeof managerAttentionKindSchema>;

export const managerAttentionItemSchema = z.object({
  /** Stable identity: the watch check speaks only about keys it has not reported yet. */
  key: z.string(),
  kind: managerAttentionKindSchema,
  projectId: z.string(),
  title: z.string(),
  detail: z.string().optional(),
  runId: z.string().optional(),
  number: z.number().int().optional(),
  url: z.string().optional(),
  since: z.string().optional(),
});
export type ManagerAttentionItem = z.infer<typeof managerAttentionItemSchema>;

export const managerSnapshotTaskSchema = z.object({
  runId: z.string(),
  title: z.string(),
  status: z.string(),
  workflow: z.string(),
  branch: z.string().optional(),
  parentRunId: z.string().optional(),
  /** Direct dispatched children; a big tree reads as its root. */
  childCount: z.number().int().min(0),
  additions: z.number().int().optional(),
  deletions: z.number().int().optional(),
  costUsd: z.number().optional(),
  lastActivityAt: z.string().optional(),
});
export type ManagerSnapshotTask = z.infer<typeof managerSnapshotTaskSchema>;

export const managerSnapshotPrSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  author: z.string().optional(),
  url: z.string().optional(),
  draft: z.boolean().optional(),
  status: z.string().optional(),
  mergeable: z.boolean().optional(),
});
export type ManagerSnapshotPr = z.infer<typeof managerSnapshotPrSchema>;

export const managerSnapshotProjectSchema = z.object({
  projectId: z.string(),
  name: z.string(),
  available: z.boolean(),
  /** Why GitHub facts are absent; the rest of the project is still reported. */
  prsUnavailable: z.string().optional(),
  tasks: z.array(managerSnapshotTaskSchema),
  prs: z.array(managerSnapshotPrSchema),
});
export type ManagerSnapshotProject = z.infer<typeof managerSnapshotProjectSchema>;

export const managerSnapshotSchema = z.object({
  generatedAt: z.string(),
  projects: z.array(managerSnapshotProjectSchema),
  attention: z.array(managerAttentionItemSchema),
});
export type ManagerSnapshot = z.infer<typeof managerSnapshotSchema>;

// ---- the tools a manager's agent calls (`cez manager …`) -----------------------

export const managerCreateTaskInputSchema = z.object({
  projectId: boundedId,
  task: z.string().trim().min(1).max(100_000),
  title: z.string().trim().min(1).max(200).optional(),
  workflow: boundedId.optional(),
  runner: runnerInput.optional(),
  model: modelInput.optional(),
  dispatch: z.boolean().optional(),
});
export type ManagerCreateTaskInput = z.infer<typeof managerCreateTaskInputSchema>;

export const managerCreateTaskResponseSchema = z.object({ projectId: z.string(), runId: z.string() });

export const managerTaskMessageInputSchema = z.object({
  projectId: boundedId,
  runId: boundedId,
  text: z.string().trim().min(1).max(100_000),
});
export type ManagerTaskMessageInput = z.infer<typeof managerTaskMessageInputSchema>;

export const managerProposeActionInputSchema = z.object({
  action: managerActionRequestSchema,
  reason: z.string().max(2000).optional(),
});
export type ManagerProposeActionInput = z.infer<typeof managerProposeActionInputSchema>;

export const managerProposeActionResponseSchema = z.object({ actionId: z.string(), status: managerActionStatusSchema });

export const managerTaskDetailQuerySchema = z.object({
  projectId: boundedId,
  runId: boundedId,
});
export const managerTaskDetailSchema = z.object({
  task: managerSnapshotTaskSchema,
  /** The tail of the task's assistant text — what the manager quotes back. */
  lastMessage: z.string().optional(),
  children: z.array(managerSnapshotTaskSchema),
});
export type ManagerTaskDetail = z.infer<typeof managerTaskDetailSchema>;

// ---- live events ------------------------------------------------------------

/** `manager-change` on `/workspace/events`: a row changed, or `deleted` with only the id. */
export const managerChangeEventSchema = z.object({
  id: z.string(),
  manager: managerSummarySchema.optional(),
  deleted: z.boolean().optional(),
});
export type ManagerChangeEvent = z.infer<typeof managerChangeEventSchema>;

/** `manager-message` on `/workspace/events`: one message created or replaced. */
export const managerMessageEventSchema = z.object({ managerId: z.string(), message: managerMessageSchema });
export type ManagerMessageEvent = z.infer<typeof managerMessageEventSchema>;
