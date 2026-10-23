import { z } from 'zod';

/**
 * How a project starts its app for the task Preview (spec `.ai/specs/2026-10-09-design-mode.md`
 * §7c). Optional: without one, "Run the app" discovers a start command. One-off preparation
 * (`npm ci`, migrations) is not part of it — that belongs to the worktree's setup.
 *
 * `services` are long-running commands, each started in its own terminal tab of the task, in
 * order. `url` is the address the Preview shows once the app is up; absent, the first address a
 * service prints.
 */
export const startAppRecipeSchema = z.object({
  services: z.array(z.string().trim().min(1).max(500)).min(1).max(5),
  url: z
    .string()
    .trim()
    .max(2048)
    .regex(/^https?:\/\/\S+$/, 'an http:// or https:// address')
    .optional(),
});
export type StartAppRecipe = z.infer<typeof startAppRecipeSchema>;

/** Where a recipe comes from: the repo's `.ai/cezar/config.json` (shared with the team) or this
 *  user's own entry for the project in `~/.cezar/config.json`, which wins. */
export const START_APP_SCOPES = ['project', 'personal'] as const;
export const startAppScopeSchema = z.enum(START_APP_SCOPES);
export type StartAppScope = z.infer<typeof startAppScopeSchema>;

/** `GET /api/v1/start-app` and the answer to its `PUT`. */
export const startAppStateSchema = z.object({
  project: startAppRecipeSchema.nullable(),
  personal: startAppRecipeSchema.nullable(),
  /** False where this project has no entry in the user's registry to hold a personal recipe. */
  personalAvailable: z.boolean(),
});
export type StartAppState = z.infer<typeof startAppStateSchema>;

/** `PUT /api/v1/start-app` — `recipe: null` removes that scope's recipe. */
export const startAppSetSchema = z.object({
  scope: startAppScopeSchema,
  recipe: startAppRecipeSchema.nullable(),
});
export type StartAppSet = z.infer<typeof startAppSetSchema>;

/** The recipe in force, and where it came from — carried on `/runs/:id/terminal/commands`. */
export const effectiveStartAppSchema = startAppRecipeSchema.extend({ scope: startAppScopeSchema });
export type EffectiveStartApp = z.infer<typeof effectiveStartAppSchema>;
