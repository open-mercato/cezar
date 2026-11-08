import { z } from 'zod';
import { HARNESS_RESULT_LIMITS } from './prompt-budget.js';

export const harnessStageResultSchema = z
  .object({
    status: z.literal('ready'),
    startHead: z.string().optional(),
    currentHead: z.string().optional(),
    branch: z.string().optional(),
    worktree: z.string().optional(),
    // Runtime-written from git, and `samePathSet` proves the set: a count cap only made a large
    // handoff fatal.
    stagedPaths: z.array(z.string().min(1).max(HARNESS_RESULT_LIMITS.path)),
    // Advisory: an oversized warning is truncated, never a failed stage (run aad28178).
    warnings: z
      .array(z.string())
      .transform((warnings) =>
        warnings
          .filter((warning) => warning.length > 0)
          .slice(0, 20)
          .map((warning) => warning.slice(0, HARNESS_RESULT_LIMITS.summary)),
      )
      .optional(),
  })
  .passthrough();

export type HarnessStageResult = z.infer<typeof harnessStageResultSchema>;

export function samePathSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(left);
  return right.every((path) => expected.has(path));
}
