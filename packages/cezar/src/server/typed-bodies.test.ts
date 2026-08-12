import type { ExtractSchema } from 'hono/types';
import { describe, expect, it } from 'vitest';
import type { AppType } from './app-type.ts';

/**
 * Every mutating route must reach `AppType` WITH its request body typed.
 *
 * This exists because the failure mode is silent. Hono accumulates route types only through the
 * chained builder, and when a handler's validator has a type it cannot resolve — a generically
 * derived schema, say — it does not error: it drops the route from the schema entirely. Both
 * ui-state PUTs disappeared from `AppType` that way while the server still served them, the
 * cockpit still called them, and every runtime test still passed. Nothing but a check like this
 * one notices.
 *
 * These are compile-time assertions; `tsc --noEmit -p tsconfig.test.json` (npm run typecheck) is
 * what enforces them. The `it()` at the bottom is only so the file also reports as a test.
 */
describe('every mutating route carries a typed body into AppType', () => {
  type Schema = ExtractSchema<AppType>;

  /** True when `Path` answers `Method` and that method declares a JSON body. */
  type HasTypedBody<Path extends keyof Schema, Method extends PropertyKey> = Schema[Path] extends Record<
    Method,
    { input: { json: unknown } }
  >
    ? true
    : false;

  type Assert<T extends true> = T;

  // Project-scoped routes are asserted on their unscoped spelling; the `/api/v1/p/:projectId`
  // mount is the same sub-app, so it stands or falls with this one.
  type _Checks = [
    Assert<HasTypedBody<'/api/v1/runs', '$post'>>,
    Assert<HasTypedBody<'/api/v1/plan', '$post'>>,
    Assert<HasTypedBody<'/api/v1/automations', '$post'>>,
    Assert<HasTypedBody<'/api/v1/automations/:id', '$put'>>,
    Assert<HasTypedBody<'/api/v1/automations/:id/check', '$post'>>,
    Assert<HasTypedBody<'/api/v1/projects', '$post'>>,
    Assert<HasTypedBody<'/api/v1/projects/checkout', '$post'>>,
    Assert<HasTypedBody<'/api/v1/projects/:projectId', '$patch'>>,
    Assert<HasTypedBody<'/api/v1/workspace/agent-profiles', '$post'>>,
    Assert<HasTypedBody<'/api/v1/workspace/agent-profiles/:id', '$patch'>>,
    Assert<HasTypedBody<'/api/v1/workspace/agent-profiles/selection', '$put'>>,
    Assert<HasTypedBody<'/api/v1/workspace/agent-profiles/:id/open', '$post'>>,
    Assert<HasTypedBody<'/api/v1/workflows', '$post'>>,
    Assert<HasTypedBody<'/api/v1/workflows/parse', '$post'>>,
    Assert<HasTypedBody<'/api/v1/worktrees/reclaim', '$post'>>,
    Assert<HasTypedBody<'/api/v1/repo/branch', '$post'>>,
    Assert<HasTypedBody<'/api/v1/providers/connect', '$post'>>,
    Assert<HasTypedBody<'/api/v1/providers/:provider/enabled', '$put'>>,
    Assert<HasTypedBody<'/api/v1/providers/:provider/retry', '$post'>>,
    Assert<HasTypedBody<'/api/v1/groups/:groupId/pick', '$post'>>,
    Assert<HasTypedBody<'/api/v1/github/prs/:number/merge', '$post'>>,
    Assert<HasTypedBody<'/api/v1/agent-config/:id', '$put'>>,
    Assert<HasTypedBody<'/api/v1/config', '$put'>>,
    Assert<HasTypedBody<'/api/v1/runs/:id', '$patch'>>,
    Assert<HasTypedBody<'/api/v1/runs/:id/archive', '$post'>>,
    Assert<HasTypedBody<'/api/v1/runs/:id/continue', '$post'>>,
    Assert<HasTypedBody<'/api/v1/runs/:id/messages', '$post'>>,
    Assert<HasTypedBody<'/api/v1/runs/:id/open-in', '$post'>>,
    Assert<HasTypedBody<'/api/v1/runs/:id/git/commit', '$post'>>,
    Assert<HasTypedBody<'/api/v1/runs/:id/queued-messages/:msgId', '$patch'>>,
    Assert<HasTypedBody<'/api/v1/ui-state', '$put'>>,
    Assert<HasTypedBody<'/api/v1/workspace/config', '$put'>>,
    Assert<HasTypedBody<'/api/v1/workspace/ui-state', '$put'>>,
    Assert<HasTypedBody<'/api/v1/workspace/skills-update/check', '$post'>>,
    Assert<HasTypedBody<'/api/v1/workspace/skills-update/apply', '$post'>>,
  ];

  /** Same idea for the routes that validate a path param or the query string. */
  type HasTypedInput<
    Path extends keyof Schema,
    Method extends PropertyKey,
    Target extends 'param' | 'query',
  > = Schema[Path] extends Record<Method, { input: Record<Target, unknown> }> ? true : false;

  type _InputChecks = [
    Assert<HasTypedInput<'/api/v1/providers/:provider/enabled', '$put', 'param'>>,
    Assert<HasTypedInput<'/api/v1/providers/:provider/retry', '$post', 'param'>>,
    Assert<HasTypedInput<'/api/v1/github/prs/:number/merge', '$post', 'param'>>,
    Assert<HasTypedInput<'/api/v1/github/prs/:number/merge-state', '$get', 'param'>>,
    Assert<HasTypedInput<'/api/v1/models', '$get', 'query'>>,
    Assert<HasTypedInput<'/api/v1/providers/status', '$get', 'query'>>,
    Assert<HasTypedInput<'/api/v1/workspace/skills-update', '$get', 'query'>>,
    // The reads the cockpit's typed client needs a `query` argument for. `hc` offers one only
    // for keys a validator declares, so a route that reverted to `c.req.query('x')` would fail
    // here — and would otherwise fail nowhere, since the handler keeps working either way.
    Assert<HasTypedInput<'/api/v1/fs/browse', '$get', 'query'>>,
    Assert<HasTypedInput<'/api/v1/skills', '$get', 'query'>>,
    Assert<HasTypedInput<'/api/v1/skills/importable', '$get', 'query'>>,
    Assert<HasTypedInput<'/api/v1/runs/:id/files', '$get', 'query'>>,
    Assert<HasTypedInput<'/api/v1/github', '$get', 'query'>>,
    Assert<HasTypedInput<'/api/v1/github/checks', '$get', 'query'>>,
    Assert<HasTypedInput<'/api/v1/github/comments/:kind/:number', '$get', 'query'>>,
    Assert<HasTypedInput<'/api/v1/github/prs/:number/merge-state', '$get', 'query'>>,
    Assert<HasTypedInput<'/api/v1/github/prs/:number/changes', '$get', 'query'>>,
    Assert<HasTypedInput<'/api/v1/github/prs/:number/changes', '$get', 'param'>>,
    Assert<HasTypedInput<'/api/v1/repo/commit/:sha', '$get', 'query'>>,
    Assert<HasTypedInput<'/api/v1/automation-log', '$get', 'query'>>,
  ];

  it('is enforced by tsc, not at runtime', () => {
    // A guard that can only pass would be worse than none: this pins the helper itself, so a
    // `HasTypedBody` that degenerated to `true` for everything fails here.
    type Unmutating = HasTypedBody<'/api/v1/health', '$post'>;
    const neverTyped: Unmutating = false;
    expect(neverTyped).toBe(false);
  });
});
