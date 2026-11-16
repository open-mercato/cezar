import { z } from 'zod';
import { scriptEntrySchema } from './worktree-lifecycle.ts';

/**
 * Trusted, project-local policy that runs immediately before an agent session.
 * Like worktree lifecycle scripts, this is intentionally accepted only from an
 * untracked `.ai/cezar/config.json`; a repository cannot opt its clone into
 * executing a command.
 */
export const agentAdmissionConfigSchema = z.object({
  beforeAgent: scriptEntrySchema,
}).strict();
export type AgentAdmissionConfig = z.infer<typeof agentAdmissionConfigSchema>;

export const agentAdmissionDecisionSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('allow'), handle: z.string().max(4096).optional() }).strict(),
  z.object({ decision: z.literal('deny'), reason: z.string().min(1).max(4096) }).strict(),
]);
export type AgentAdmissionDecision = z.infer<typeof agentAdmissionDecisionSchema>;
