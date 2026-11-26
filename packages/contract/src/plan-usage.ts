import { z } from 'zod';

/**
 * Plan-limit usage ledger (design: session-usage-design rev 3, approved 2026-11-19).
 * `pp` = percentage points of one provider limit window. Every estimate names its account and
 * window; nothing here carries prompts, paths or code.
 */
export const PLAN_USAGE_SCHEMA = 'cezar.usage-ledger';
export const PLAN_USAGE_VERSION = '1.0.0';
export const PLAN_USAGE_RETENTION_DAYS = 90;

const pp = z.number().finite();
const iso = z.string();

export const planUsageWindowKindSchema = z.enum(['five-hour', 'weekly']);
export type PlanUsageWindowKind = z.infer<typeof planUsageWindowKindSchema>;
export const planUsageProviderSchema = z.enum(['claude', 'codex']);
export type PlanUsageProvider = z.infer<typeof planUsageProviderSchema>;

export const planUsageAccountSchema = z.object({
  /** `claude:default`, `codex:work` — what `--account` takes. */
  key: z.string(),
  provider: planUsageProviderSchema,
  accountId: z.string(),
  label: z.string(),
  /** Fingerprint of the login inside the account folder (never who it is). A re-login is a
   *  different login: its windows are never merged with the earlier one's. */
  identity: z.string().optional(),
  /** True for a login the account folder no longer holds. */
  earlierLogin: z.boolean().optional(),
});
export type PlanUsageAccount = z.infer<typeof planUsageAccountSchema>;

export const planUsageReadingSchema = z.object({
  at: iso,
  usedPercent: pp,
  status: z.enum(['allowed', 'blocked', 'unknown']),
  source: z.enum(['claude-stream', 'codex-notification', 'codex-read']),
});
export type PlanUsageReading = z.infer<typeof planUsageReadingSchema>;

/** `internal`: cezar's own one-shot calls (auto-naming, commit messages, planner). */
export const planUsageConsumerKindSchema = z.enum(['task', 'manager', 'internal']);
export type PlanUsageConsumerKind = z.infer<typeof planUsageConsumerKindSchema>;
export const planUsageManagerPartSchema = z.enum(['chat', 'watch', 'job']);
export type PlanUsageManagerPart = z.infer<typeof planUsageManagerPartSchema>;

/** One manager turn's shape (spec 2026-11-21-manager-short-sessions-and-memory § 2.3): what a
 *  spike is made of. `fresh`: the turn started a new session; `idleMs`: since that session's last turn. */
export const planUsageTurnStatsSchema = z.object({
  requests: z.number().int().nonnegative(),
  contextFirst: z.number().int().nonnegative(),
  contextPeak: z.number().int().nonnegative(),
  toolResultChars: z.number().int().nonnegative(),
  tools: z.object({
    route: z.number().int().nonnegative(),
    look: z.number().int().nonnegative(),
    own: z.number().int().nonnegative(),
    write: z.number().int().nonnegative(),
  }),
  fresh: z.boolean(),
  sessionTurn: z.number().int().positive(),
  idleMs: z.number().int().nonnegative().optional(),
  /** The turn's own prompt-cache reads and writes and its output, when the runner reports them. */
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  /** Its first request wrote more than half its context to the cache: the history was re-cached. */
  cold: z.boolean().optional(),
  /** The first 8 characters of the agent session it ran in. */
  session: z.string().max(64).optional(),
  usd: z.number().finite().nonnegative().optional(),
});
export type PlanUsageTurnStats = z.infer<typeof planUsageTurnStatsSchema>;

