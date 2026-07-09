import { z } from 'zod';

/**
 * Wire contract for `POST /api/runner/register` — the join-token runner
 * registration flow. The daemon presents a workspace member's join token
 * (minted in Settings → Runners) as `Authorization: Bearer <join-token>`
 * with this body; the SaaS creates (or re-keys) the `runners` row owned by
 * the token's creator and returns the per-runner bearer token the daemon
 * persists and uses for every subsequent claim/heartbeat/finalize call.
 *
 * Lives in `@cezar/core` because both sides validate it at the boundary:
 * the GUI route parses the request, the runner parses the response.
 */
export const RunnerRegisterRequestSchema = z.object({
  /** Runner display name; (workspace, owner, name) identifies the runner. */
  name: z.string().min(1).max(80),
  kind: z.enum(['cloud', 'self-hosted']).default('self-hosted'),
  backends: z.array(z.enum(['anthropic-api', 'claude-cli', 'codex-cli'])).min(1),
});
export type RunnerRegisterRequest = z.infer<typeof RunnerRegisterRequestSchema>;

export const RunnerRegisterResponseSchema = z.object({
  runnerId: z.string().uuid(),
  /** The per-runner bearer token — travels only in this one response. */
  token: z.string().min(1),
  workspaceId: z.string().uuid(),
  /** GitHub login of the runner's owner (the join token's creator). */
  ownerLogin: z.string(),
  /** True when an existing (workspace, owner, name) row was re-keyed
   *  instead of a new row created — the old runner token is now invalid. */
  reRegistered: z.boolean(),
});
export type RunnerRegisterResponse = z.infer<typeof RunnerRegisterResponseSchema>;
