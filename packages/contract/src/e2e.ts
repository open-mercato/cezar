import { z } from 'zod';
import { runStatusSchema } from './runs.ts';

/**
 * One-click browser e2e setup (spec `2026-10-10-e2e-one-click-setup`): cezar installs and
 * configures TesterArmy's `e2e` in a project as an ordinary task that ends at the review gate,
 * so the user never runs `npx e2e init`, edits a config or writes a workflow by hand.
 */

/**
 * The model keys an `e2e` config can read — one per provider package the setup knows how to
 * wire. Stored as a project secret with the `checks` audience, so it reaches the check steps
 * that run `e2e` and never an agent session.
 */
export const E2E_CREDENTIAL_NAMES = ['AI_GATEWAY_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY'] as const;
export const e2eCredentialNameSchema = z.enum(E2E_CREDENTIAL_NAMES);
export type E2eCredentialName = z.infer<typeof e2eCredentialNameSchema>;

/**
 * `GET /e2e`: what this project already has. Read from the project's checkout, so a setup that
 * is still waiting at the review gate reads as not installed until its branch lands — `setup`
 * says where that run is.
 */
export const e2eStatusSchema = z.object({
  /** The `e2e.config.*` file at the repository root, or `null`. */
  configFile: z.string().nullable(),
  /** `.ai/cezar/workflows/implement-and-e2e.yaml` exists. */
  workflow: z.boolean(),
  /** Which of `E2E_CREDENTIAL_NAMES` the project's check steps can read (project or workspace secrets). */
  credentials: z.array(e2eCredentialNameSchema),
  /** The most recent setup run, or `null` when none was started. */
  setup: z.object({ runId: z.string(), status: runStatusSchema }).nullable(),
});
export type E2eStatus = z.infer<typeof e2eStatusSchema>;

/**
 * `POST /e2e/setup`: start the setup task. `credential`, when given, is stored first as a
 * project secret (audience `checks`) — the same write `PUT /secrets/:name` does.
 */
export const e2eSetupInputSchema = z.object({
  credential: z.object({ name: e2eCredentialNameSchema, value: z.string().min(1) }).strict().optional(),
});
export type E2eSetupInput = z.infer<typeof e2eSetupInputSchema>;

export const e2eSetupResponseSchema = z.object({ runId: z.string() });
export type E2eSetupResponse = z.infer<typeof e2eSetupResponseSchema>;

export const e2eErrorSchema = z.object({ error: z.string() }).strict();
export type E2eErrorResponse = z.infer<typeof e2eErrorSchema>;
