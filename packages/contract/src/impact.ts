import { z } from 'zod';
import { runArtifactSchema, runArtifactVersionSchema, runSubjectSchema } from './artifacts.ts';
import { runnerSchema } from './health.ts';
import { runStatusSchema } from './runs.ts';

/**
 * Assess Impact (spec `.ai/specs/2026-10-22-html-artifacts-and-impact.md` § Serving): start an
 * impact run on a subject the SERVER resolves and pins, and find the newest one per subject.
 */

/** What to assess. The server pins it — a PR's fetched head sha, a spec's blob sha. */
export const impactSubjectInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pr'), number: z.number().int().positive().max(2_147_483_647) }),
  z.object({ kind: z.literal('spec'), path: z.string().min(1).max(1024) }),
]);
export type ImpactSubjectInput = z.infer<typeof impactSubjectInputSchema>;

/** `POST /impact`. `runner`/`model`/`agentProfile` mean what they mean on `POST /runs`. */
export const startImpactSchema = z.object({
  subject: impactSubjectInputSchema,
  runner: runnerSchema.optional(),
  model: z.string().optional(),
  agentProfile: z.string().max(64).optional(),
});
export type StartImpactInput = z.infer<typeof startImpactSchema>;

export const startImpactResponseSchema = z.object({ runId: z.string() });
export type StartImpactResponse = z.infer<typeof startImpactResponseSchema>;

/** `GET /artifacts?subject=pr:<n>|spec:<path>`. */
export const artifactsBySubjectQuerySchema = z.object({
  subject: z.string().regex(/^(?:pr:[1-9][0-9]{0,9}|spec:[^\0]{1,1024})$/),
});
export type ArtifactsBySubjectQuery = z.infer<typeof artifactsBySubjectQuerySchema>;

/** The newest run with that subject, or `run: null`. */
export const subjectRunSchema = z.object({
  id: z.string(),
  status: runStatusSchema,
  title: z.string(),
  createdAt: z.string(),
});
export type SubjectRun = z.infer<typeof subjectRunSchema>;

/**
 * Either no run has that subject (`run: null`, nothing listed), or the newest one with its pinned
 * subject, artifacts and kept versions. `stale`: the PR head or the spec blob moved since the run
 * pinned it — `null` when that cannot be told (GitHub unreachable, the spec gone from HEAD).
 */
export const artifactsBySubjectResponseSchema = z.union([
  z.object({
    run: z.null(),
    subject: z.null(),
    artifacts: z.array(runArtifactSchema),
    truncated: z.boolean(),
    stale: z.null(),
  }),
  z.object({
    run: subjectRunSchema,
    subject: runSubjectSchema,
    artifacts: z.array(runArtifactSchema),
    truncated: z.boolean(),
    versions: z.array(runArtifactVersionSchema).optional(),
    stale: z.boolean().nullable(),
  }),
]);
export type ArtifactsBySubjectResponse = z.infer<typeof artifactsBySubjectResponseSchema>;