export const planUsageConsumerSchema = z.object({
  /** `run:<projectId>/<runId>`, `mgr:<managerId>` or `internal:<purpose>`. */
  id: z.string(),
  kind: planUsageConsumerKindSchema,
  title: z.string(),
  projectId: z.string().optional(),
  runId: z.string().optional(),
  managerId: z.string().optional(),
  /** Always an estimate: the provider reports usage per account, never per task. */
  estimatePp: pp,
  /** Slices where no other cezar consumer was active (your own sessions are still not excluded). */
  aloneInferredPp: pp,
  /** Slices split by reported cost (Claude) or tokens (Codex) with other consumers. */
  sharedEstimatePp: pp,
  /** Part of `estimatePp` spent on attempts that later failed a check step. */
  retryWasteEstimatePp: pp,
  /** Distinct other cezar consumers it shared slices with. */
  ranTogetherWith: z.object({ tasks: z.number().int().nonnegative(), managers: z.number().int().nonnegative(), internal: z.number().int().nonnegative() }),
  evidence: z.literal('account-level'),
  /** Manager only: chat / watch checks / jobs. Tasks a manager starts count on the task. */
  parts: z.object({ chat: pp, watch: pp, job: pp }).optional(),
  turns: z.object({ chat: z.number().int().nonnegative(), watch: z.number().int().nonnegative(), job: z.number().int().nonnegative() }).optional(),
  /** Manager watch checks whose reply reported nothing new. */
  quietWatchTurns: z.number().int().nonnegative().optional(),
  /** Manager only: estimate per turn, keyed by its assistant message id — the popover's largest turns,
   *  kept to debug a spike (spec 2026-11-20-manager-plan-usage-popover). `at`: when the turn began. */
  messages: z.array(z.object({
    messageId: z.string(), part: planUsageManagerPartSchema, at: iso, estimatePp: pp, aloneInferredPp: pp, sharedEstimatePp: pp,
    /** The turn's shape (spec 2026-11-21-manager-short-sessions-and-memory § 2.3). */
    turn: planUsageTurnStatsSchema.optional(),
  })).optional(),
});
export type PlanUsageConsumer = z.infer<typeof planUsageConsumerSchema>;

export const planUsageIntervalSchema = z.object({
  from: iso,
  to: iso,
  deltaPp: pp,
  outcome: z.enum(['alone', 'split', 'outside', 'unsplit', 'mixed', 'untracked']),
  /** `untracked` only: why nobody can be named for this slice. */
  reason: z.enum(['tracking-off', 'recording-started']).optional(),
  weightUnit: z.enum(['usd', 'tokens']).nullable(),
  allocations: z.array(z.object({ consumerId: z.string(), estimatePp: pp, weight: z.number().finite().nullable() })),
  outsideCezarPp: pp,
  unsplitPp: pp,
});
export type PlanUsageInterval = z.infer<typeof planUsageIntervalSchema>;

export const planUsageWindowSchema = z.object({
  id: z.string(),
  account: planUsageAccountSchema,
  kind: planUsageWindowKindSchema,
  startsAt: iso,
  resetsAt: iso,
  /** The window holding now (resetsAt in the future). */
  current: z.boolean(),
  /** First and last provider reading inside this window; null when cezar has none. */
  usedPercent: z.object({ first: pp, last: pp }).nullable(),
  limitReachedAt: iso.optional(),
  readings: z.array(planUsageReadingSchema),
  consumers: z.array(planUsageConsumerSchema),
  /** Used before cezar's first reading of this window: may be anyone. */
  beforeTrackingPp: pp,
  /** Moved while no cezar consumer was running. */
  outsideCezarPp: pp,
  /** Moved while cezar ran, but could not be split (no cost reported yet, a session that stopped mid-reply). */
  unsplitPp: pp,
  /** Moved across a stretch cezar did not record (`tracking-off`; `recording-started`: a cezar
   *  process began recording after nothing was recorded — stopped, restarted or another process):
   *  the provider total is kept, but no consumer is charged for it. */
  untrackedPp: pp,
  /** The recording gaps inside this window, newest last; `to` null = still not recording. */
  trackingGaps: z.array(z.object({ from: iso, to: iso.nullable(), reason: z.enum(['tracking-off', 'recording-started']) })),
  /** The provider lowered its reading after a higher one (shown, never hidden). */
  correctionPp: pp,
  leftPp: pp.nullable(),
  /** Present only with `intervals=1`: every reading pair, its candidates and weights. */
  intervals: z.array(planUsageIntervalSchema).optional(),
});
export type PlanUsageWindow = z.infer<typeof planUsageWindowSchema>;

