import { z } from 'zod';
import { dashboardCoverageSchema, dashboardTaskRowSchema } from './dashboard.ts';

const count = z.number().int().nonnegative();
export const dashboardOverviewGroupSchema = z.enum([
  'running',
  'needs-you',
  'completed',
  'failed',
]);
export type DashboardOverviewGroup = z.infer<typeof dashboardOverviewGroupSchema>;
export const dashboardOverviewQuerySchema = z.object({
  period: z.enum(['7d', '30d']).default('7d'),
  tzOffsetMinutes: z.coerce.number().int().min(-840).max(720).default(0),
  snapshotId: z.string().min(1).max(128).optional(),
  projectId: z.string().min(1).max(128).optional(),
  group: dashboardOverviewGroupSchema.default('completed'),
  offset: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.coerce.number().int().min(1).max(20).default(20),
});
export type DashboardOverviewQuery = z.infer<typeof dashboardOverviewQuerySchema>;
export const dashboardOutcomeMetricsSchema = z.object({
  running: count,
  needsYou: count,
  completed: count,
  failed: count,
  timedTasks: count,
  medianCycleHours: z.number().finite().nonnegative().nullable(),
});
export const dashboardOverviewTaskSchema = dashboardTaskRowSchema.pick({
  projectId: true,
  id: true,
  title: true,
  titleSummary: true,
  status: true,
  archived: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
});
export const dashboardOverviewSchema = z.object({
  snapshotId: z.string(),
  asOf: z.iso.datetime(),
  windowStart: z.iso.datetime(),
  period: z.enum(['7d', '30d']),
  coverage: dashboardCoverageSchema,
  metrics: dashboardOutcomeMetricsSchema,
  projects: z.array(dashboardOutcomeMetricsSchema.extend({ projectId: z.string() })),
  page: z.object({
    rows: z.array(dashboardOverviewTaskSchema).max(20),
    total: count,
    nextOffset: count.nullable(),
  }),
});
export type DashboardOverview = z.infer<typeof dashboardOverviewSchema>;
