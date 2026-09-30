import { z } from 'zod';
import { dashboardCoverageSchema } from './dashboard.ts';
import { runStatusSchema } from './runs.ts';

const count = z.number().int().nonnegative();
const amount = z.number().finite().nonnegative();
export const dashboardCostPeriodSchema = z.enum(['all', '7d', '30d']);
export type DashboardCostPeriod = z.infer<typeof dashboardCostPeriodSchema>;
export const dashboardCostSortSchema = z.enum(['cost', 'input', 'output']);
export type DashboardCostSort = z.infer<typeof dashboardCostSortSchema>;
export const dashboardCostVisibilitySchema = z.object({
  tokens: z.boolean(),
  cost: z.boolean(),
});
export type DashboardCostVisibility = z.infer<typeof dashboardCostVisibilitySchema>;
/** Availability counts tasks with a persisted amount, not provider invoice/turn completeness. */
export const dashboardCostMetricSchema = z.object({
  value: amount.nullable(),
  reportedTasks: count,
});
export type DashboardCostMetric = z.infer<typeof dashboardCostMetricSchema>;
export const dashboardCostTotalsSchema = z.object({
  tasks: count,
  inputTokens: dashboardCostMetricSchema.optional(),
  outputTokens: dashboardCostMetricSchema.optional(),
  costUsd: dashboardCostMetricSchema.optional(),
});
export type DashboardCostTotals = z.infer<typeof dashboardCostTotalsSchema>;
export const dashboardCostTaskSchema = z.object({
  projectId: z.string(),
  id: z.string(),
  title: z.string(),
  status: runStatusSchema,
  archived: z.boolean(),
  subtask: z.boolean(),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  inputTokens: amount.optional(),
  outputTokens: amount.optional(),
  costUsd: amount.optional(),
});
export type DashboardCostTask = z.infer<typeof dashboardCostTaskSchema>;
/** One day of the requesting client's local calendar, only populated for a bounded period
 *  (`7d`/`30d`) — `all` has no fixed window to bucket against. Cost/token fields follow the
 *  same visibility gating as `totals`; cycle time never does, since it carries no financial
 *  data. `avgCycleHours`/`medianCycleHours` cover `done` tasks that finished that day only. */
export const dashboardCostSeriesPointSchema = z.object({
  date: z.string(),
  tasks: count,
  inputTokens: dashboardCostMetricSchema.optional(),
  outputTokens: dashboardCostMetricSchema.optional(),
  costUsd: dashboardCostMetricSchema.optional(),
  completed: count,
  cycleReportedTasks: count.optional(),
  avgCycleHours: z.number().finite().nonnegative().nullable(),
  medianCycleHours: z.number().finite().nonnegative().nullable(),
});
export type DashboardCostSeriesPoint = z.infer<typeof dashboardCostSeriesPointSchema>;
export const dashboardCostProjectSchema = dashboardCostTotalsSchema.extend({
  projectId: z.string(),
});
export type DashboardCostProject = z.infer<typeof dashboardCostProjectSchema>;
export const dashboardCostsQuerySchema = z.object({
  period: dashboardCostPeriodSchema.default('all'),
  sort: dashboardCostSortSchema.default('cost'),
  projectId: z.string().min(1).max(128).optional(),
  snapshotId: z.string().min(1).max(128).optional(),
  /** `Date.prototype.getTimezoneOffset()` from the requesting browser — the day boundaries for
   *  `series` follow the viewer's local calendar, not UTC. Absent (older clients, tests) buckets
   *  in UTC. */
  tzOffsetMinutes: z.coerce.number().int().min(-840).max(720).optional(),
  offset: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.coerce.number().int().min(1).max(20).default(20),
});
export type DashboardCostsQuery = z.infer<typeof dashboardCostsQuerySchema>;
export const dashboardCostsSchema = z.object({
  snapshotId: z.string().min(1),
  asOf: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  scope: z.literal('retained-task-lifetime'),
  period: dashboardCostPeriodSchema,
  windowStart: z.iso.datetime().nullable(),
  /** Captured calendar offset; optional for clients reading older servers. */
  tzOffsetMinutes: z.number().int().min(-840).max(720).optional(),
  sort: dashboardCostSortSchema,
  visibility: dashboardCostVisibilitySchema,
  coverage: dashboardCoverageSchema,
  invalidDateTasks: count,
  totals: dashboardCostTotalsSchema,
  series: z.array(dashboardCostSeriesPointSchema).max(31),
  projects: z.array(dashboardCostProjectSchema),
  tasks: z.object({
    rows: z.array(dashboardCostTaskSchema).max(20),
    total: count,
    nextOffset: count.nullable(),
  }),
});
export type DashboardCosts = z.infer<typeof dashboardCostsSchema>;
