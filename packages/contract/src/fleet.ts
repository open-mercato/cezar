import { z } from 'zod';
import { runnerSchema } from './health.ts';

/**
 * Fleet coordination wire shapes (spec `2026-10-21-fleet-coordination`). They travel on the fleet
 * listener (`/api/v1/fleet/*`, bearer token) — a separate port from the cockpit API, opt-in via
 * `CEZ_FLEET_*`. Same discipline as the rest of the contract: one schema, type inferred.
 */

export const fleetJobStatusSchema = z.enum(['pending', 'assigned', 'running', 'review', 'done', 'failed', 'cancelled']);
export type FleetJobStatus = z.infer<typeof fleetJobStatusSchema>;

/** Statuses a worker may report for a job it holds (the hub owns pending/assigned/cancelled). */
export const fleetReportedStatusSchema = z.enum(['running', 'review', 'done', 'failed']);

export const fleetJobSchema = z.object({
  id: z.string(),
  repoUrl: z.string(),
  baseBranch: z.string().optional(),
  task: z.string(),
  workflowId: z.string().optional(),
  runner: runnerSchema.optional(),
  model: z.string().optional(),
  openPr: z.boolean(),
  status: fleetJobStatusSchema,
  nodeId: z.string().optional(),
  runId: z.string().optional(),
  branch: z.string().optional(),
  prUrl: z.string().optional(),
  error: z.string().optional(),
  leaseExpiresAt: z.string().optional(),
  attempts: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type FleetJob = z.infer<typeof fleetJobSchema>;

export const fleetSubmitSchema = z.object({
  repoUrl: z.string().trim().min(1).max(500),
  task: z.string().trim().min(1).max(20_000),
  // A plain branch name: no leading dash or dot, nothing exotic.
  baseBranch: z.string().trim().regex(/^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/).optional(),
  workflowId: z.string().trim().min(1).max(200).optional(),
  runner: runnerSchema.optional(),
  model: z.string().trim().min(1).max(200).optional(),
  openPr: z.boolean().optional(),
});
export type FleetSubmit = z.infer<typeof fleetSubmitSchema>;

export const fleetNodeSchema = z.object({
  nodeId: z.string().min(1).max(200),
  lastSeen: z.string(),
  capacity: z.object({ free: z.number().int().nonnegative(), max: z.number().int().nonnegative() }),
  host: z.object({ cpuPct: z.number().optional(), memAvailableBytes: z.number().optional() }),
  version: z.string(),
});
export type FleetNode = z.infer<typeof fleetNodeSchema>;

/** What a worker says about a job it holds. */
export const fleetJobReportSchema = z.object({
  id: z.string(),
  status: fleetReportedStatusSchema,
  runId: z.string().optional(),
  branch: z.string().optional(),
  prUrl: z.string().optional(),
  error: z.string().optional(),
});
export type FleetJobReport = z.infer<typeof fleetJobReportSchema>;

export const fleetHeartbeatSchema = fleetNodeSchema.omit({ lastSeen: true }).extend({
  jobs: z.array(fleetJobReportSchema).max(1000),
});
export type FleetHeartbeat = z.infer<typeof fleetHeartbeatSchema>;

export const fleetHeartbeatResponseSchema = z.object({
  /** Newly assigned jobs, at most the node's reported free capacity. */
  assigned: z.array(fleetJobSchema),
  /** Held jobs the hub cancelled: stop the local run. */
  cancel: z.array(z.string()),
  /** Reported jobs this node no longer owns (requeued, unknown): stop and forget. */
  drop: z.array(z.string()),
});
export type FleetHeartbeatResponse = z.infer<typeof fleetHeartbeatResponseSchema>;

export const fleetStatusResponseSchema = z.object({
  nodes: z.array(fleetNodeSchema),
  jobs: z.array(fleetJobSchema),
});
export type FleetStatusResponse = z.infer<typeof fleetStatusResponseSchema>;
