import { z } from 'zod';
import { dashboardCoverageSchema } from './dashboard.ts';
import { dashboardCostMetricSchema, dashboardCostVisibilitySchema } from './dashboard-costs.ts';
import { runStatusSchema } from './runs.ts';

/**
 * `GET /workspace/dashboard/insights` — what the retained runs already say beyond status counts:
 * what finished work delivered, why work failed, how each backend/model performs, and what each
 * automation launched. Every figure is derived from `runs.json`; nothing here is sampled or
 * fetched from a forge, so a figure is only as complete as the records (see `coverage`).
 */
const count = z.number().int().nonnegative();
const iso = z.iso.datetime();

export const dashboardInsightsQuerySchema = z.object({
  period: z.enum(['7d', '30d']).default('7d'),
  /** `Date.prototype.getTimezoneOffset()` — the window starts at the viewer's local midnight. */
  tzOffsetMinutes: z.coerce.number().int().min(-840).max(720).default(0),
});
export type DashboardInsightsQuery = z.infer<typeof dashboardInsightsQuerySchema>;

/** Tasks that finished `done` in the window, and what they left behind. */
export const dashboardDeliveredSchema = z.object({
  completedTasks: count,
  /** PRs cezar itself opened for those tasks (`prRefs` origin `created`, or a legacy URL). */
  prsOpened: count,
  /** Every distinct PR those tasks are associated with, opened or only worked on. */
  prsTouched: count,
  issues: count,
  additions: count,
  deletions: count,
  files: count,
  /** Completed tasks that carry a stored diff stat — the denominator of the three above. */
  measuredTasks: count,
});
export type DashboardDelivered = z.infer<typeof dashboardDeliveredSchema>;

export const dashboardFailureCategorySchema = z.enum([
  'usage-limit',
  'auth',
  'agent-unavailable',
  'timeout',
  'check',
  'git',
  'other',
]);
export type DashboardFailureCategory = z.infer<typeof dashboardFailureCategorySchema>;
export const dashboardFailureReasonSchema = z.object({
  category: dashboardFailureCategorySchema,
  label: z.string(),
  count,
  latest: z.object({
    projectId: z.string(),
    id: z.string(),
    title: z.string(),
    at: iso,
    step: z.string().optional(),
    message: z.string().max(240),
  }),
});
export type DashboardFailureReason = z.infer<typeof dashboardFailureReasonSchema>;

/** One backend + model pair, over tasks that finished (`done` or `failed`) in the window. */
export const dashboardBackendStatSchema = z.object({
  backend: z.string(),
  model: z.string().optional(),
  finished: count,
  done: count,
  failed: count,
  timedTasks: count,
  medianCycleHours: z.number().finite().nonnegative().nullable(),
  /** Omitted when workspace settings hide cost. */
  costUsd: dashboardCostMetricSchema.optional(),
});
export type DashboardBackendStat = z.infer<typeof dashboardBackendStatSchema>;

/** One automation's tasks created in the window, joined to its definition by the client. */
export const dashboardAutomationStatSchema = z.object({
  projectId: z.string(),
  automationId: z.string(),
  tasks: count,
  done: count,
  failed: count,
  /** Launched tasks still in flight or waiting on a person, right now. */
  active: count,
  lastRunAt: iso.optional(),
  lastStatus: runStatusSchema.optional(),
  costUsd: dashboardCostMetricSchema.optional(),
});
export type DashboardAutomationStat = z.infer<typeof dashboardAutomationStatSchema>;

export const dashboardInsightsSchema = z.object({
  asOf: iso,
  windowStart: iso,
  period: z.enum(['7d', '30d']),
  visibility: dashboardCostVisibilitySchema,
  coverage: dashboardCoverageSchema,
  delivered: dashboardDeliveredSchema,
  failures: z.object({ total: count, reasons: z.array(dashboardFailureReasonSchema).max(8) }),
  backends: z.array(dashboardBackendStatSchema),
  automations: z.array(dashboardAutomationStatSchema),
});
export type DashboardInsights = z.infer<typeof dashboardInsightsSchema>;
