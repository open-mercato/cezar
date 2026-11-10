import { z } from 'zod';

import { terminalSessionSchema } from './terminal.ts';

/**
 * Installing and signing in to an agent from the first-run page (spec
 * 2026-10-26-first-run-onboarding, "Set up an agent here"). A request names a provider and an
 * action; the command always comes from the server's own catalog.
 */

/** The agents cezar knows how to install. */
export const agentSetupProviderSchema = z.enum(['claude', 'codex', 'opencode', 'cursor', 'copilot']);
export type AgentSetupProvider = z.infer<typeof agentSetupProviderSchema>;

export const agentSetupActionSchema = z.enum(['install', 'login']);
export type AgentSetupAction = z.infer<typeof agentSetupActionSchema>;

export const agentSetupEntrySchema = z.object({
  provider: agentSetupProviderSchema,
  /** Null when nothing on this machine can install it (no npm, no curl); `installHint` says what to do. */
  installCommand: z.string().nullable(),
  installHint: z.string(),
  loginCommand: z.string().nullable(),
});
export type AgentSetupEntry = z.infer<typeof agentSetupEntrySchema>;

export const agentSetupSessionSchema = terminalSessionSchema.extend({
  provider: agentSetupProviderSchema,
  action: agentSetupActionSchema,
  /** What this session runs, shown above its screen. */
  command: z.string(),
});
export type AgentSetupSession = z.infer<typeof agentSetupSessionSchema>;

/** `GET /api/v1/providers/setup`. Unavailable (hosted, terminal off, no PTY) is an answer, not an
 *  error: the page then falls back to commands to copy. */
export const agentSetupStateSchema = z.discriminatedUnion('available', [
  z.object({ available: z.literal(false), reason: z.string() }),
  z.object({
    available: z.literal(true),
    agents: z.array(agentSetupEntrySchema),
    /** The running or just-finished session, so a reload reattaches instead of starting another install. */
    session: agentSetupSessionSchema.nullable(),
  }),
]);
export type AgentSetupState = z.infer<typeof agentSetupStateSchema>;

/** `POST /api/v1/providers/setup/sessions`. */
export const agentSetupStartSchema = z.object({
  provider: agentSetupProviderSchema,
  action: agentSetupActionSchema,
  cols: z.number().int().min(1).max(500).optional(),
  rows: z.number().int().min(1).max(500).optional(),
});
export type AgentSetupStart = z.infer<typeof agentSetupStartSchema>;

export const agentSetupSessionParamsSchema = z.object({ sessionId: z.string() });
