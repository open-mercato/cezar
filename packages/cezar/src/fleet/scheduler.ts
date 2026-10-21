import type { FleetJob, FleetJobReport, FleetNode } from '@open-mercato/cezar-contract';

/**
 * Pure scheduling rules for the fleet hub (spec 2026-10-21-fleet-coordination). No clock, no I/O:
 * the hub passes `now` in and applies the returned values, which keeps every rule unit-testable.
 */

export const NODE_TTL_MS = 30_000;
export const LEASE_MS = 60_000;
export const MAX_ATTEMPTS = 3;

const HELD = new Set<FleetJob['status']>(['assigned', 'running', 'review']);
const TERMINAL = new Set<FleetJob['status']>(['done', 'failed', 'cancelled']);

export const isHeld = (job: FleetJob): boolean => HELD.has(job.status);
export const isTerminal = (job: FleetJob): boolean => TERMINAL.has(job.status);

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * Who gets which pending job: FIFO jobs, each handed to the live node with the most free capacity
 * left (ties by node id, so the plan is deterministic). Returns jobId -> nodeId; jobs nobody has
 * room for stay out of the plan. A node reports its OWN effective free capacity, so a dynamically
 * limited or autoscaled node steers the distribution without the hub knowing why.
 */
export function planAssignments(pending: readonly FleetJob[], nodes: readonly FleetNode[], now: number): Map<string, string> {
  const free = new Map<string, number>();
  for (const node of nodes) {
    if (now - Date.parse(node.lastSeen) <= NODE_TTL_MS && node.capacity.free > 0) free.set(node.nodeId, node.capacity.free);
  }
  const plan = new Map<string, string>();
  const fifo = [...pending].filter((j) => j.status === 'pending').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const job of fifo) {
    let best: string | undefined;
    for (const [nodeId, room] of free) {
      if (room <= 0) continue;
      const bestRoom = best === undefined ? 0 : (free.get(best) ?? 0);
      if (best === undefined || room > bestRoom || (room === bestRoom && nodeId < best)) best = nodeId;
    }
    if (best === undefined) break;
    plan.set(job.id, best);
    free.set(best, (free.get(best) ?? 0) - 1);
  }
  return plan;
}

export function assignJob(job: FleetJob, nodeId: string, now: number): FleetJob {
  return { ...job, status: 'assigned', nodeId, leaseExpiresAt: iso(now + LEASE_MS), updatedAt: iso(now) };
}

/**
 * Held jobs whose lease ran out go back to pending with `attempts + 1`; the third failed attempt
 * fails the job instead of looping on a poisoned task. Returns only the jobs that changed.
 */
export function expireLeases(jobs: readonly FleetJob[], now: number, maxAttempts = MAX_ATTEMPTS): FleetJob[] {
  const changed: FleetJob[] = [];
  for (const job of jobs) {
    if (!isHeld(job) || !job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) > now) continue;
    const attempts = job.attempts + 1;
    const { nodeId: _node, runId: _run, branch: _branch, leaseExpiresAt: _lease, ...rest } = job;
    changed.push(
      attempts >= maxAttempts
        ? { ...rest, attempts, status: 'failed', error: `node ${job.nodeId ?? '?'} stopped answering; gave up after ${attempts} attempts`, updatedAt: iso(now) }
        : { ...rest, attempts, status: 'pending', updatedAt: iso(now) },
    );
  }
  return changed;
}

export type ReportOutcome = { action: 'ok'; job: FleetJob; changed: boolean } | { action: 'drop' } | { action: 'cancel' };

/**
 * Fold a node's report about a job into the hub's record. Idempotent: reporting a job the node does
 * not (or no longer) own — unknown, requeued, taken over by another node — answers `drop`, and a
 * job the hub cancelled answers `cancel` so the node stops the local run.
 */
export function applyReport(job: FleetJob | undefined, nodeId: string, report: FleetJobReport, now: number): ReportOutcome {
  if (!job || job.nodeId !== nodeId) return { action: 'drop' };
  if (job.status === 'cancelled') return { action: 'cancel' };
  if (isTerminal(job) || job.status === 'pending') return { action: 'drop' };
  const next: FleetJob = {
    ...job,
    status: report.status,
    ...(report.runId ? { runId: report.runId } : {}),
    ...(report.branch ? { branch: report.branch } : {}),
    ...(report.prUrl ? { prUrl: report.prUrl } : {}),
    ...(report.error ? { error: report.error } : {}),
    updatedAt: iso(now),
  };
  const done = next.status === 'done' || next.status === 'failed';
  // Terminal jobs need no lease; held ones are renewed by every report.
  if (done) delete next.leaseExpiresAt;
  else next.leaseExpiresAt = iso(now + LEASE_MS);
  const changed = (['status', 'runId', 'branch', 'prUrl', 'error'] as const).some((k) => next[k] !== job[k]);
  return { action: 'ok', job: next, changed };
}

/** Cancel: a pending job just stops; a held one is flagged so its node hears `cancel`. */
export function cancelJob(job: FleetJob, now: number): FleetJob {
  if (isTerminal(job)) return job;
  const { leaseExpiresAt: _lease, ...rest } = job;
  return { ...rest, status: 'cancelled', updatedAt: iso(now) };
}
