import { z } from 'zod';
import { runnerSchema } from './health.ts';
import { runRecordSchema } from './runs.ts';
import { cardIssueSchema } from './card-record.ts';

/**
 * The `/cards` family (spec 2026-11-15-framework-board): a card is a run whose workflow is a
 * compiled framework. Gate approve / request changes on `gate.human` reuse the ask-answer route;
 * `POST /cards/:runId/approve` is the SDD framework gate only (D9).
 */

const stageId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'stage ids are letters, digits, "-" and "_"');
const cardFields = z.record(z.string(), z.union([z.string(), z.boolean()]));

export const cardRunIdParamSchema = z.object({ runId: z.string().min(1) });
export type CardRunIdParam = z.infer<typeof cardRunIdParamSchema>;

/** `POST /cards` — compiles the framework and queues the run, `held` unless `ready: true`. */
export const createCardBodySchema = z.object({
  title: z.string().trim().min(1).max(200),
  brief: z.string().max(100_000).optional(),
  /** Absent = the project's active framework (D6). */
  framework: stageId.optional(),
  fields: cardFields.optional(),
  issue: cardIssueSchema.optional(),
  ready: z.boolean().optional(),
  autonomous: z.boolean().optional(),
  startAt: stageId.optional(),
  skip: z.array(stageId).optional(),
  overrides: z.record(z.string(), z.object({ model: z.string().min(1).optional(), runner: runnerSchema.optional() })).optional(),
  budgetUsd: z.number().positive().optional(),
});
export type CreateCardBody = z.infer<typeof createCardBodySchema>;

/** `PATCH /cards/:runId` — `fields`, `title` and `brief` only while the card is held (Backlog). */
export const patchCardBodySchema = z
  .object({
    held: z.boolean().optional(),
    order: z.number().optional(),
    autonomous: z.boolean().optional(),
    fields: cardFields.optional(),
    title: z.string().trim().min(1).max(200).optional(),
    brief: z.string().max(100_000).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'nothing to change' });
export type PatchCardBody = z.infer<typeof patchCardBodySchema>;

/** The store's record, as `PATCH /runs/:id` answers it (no live `usage`). */
export const cardRunResponseSchema = z.object({ run: runRecordSchema });
export type CardRunResponse = z.infer<typeof cardRunResponseSchema>;

/** `POST /cards/:runId/rerun` — reset the graph cursor to that stage's first node. */
export const rerunCardBodySchema = z.object({ fromStage: stageId });
export type RerunCardBody = z.infer<typeof rerunCardBodySchema>;

/** Bodies of `finish-stage`, `approve` and `recheck`: nothing, but an object. */
export const emptyCardBodySchema = z.object({});
export type EmptyCardBody = z.infer<typeof emptyCardBodySchema>;

export const cardOkResponseSchema = z.object({ ok: z.literal(true) });
export type CardOkResponse = z.infer<typeof cardOkResponseSchema>;
