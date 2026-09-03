import { z } from 'zod';
import { HARNESS_RESULT_LIMITS } from './prompt-budget.js';

export const harnessStageResultSchema = z
  .object({
    status: z.literal('ready'),
    startHead: z.string().optional(),
    currentHead: z.string().optional(),
    branch: z.string().optional(),
    worktree: z.string().optional(),
    stagedPaths: z
      .array(z.string().min(1).max(HARNESS_RESULT_LIMITS.path))
      .max(HARNESS_RESULT_LIMITS.paths),
    warnings: z
      .array(z.string().min(1).max(HARNESS_RESULT_LIMITS.summary))
      .max(20)
      .optional(),
  })
  .passthrough();

export type HarnessStageResult = z.infer<typeof harnessStageResultSchema>;

export function samePathSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(left);
  return right.every((path) => expected.has(path));
}
