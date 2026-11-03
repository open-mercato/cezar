import { z } from 'zod';
import { processUsageSchema, runIndexEntrySchema } from './runs.ts';

const count = z.number().int().nonnegative();
const iso = z.iso.datetime();
export const dashboardTaskRowSchema = runIndexEntrySchema.omit({ usage: true });
export type DashboardTaskRow = z.infer<typeof dashboardTaskRowSchema>;
export const dashboardProjectCoverageSchema = z.object({
  projectId: z.string(), state: z.enum(['complete', 'partial', 'unavailable']),
  omittedRuns: count, reason: z.string().optional(),
});
export const dashboardCoverageSchema = z.object({ projects: z.array(dashboardProjectCoverageSchema) });
export type DashboardCoverage = z.infer<typeof dashboardCoverageSchema>;
export const dashboardCountsSchema = z.object({
  running: count, monitoring: count, questions: count, reviews: count, queued: count, scheduled: count,
});
export type DashboardCounts = z.infer<typeof dashboardCountsSchema>;
export const dashboardPageSchema = z.object({ rows: z.array(dashboardTaskRowSchema).max(20), total: count, nextOffset: count.nullable() });
export type DashboardPage = z.infer<typeof dashboardPageSchema>;
export const dashboardSnapshotSchema = z.object({
  snapshotId: z.string().min(1), asOf: iso, expiresAt: iso, coverage: dashboardCoverageSchema,
  counts: dashboardCountsSchema, questions: dashboardPageSchema, reviews: dashboardPageSchema,
});
export type DashboardSnapshot = z.infer<typeof dashboardSnapshotSchema>;
export const dashboardGroupSchema = z.enum(['running', 'queued', 'scheduled', 'questions', 'reviews', 'needs-you']);
export type DashboardGroup = z.infer<typeof dashboardGroupSchema>;
export const dashboardTasksQuerySchema = z.object({
  snapshotId: z.string().min(1).max(128), group: dashboardGroupSchema,
  offset: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.coerce.number().int().min(1).max(20).default(20),
});
export const dashboardTasksPageSchema = z.object({
  snapshotId: z.string(), asOf: iso, coverage: dashboardCoverageSchema, page: dashboardPageSchema,
});
export type DashboardTasksPage = z.infer<typeof dashboardTasksPageSchema>;
export const dashboardSnapshotExpiredSchema = z.object({ error: z.literal('Dashboard changed; refresh the list'), code: z.literal('snapshot-expired') });
export const dashboardTelemetrySampleSchema = z.object({
  projectId: z.string(), runId: z.string(), sampledAt: iso,
  cpuPct: z.number().nonnegative().nullable(), rssBytes: count, procCount: count,
});
export type DashboardTelemetrySample = z.infer<typeof dashboardTelemetrySampleSchema>;
export const dashboardTelemetrySchema = z.object({ asOf: iso, samples: z.array(dashboardTelemetrySampleSchema) });
export type DashboardTelemetry = z.infer<typeof dashboardTelemetrySchema>;
export const dashboardTaskResultSchema = z.object({ kind: z.literal('task-result'), key: z.string().min(1), at: iso, run: dashboardTaskRowSchema });
export const dashboardForgeCreatedSchema = z.object({
  kind: z.literal('github-created'), key: z.string().min(1), at: iso, repo: z.string(),
  projectIds: z.array(z.string()), itemKind: z.enum(['issue', 'pr']), number: z.number().int().positive(),
  title: z.string(), url: z.url().refine((s) => /^https?:\/\//.test(s), 'Expected an HTTP(S) URL'),
});
export type DashboardForgeCreated = z.infer<typeof dashboardForgeCreatedSchema>;
export const dashboardFeedRowSchema = z.discriminatedUnion('kind', [dashboardTaskResultSchema, dashboardForgeCreatedSchema]);
export type DashboardFeedRow = z.infer<typeof dashboardFeedRowSchema>;
export const dashboardFeedSourceSchema = z.object({
  key: z.string().min(1), state: z.enum(['ready', 'stale', 'unavailable']), fetchedAt: iso.optional(), truncated: z.boolean(), reason: z.string().optional(),
});
export type DashboardFeedSource = z.infer<typeof dashboardFeedSourceSchema>;
export const dashboardFeedFilterSchema = z.enum(['all', 'tasks', 'github']);
export const dashboardFeedQuerySchema = z.object({ filter: dashboardFeedFilterSchema.default('all') });
export const dashboardFeedSchema = z.object({
  asOf: iso, windowStart: iso, filter: dashboardFeedFilterSchema, rows: z.array(dashboardFeedRowSchema).max(60),
  sources: z.array(dashboardFeedSourceSchema), coverage: dashboardCoverageSchema, truncated: z.boolean(),
});
export type DashboardFeed = z.infer<typeof dashboardFeedSchema>;

/** Additive workspace-only telemetry, leaving the scoped legacy usage payload unchanged. */
export const dashboardWorkspaceUsageSchema = z.object({
  project: z.string(), usage: z.record(z.string(), processUsageSchema),
  samples: z.array(dashboardTelemetrySampleSchema).optional(), sentAt: iso.optional(),
});
