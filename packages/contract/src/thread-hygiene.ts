import { z } from 'zod';

export const THREAD_CONTINUATION_LIMIT = 3;
export const THREAD_HYGIENE_REQUIRED = 'Long thread: choose Continue work or Prepare handoff before another continuation.';
export const threadHygieneSchema = z.object({
  graphPaused: z.boolean().optional(),
  preparingHandoff: z.boolean().optional(),
  continuations: z.number().int().nonnegative(),
  historyKnown: z.boolean(),
  lastOperationId: z.string().optional(),
  operationIds: z.array(z.string()).optional(),
  lastReason: z.string().optional(),
  pending: z.object({ reason: z.string(), since: z.string() }).optional(),
});
export type ThreadHygiene = z.infer<typeof threadHygieneSchema>;
export const threadDecisionSchema = z.object({
  action: z.enum(['continue', 'handoff']),
  expectedCount: z.number().int().nonnegative(),
});
export type ThreadDecision = z.infer<typeof threadDecisionSchema>;
export const threadStatusSchema = z.object({
  status: z.string(),
  handoff: z.string(),
  contentUpdatedAt: z.string().nullable(),
  continuations: z.number().int().nonnegative().nullable(),
  historyKnown: z.boolean(),
});
export type ThreadStatus = z.infer<typeof threadStatusSchema>;

export const PREPARE_HANDOFF_PROMPT = `Prepare a forward-looking handoff for the user to review. Do not create or start a successor, close this task, or renew any budget or approval. Respect existing limits. Save Resume notes using node "$CEZ_BIN" handoff resume. Include the goal and acceptance criteria, actual completed state, the successor's first concrete step, blockers and open decisions, approval limits, spent/remaining budget, continuation count, existing branch/PR/worktree and recovery instructions. Select useful predecessor outputs, especially early UI mockups and the accepted design. For each, explain why to open it and preserve the exact version AND dependencies (images/styles) outside the worktree; Use node "$CEZ_BIN" handoff retain "<Assets-relative file>" "<why open it>" for each selected artifact; it retains a version with local dependencies and returns a manifest with hashes. For files outside Assets, first copy the selected artifact and its dependencies into Assets; never read credentials. Record source, retained location and version/hash. Verify the retained copy can be opened by the successor; mark missing/unverified material honestly. Do not delete originals or copy the entire conversation. Link the manifest from Resume notes. Finish preparing and return for user review; successor creation is a separate user action.`;
