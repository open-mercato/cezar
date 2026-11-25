import { z } from 'zod';

/**
 * The board metadata a framework card carries on its run record (spec 2026-11-15-framework-board,
 * D1). Its own module so `runs.ts` can embed it while `cards.ts` (whose answers embed the run)
 * imports `runs.ts` — one direction only, like `workflows.ts`.
 */

/** Per-stage progress on a card's strip (D4); `stale` is the framework's own word (D7). */
export const cardStageStatusSchema = z.enum(['pending', 'running', 'waiting', 'done', 'failed', 'skipped', 'stale']);
export type CardStageStatus = z.infer<typeof cardStageStatusSchema>;

export const cardBlockedSchema = z.object({
  reason: z.enum(['wip', 'precheck', 'gate']),
  detail: z.string().optional(),
  since: z.string(),
});
export type CardBlocked = z.infer<typeof cardBlockedSchema>;

export const cardIssueSchema = z.object({ provider: z.string(), ref: z.string(), url: z.string().optional() });
export type CardIssue = z.infer<typeof cardIssueSchema>;

/** Card history is capped so a long-lived card cannot grow its run record without bound. */
export const CARD_HISTORY_CAP = 50;

export const runCardSchema = z.object({
  framework: z.string(),
  frameworkHash: z.string(),
  title: z.string(),
  stage: z.string(),
  stages: z.record(z.string(), cardStageStatusSchema),
  /** Column order snapshot: the framework's stages at creation. */
  stageOrder: z.array(z.string()),
  /** Backlog (D2): the scheduler skips a held card. */
  held: z.boolean().optional(),
  order: z.number().optional(),
  autonomous: z.boolean().optional(),
  fields: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
  blocked: cardBlockedSchema.optional(),
  /** D7, SDD only. `changeId` is the framework's full change id (`<date>-<slug>`); `lastStatus` is
   *  the framework's raw per-stage status — a string map, not `unknown`, which hono cannot type. */
  frameworkState: z.object({ changeId: z.string(), lastStatus: z.record(z.string(), z.string()).optional() }).optional(),
  history: z.array(z.object({ at: z.string(), text: z.string() })).max(CARD_HISTORY_CAP).optional(),
  issue: cardIssueSchema.optional(),
  /** D3: the framework's `state` as the card was created with it, so an in-flight card never
   *  re-reads the framework file (a deleted or edited YAML must not strand a parked card). */
  frameworkStateDef: z.object({ command: z.string(), watch: z.string().optional() }).optional(),
  /** D3, like `frameworkStateDef`: the framework's `requires` paths, checked at every stage entry. */
  requires: z.array(z.string()).optional(),
  /** Set while the card is parked at a gate (`approve` = `gate.human`, `framework` = D9's
   *  `gate.framework`, whose `approve` names the framework stage or is null), cleared on leave. */
  gate: z.object({ kind: z.enum(['approve', 'framework']), approve: z.string().nullable().optional() }).optional(),
  /** True while the card is parked in a conversation stage waiting for the user (D10). */
  conversation: z.boolean().optional(),
});
export type RunCard = z.infer<typeof runCardSchema>;

/**
 * A card that has not started its walk: queued with no graph cursor. A card re-queued mid-walk
 * (restart recovery, re-run, a usage-limit send-back) is `queued` too, but carries its cursor —
 * it may not move to the Backlog nor have its content recompiled. Shared by engine and cockpit.
 */
export function cardNotStarted(run: { status: string; graphState?: { cursor?: string } | undefined }): boolean {
  return run.status === 'queued' && !run.graphState?.cursor;
}