export const planUsageHintSchema = z.object({
  id: z.string(),
  kind: z.enum(['retry-waste', 'parallel-limit', 'quiet-watch']),
  text: z.string(),
  windowId: z.string(),
  evidence: z.record(z.string(), z.union([z.string(), z.number(), z.array(z.string())])),
});
export type PlanUsageHint = z.infer<typeof planUsageHintSchema>;

export const planUsageTrackingSchema = z.object({
  /** False when `CEZ_USAGE_LOG=0`: nothing is written, and the reason says so. */
  enabled: z.boolean(),
  reason: z.string().optional(),
  retentionDays: z.number().int().positive(),
  /** Per-account opt-outs (`claude:default` → false). Absent = tracked. */
  accounts: z.record(z.string(), z.boolean()),
});
export type PlanUsageTracking = z.infer<typeof planUsageTrackingSchema>;

export const planUsageReportSchema = z.object({
  schema: z.literal(PLAN_USAGE_SCHEMA),
  version: z.literal(PLAN_USAGE_VERSION),
  generatedAt: iso,
  tracking: planUsageTrackingSchema,
  accounts: z.array(planUsageAccountSchema),
  windows: z.array(planUsageWindowSchema),
  hints: z.array(planUsageHintSchema),
});
export type PlanUsageReport = z.infer<typeof planUsageReportSchema>;

export const planUsageQuerySchema = z.object({
  account: z.string().max(300).optional(),
  kind: planUsageWindowKindSchema.optional(),
  /** `current` (default), `previous`, `all` (every window in `days`), or a window id. */
  window: z.string().max(300).optional(),
  days: z.coerce.number().int().min(1).max(PLAN_USAGE_RETENTION_DAYS).optional(),
  intervals: z.enum(['0', '1']).optional(),
});
export type PlanUsageQuery = z.infer<typeof planUsageQuerySchema>;

/** One consumer's share of every window it touched: the task list, task page and manager chip. */
export const planUsageConsumerWindowSchema = z.object({
  windowId: z.string(),
  account: planUsageAccountSchema,
  kind: planUsageWindowKindSchema,
  startsAt: iso,
  resetsAt: iso,
  current: z.boolean(),
  consumer: planUsageConsumerSchema,
});
export type PlanUsageConsumerWindow = z.infer<typeof planUsageConsumerWindowSchema>;

export const planUsageConsumersResponseSchema = z.object({
  schema: z.literal(PLAN_USAGE_SCHEMA),
  version: z.literal(PLAN_USAGE_VERSION),
  generatedAt: iso,
  tracking: planUsageTrackingSchema,
  entries: z.array(planUsageConsumerWindowSchema),
});
export type PlanUsageConsumersResponse = z.infer<typeof planUsageConsumersResponseSchema>;

export const planUsageConsumersQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(PLAN_USAGE_RETENTION_DAYS).optional(),
  /** Comma-separated consumer ids; absent = every consumer. */
  ids: z.string().max(20_000).optional(),
});
export type PlanUsageConsumersQuery = z.infer<typeof planUsageConsumersQuerySchema>;

export const planUsageTrackingUpdateSchema = z.object({
  account: z.string().min(1).max(300).regex(/^(claude|codex):/),
  enabled: z.boolean(),
});
export type PlanUsageTrackingUpdate = z.infer<typeof planUsageTrackingUpdateSchema>;

/** One spelling of a share for every surface (cockpit, `cez usage`), so human and JSON views agree. */
export function formatPlanPp(pp: number): string {
  const abs = Math.abs(pp);
  if (abs > 0 && abs < 0.1) return pp < 0 ? '-<0.1' : '<0.1';
  return abs >= 10 ? String(Math.round(pp)) : String(Math.round(pp * 10) / 10);
}
