import { z } from 'zod';
import { runnerSchema as providerIdSchema } from './runners.ts';

/**
 * Inline account reconnect (spec 2026-11-18-inline-account-reconnect): a server-side login
 * session wraps the vendor's own sign-in so the cockpit can finish it without a terminal.
 * Tokens and pasted keys never appear in any of these shapes.
 */

/** What the card shows while signing in. `terminal` is the fallback for CLIs with no headless login. */
export const loginMethodSchema = z.enum(['browser', 'link', 'device', 'paste', 'key', 'terminal']);
export type LoginMethod = z.infer<typeof loginMethodSchema>;

export const loginPhaseSchema = z.enum(['starting', 'waiting', 'needs-input', 'verifying', 'connected', 'failed', 'cancelled']);
export type LoginPhase = z.infer<typeof loginPhaseSchema>;

/** Fixed failure reasons; never vendor output. */
export const loginFailureReasonSchema = z.enum([
  'expired',
  'rejected',
  'account-mismatch',
  'exited',
  'not-installed',
  'timeout',
  'unavailable',
]);
export type LoginFailureReason = z.infer<typeof loginFailureReasonSchema>;

/** `POST /api/v1/providers/login`. `method` asks for a specific path (e.g. `key`, `device`); absent = the best one for this cockpit. */
export const loginSessionStartSchema = z.object({
  provider: providerIdSchema,
  profileId: z.string().max(64).optional(),
  method: loginMethodSchema.optional(),
  /** OpenCode only: which of its auth providers to sign into (`openai`, `github-copilot`, …). */
  authProvider: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/).optional(),
}).strict();
export type LoginSessionStartInput = z.infer<typeof loginSessionStartSchema>;

/** Blocked work the reconnect restarted. */
export const reconnectResumedSchema = z.object({
  runs: z.array(z.object({ projectId: z.string(), runId: z.string(), title: z.string() })),
  managers: z.array(z.object({ managerId: z.string(), title: z.string() })),
});
export type ReconnectResumed = z.infer<typeof reconnectResumedSchema>;

/** One login session: the start route's answer, and the workspace SSE `agent-login` payload. */
export const loginSessionSchema = z.object({
  sessionId: z.string(),
  provider: providerIdSchema,
  /** `default` for the discovered login. */
  profileId: z.string(),
  method: loginMethodSchema,
  phase: loginPhaseSchema,
  /** Verification page, allow-listed per provider. */
  url: z.string().optional(),
  /** Device / one-time code to type on the verification page. */
  userCode: z.string().optional(),
  expiresAt: z.string().optional(),
  reason: loginFailureReasonSchema.optional(),
  /** Terminal fallback (`terminal` method, hosted refusals). */
  command: z.string().optional(),
  /** `key` method on OpenCode: the provider ids a key can be saved for. */
  keyProviders: z.array(z.string()).optional(),
  /** Present once `connected`: what the reconnect resumed. */
  resumed: reconnectResumedSchema.optional(),
});
export type LoginSession = z.infer<typeof loginSessionSchema>;

/** `POST /api/v1/providers/login/:sessionId/input` — a pasted code, or an API key (Codex, OpenCode only). */
export const loginSessionInputSchema = z.union([
  z.object({ code: z.string().min(1).max(512) }).strict(),
  z.object({ apiKey: z.string().min(1).max(512), keyProvider: z.string().max(64).optional() }).strict(),
]);
export type LoginSessionInput = z.infer<typeof loginSessionInputSchema>;

/** Workspace SSE `account-reconnected`: an account came back (any path), and what it resumed. */
export const accountReconnectedEventSchema = z.object({
  provider: providerIdSchema,
  profileId: z.string(),
  resumed: reconnectResumedSchema,
});
export type AccountReconnectedEvent = z.infer<typeof accountReconnectedEventSchema>;

/** Why a run is parked at `waiting` instead of failing. Absent = an ordinary wait. */
export const runParkedSchema = z.object({
  kind: z.literal('auth'),
  provider: providerIdSchema,
  profileId: z.string(),
  authFailureId: z.string().optional(),
  stepId: z.string().optional(),
  at: z.string(),
});
export type RunParked = z.infer<typeof runParkedSchema>;
