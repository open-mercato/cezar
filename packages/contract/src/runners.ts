import { z } from 'zod';
import { runnerSchema } from './health.ts';
export { runnerSchema, type Runner } from './health.ts';

/** The runner ids in order — the contract-facing projection of `runnerSchema`. */
export const RUNNER_IDS = runnerSchema.options as readonly z.infer<typeof runnerSchema>[];

/**
 * One zod key per runner (<id>: schema) — the additive map every runner-bearing shape is built
 * from, so adding a runner to `runnerSchema` extends every per-runner object without hand-editing
 * a key list (the #387 review lesson: a hand-written key list silently STRIPPED every runner added
 * after the list was written). Call sites apply `.partial()` / `.optional()` as their own
 * nullability requires.
 */
export function perRunner<S extends z.ZodTypeAny>(schema: S): z.ZodObject<{ [K in z.infer<typeof runnerSchema>]: S }> {
  const shape = Object.fromEntries(runnerSchema.options.map((id: string) => [id, schema])) as {
    [K in z.infer<typeof runnerSchema>]: S;
  };
  return z.object(shape);
}
