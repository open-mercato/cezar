import { z } from 'zod';
import { runArtifactKindSchema, runSubjectSchema } from './artifacts.ts';
import { runStatusSchema } from './runs.ts';

/**
 * The project Assets page (spec `.ai/specs/2026-10-22-html-artifacts-and-impact.md`, Phase 3):
 * every artifact across the project's runs, one row per (run, file).
 */

/** At most this many rows; `truncated` says more existed. */
export const MAX_PROJECT_ASSETS = 500;

export const projectAssetSchema = z.object({
  runId: z.string(),
  /** `titleSummary ?? title`. */
  runTitle: z.string(),
  runStatus: runStatusSchema,
  /** What an impact run assessed — absent for any other run. */
  subject: runSubjectSchema.optional(),
  name: z.string(),
  kind: runArtifactKindSchema,
  title: z.string().optional(),
  size: z.number().int(),
  /** mtime, ISO-8601 — the sort key, newest first. */
  updatedAt: z.string(),
  /** Kept revisions holding this file, counting the current one when none was kept (≥ 1). */
  versionCount: z.number().int().positive(),
  /** The subject moved since the run pinned it; `null` without a subject or when it cannot be
   *  told cheaply (a PR head is read from cache only — the list never calls GitHub). */
  stale: z.boolean().nullable(),
});
export type ProjectAsset = z.infer<typeof projectAssetSchema>;

/** `GET /assets`. */
export const projectAssetsResponseSchema = z.object({
  assets: z.array(projectAssetSchema),
  truncated: z.boolean(),
});
export type ProjectAssetsResponse = z.infer<typeof projectAssetsResponseSchema>;
