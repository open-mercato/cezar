import { z } from 'zod';

/** The user-selectable agent runners, in display order. */
export const RUNNER_IDS = ['claude', 'codex', 'opencode', 'pi', 'gemini'] as const;

export const runnerSchema = z.enum(RUNNER_IDS);
export type Runner = z.infer<typeof runnerSchema>;

/** Build a record-shaped schema whose keys stay coupled to the runner tuple. */
export function perRunner<S extends z.ZodTypeAny>(schema: S): z.ZodObject<{ [K in Runner]: S }> {
  const shape = Object.fromEntries(RUNNER_IDS.map((id) => [id, schema])) as { [K in Runner]: S };
  return z.object(shape);
}
