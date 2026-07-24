# Provider Availability and Task Authentication Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make provider discovery truthful, add global provider enable/disable controls, and attach an actionable authorization callout to every task that encounters a runtime 401.

**Architecture:** Keep `ProviderAuthService` responsible for vendor-owned credential discovery and runtime failure latches. Decorate its coarse status at the workspace API boundary with global enablement from `~/.cezar/config.json`, and enforce `enabled && connected` only at new-action entry points so existing tasks continue. Convert authoritative runtime authentication errors into one additional safe, persisted `provider-auth-required` run event, rendered by the cockpit as a project-aware Settings callout.

**Tech Stack:** Strict TypeScript ESM on Node 20+, Hono, Zod, React 19, TanStack Query, Tailwind v4, shadcn/Radix `Switch`, Vitest, node:test, SSE, NDJSON.

## Global Constraints

- Green means **Credentials found**, never live authentication verification.
- Do not add background model requests, provider network probes, quota use, token reads, or OAuth callback handling.
- Provider preference is global across projects and stored only in optional `~/.cezar/config.json`.
- Missing/corrupt/read-only global config degrades to all providers enabled; boot must not fail.
- Disabling blocks only new tasks and follow-ups; it never cancels or alters an existing run, including queued runs and later workflow steps.
- The 30-second poll and **Check again** must never clear a runtime 401 from a local credential-presence result.
- Retry is explicit, incident-ID guarded, and independent of enablement.
- Raw vendor errors, credentials, account identity, probe output, and terminal output never enter the new preference, API, SSE, or structured task-event fields.
- All workspace config writes use `mergeWriteWorkspaceConfig`; all mutating routes use zod `safeParse`.
- `/api/providers/*` remains workspace-level and is never mounted under `/api/p/:projectId`.
- No new dependency and no new `CEZ_*` environment variable.
- Preserve `CEZ_DRY_RUN=1`.
- Follow the validation order in `AGENTS.md`.

---

### Task 1: Global provider preference and enriched status API

**Files:**
- Create: `src/core/provider-availability.ts`
- Create: `src/core/provider-availability.test.ts`
- Modify: `src/core/provider-auth.ts`
- Modify: `src/workspace/config.ts`
- Modify: `src/workspace/config.test.ts`
- Modify: `src/server/server.ts`
- Modify: `src/server/providers-api.test.ts`
- Modify: `src/server/workspace-events.test.ts`

**Interfaces:**
- Consumes: `ProviderId`, `ProviderStatus`, and `ProviderStatusResponse` from `src/core/provider-auth.ts`; `loadWorkspaceConfig` and `mergeWriteWorkspaceConfig` from `src/workspace/config.ts`.
- Produces:
  - `ProviderStatus.enabled?: boolean`
  - `applyProviderEnablement(response: ProviderStatusResponse, disabledProviders: readonly ProviderId[]): ProviderStatusResponse`
  - `isProviderUsable(row: ProviderStatus): boolean`
  - `WorkspaceConfig.disabledProviders: ProviderId[]`
  - `CreateAppDeps.workspaceConfig?: { load: typeof loadWorkspaceConfig; mergeWrite: typeof mergeWriteWorkspaceConfig }`
  - `PUT /api/providers/:provider/enabled`

- [ ] **Step 1: Add failing workspace-config tests for defaulting, salvage, and merge preservation**

Use the existing `write` helper and temporary `CEZ_HOME`, then assert:

```ts
expect(defaultWorkspaceConfig().disabledProviders).toEqual([]);

write({
  disabledProviders: ['codex', 'future', 'codex', 4, 'opencode'],
  futureTopLevelKey: { keep: true },
});
expect((await loadWorkspaceConfig()).disabledProviders).toEqual(['codex', 'opencode']);

const written = await mergeWriteWorkspaceConfig((config) => {
  config.disabledProviders = ['claude'];
});
expect(written.disabledProviders).toEqual(['claude']);
const raw = JSON.parse(
  readFileSync(workspaceConfigPath(), 'utf8'),
) as Record<string, unknown>;
expect(raw.futureTopLevelKey).toEqual({ keep: true });
```

- [ ] **Step 2: Run the workspace-config test and verify RED**

Run:

```bash
npm test -- src/workspace/config.test.ts
```

Expected: FAIL because `disabledProviders` is absent from the schema/default.

- [ ] **Step 3: Implement per-entry provider preference salvage**

In `src/workspace/config.ts`, import `PROVIDER_IDS` and `ProviderId`, then add:

```ts
const providerIdSet = new Set<string>(PROVIDER_IDS);

const disabledProvidersSchema = z
  .array(z.unknown())
  .default(() => [])
  .catch(() => [])
  .transform((values): ProviderId[] => {
    const seen = new Set<ProviderId>();
    for (const value of values) {
      if (typeof value !== 'string' || !providerIdSet.has(value)) continue;
      seen.add(value as ProviderId);
    }
    return PROVIDER_IDS.filter((provider) => seen.has(provider));
  });
```

Add `disabledProviders: disabledProvidersSchema` to `workspaceConfigSchema`. Do not write a
migration: the absent field already means all enabled.

- [ ] **Step 4: Add failing pure availability tests**

Create `src/core/provider-availability.test.ts` with exact cases:

```ts
import { describe, expect, it } from 'vitest';
import { applyProviderEnablement, isProviderUsable } from './provider-availability.js';

describe('provider availability', () => {
  const response = {
    providers: [
      { provider: 'claude' as const, status: 'connected' as const },
      { provider: 'codex' as const, status: 'disconnected' as const },
      { provider: 'opencode' as const, status: 'not-installed' as const },
    ],
  };

  it('decorates every row without changing discovery truth', () => {
    expect(applyProviderEnablement(response, ['claude'])).toEqual({
      providers: [
        { provider: 'claude', status: 'connected', enabled: false },
        { provider: 'codex', status: 'disconnected', enabled: true },
        { provider: 'opencode', status: 'not-installed', enabled: true },
      ],
    });
  });

  it('requires both credentials and enablement for use', () => {
    expect(isProviderUsable({ provider: 'claude', status: 'connected', enabled: true })).toBe(true);
    expect(isProviderUsable({ provider: 'claude', status: 'connected', enabled: false })).toBe(false);
    expect(isProviderUsable({ provider: 'claude', status: 'disconnected', enabled: true })).toBe(false);
  });
});
```

- [ ] **Step 5: Run the pure availability test and verify RED**

Run:

```bash
npm test -- src/core/provider-availability.test.ts
```

Expected: FAIL because the module and `enabled` field do not exist.

- [ ] **Step 6: Implement the pure availability seam**

Add `enabled?: boolean` to `ProviderStatus` in `src/core/provider-auth.ts`, then create
`src/core/provider-availability.ts`:

```ts
import type {
  ProviderId,
  ProviderStatus,
  ProviderStatusResponse,
} from './provider-auth.js';

export function applyProviderEnablement(
  response: ProviderStatusResponse,
  disabledProviders: readonly ProviderId[],
): ProviderStatusResponse {
  const disabled = new Set(disabledProviders);
  return {
    providers: response.providers.map((row) => ({
      ...row,
      enabled: !disabled.has(row.provider),
    })),
  };
}

export function isProviderUsable(row: ProviderStatus): boolean {
  return row.enabled !== false && row.status === 'connected';
}
```

The optional core field is intentional: raw probe and runtime-latch rows do not own workspace
preferences; complete HTTP responses are decorated at the server boundary.

- [ ] **Step 7: Add failing API tests for enriched GET and global enable/disable**

Extend `src/server/providers-api.test.ts` with an in-memory `workspaceConfig` dependency whose
`load` returns a parsed `WorkspaceConfig` and whose `mergeWrite` applies the mutator to that
object. Assert:

```ts
const statusResponse = await apiRequest(server, '/api/providers/status');
expect(await statusResponse.json()).toEqual({
  providers: [
    { provider: 'claude', status: 'connected', enabled: true },
    { provider: 'codex', status: 'connected', enabled: false },
    { provider: 'opencode', status: 'connected', enabled: true },
  ],
});

const disabled = await apiRequest(server, '/api/providers/claude/enabled', {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ enabled: false }),
});
expect(disabled.status).toBe(200);
expect((await disabled.json()).providers).toContainEqual({
  provider: 'claude',
  status: 'connected',
  enabled: false,
});
expect((await workspaceConfig.load()).disabledProviders).toEqual(['claude', 'codex']);
```

Also pin:

- invalid provider → 400;
- `{ enabled: "no" }`, missing JSON, or extra body keys → 400;
- failed `mergeWriteWorkspaceConfig` → fixed JSON 500 and no success event;
- success emits exactly one `provider-status` row with `enabled`;
- unscoped route exists and `/api/p/default/providers/claude/enabled` is 404.

- [ ] **Step 8: Run the provider API tests and verify RED**

Run:

```bash
npm test -- src/server/providers-api.test.ts src/server/workspace-events.test.ts
```

Expected: FAIL because status lacks `enabled` and the mutation route is absent.

- [ ] **Step 9: Implement the enriched status closure and mutation route**

Add this optional dependency to `CreateAppDeps`:

```ts
workspaceConfig?: {
  load: typeof loadWorkspaceConfig
  mergeWrite: typeof mergeWriteWorkspaceConfig
}
```

Inside `createApp`, select it:

```ts
const workspaceConfig = deps.workspaceConfig ?? {
  load: loadWorkspaceConfig,
  mergeWrite: mergeWriteWorkspaceConfig,
}
```

Then define:

```ts
const providerStatus = async (options?: { refresh?: boolean }): Promise<ProviderStatusResponse> => {
  const [discovered, workspace] = await Promise.all([
    providerAuth.status(options),
    workspaceConfig.load(),
  ]);
  return applyProviderEnablement(discovered, workspace.disabledProviders);
};
```

Use it for `GET /api/providers/status`, with refresh only:

```ts
return c.json(await providerStatus({ refresh: query.data.refresh === '1' }));
```

Add schemas:

```ts
const providerParamSchema = z.enum(PROVIDER_IDS);
const providerEnabledSchema = z.object({ enabled: z.boolean() }).strict();
```

Add the workspace-level route:

```ts
app.put('/api/providers/:provider/enabled', async (c) => {
  const provider = providerParamSchema.safeParse(c.req.param('provider'));
  const body = providerEnabledSchema.safeParse(await c.req.json().catch(() => null));
  if (!provider.success || !body.success) {
    return c.json({ error: 'provider and enabled boolean are required' }, 400);
  }
  let workspace: WorkspaceConfig;
  try {
    workspace = await workspaceConfig.mergeWrite((config) => {
      const disabled = new Set(config.disabledProviders);
      if (body.data.enabled) disabled.delete(provider.data);
      else disabled.add(provider.data);
      config.disabledProviders = PROVIDER_IDS.filter((id) => disabled.has(id));
    });
  } catch {
    return c.json({ error: 'Provider preference could not be saved.' }, 500);
  }
  const result = applyProviderEnablement(
    await providerAuth.status(),
    workspace.disabledProviders,
  );
  const row = result.providers.find(({ provider: id }) => id === provider.data);
  if (row) workspaceEvents.emit('provider-status', row);
  return c.json(result);
});
```

Import the exact types/functions instead of weakening with casts.

- [ ] **Step 10: Run Task 1 tests and verify GREEN**

Run:

```bash
npm test -- src/workspace/config.test.ts src/core/provider-availability.test.ts src/core/provider-auth.test.ts src/server/providers-api.test.ts src/server/workspace-events.test.ts
```

Expected: all selected files pass.

- [ ] **Step 11: Commit Task 1**

```bash
git add src/core/provider-auth.ts src/core/provider-availability.ts src/core/provider-availability.test.ts src/workspace/config.ts src/workspace/config.test.ts src/server/server.ts src/server/providers-api.test.ts src/server/workspace-events.test.ts
git commit -m "feat: add global provider availability preferences"
```

---

### Task 2: Enforce provider availability at new-action server boundaries

**Files:**
- Create: `src/server/provider-action-gate.ts`
- Create: `src/server/provider-action-gate.test.ts`
- Create: `src/server/provider-action-gating.test.ts`
- Modify: `src/server/server.ts`

**Interfaces:**
- Consumes: enriched `ProviderStatusResponse`, `WorkflowDef`, `RunRecord`, repo `Config`.
- Produces:
  - `providersRequiredByWorkflow(workflow: WorkflowDef, fallback: ProviderId): ProviderId[]`
  - `providerForExistingRun(run: RunRecord, override?: ProviderId): ProviderId`
  - `unavailableProviderMessage(required: readonly ProviderId[], status: ProviderStatusResponse): string | null`

- [ ] **Step 1: Write failing pure gate tests**

Create `src/server/provider-action-gate.test.ts` with:

```ts
it('collects each agent step backend and ignores checks', () => {
  expect(providersRequiredByWorkflow({
    name: 'mixed',
    source: 'built-in',
    steps: [
      { id: 'a', prompt: 'a', runner: 'codex' },
      { id: 'check', command: 'npm test' },
      { id: 'b', prompt: 'b' },
      { id: 'c', prompt: 'c', runner: 'opencode' },
    ],
  }, 'claude')).toEqual(['claude', 'codex', 'opencode']);
});

it('reports disabled before missing credentials', () => {
  expect(unavailableProviderMessage(['codex'], {
    providers: [
      { provider: 'claude', status: 'connected', enabled: true },
      { provider: 'codex', status: 'connected', enabled: false },
      { provider: 'opencode', status: 'not-installed', enabled: true },
    ],
  })).toBe('Codex is disabled. Enable it in Settings → Agents → Providers.');
});
```

Add cases for disconnected, unknown, missing row, and existing-run backend precedence:
explicit override → latest step backend → run runner → Claude.

- [ ] **Step 2: Run the pure gate test and verify RED**

Run:

```bash
npm test -- src/server/provider-action-gate.test.ts
```

Expected: FAIL because the gate module is absent.

- [ ] **Step 3: Implement the pure gate module**

Create `src/server/provider-action-gate.ts` with fixed labels and deterministic provider order:

```ts
import type {
  ProviderId,
  ProviderStatusResponse,
} from '../core/provider-auth.js';
import type { RunRecord } from '../runs/store.js';
import { stepKind, type WorkflowDef } from '../workflows/types.js';

const ORDER: readonly ProviderId[] = ['claude', 'codex', 'opencode'];
const LABEL: Record<ProviderId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
};

export function providersRequiredByWorkflow(
  workflow: WorkflowDef,
  fallback: ProviderId,
): ProviderId[] {
  const required = new Set<ProviderId>();
  for (const step of workflow.steps) {
    if (stepKind(step) === 'agent') required.add(step.runner ?? fallback);
  }
  return ORDER.filter((provider) => required.has(provider));
}

export function providerForExistingRun(
  run: RunRecord,
  override?: ProviderId,
): ProviderId {
  if (override) return override;
  for (let index = run.steps.length - 1; index >= 0; index -= 1) {
    const backend = run.steps[index]?.backend;
    if (backend) return backend;
  }
  return run.runner ?? 'claude';
}

export function unavailableProviderMessage(
  required: readonly ProviderId[],
  response: ProviderStatusResponse,
): string | null {
  for (const provider of required) {
    const row = response.providers.find(({ provider: id }) => id === provider);
    if (row?.enabled === false) {
      return `${LABEL[provider]} is disabled. Enable it in Settings → Agents → Providers.`;
    }
    if (row?.status !== 'connected') {
      return `${LABEL[provider]} credentials are unavailable. Authorize it in Settings → Agents → Providers.`;
    }
  }
  return null;
}
```

- [ ] **Step 4: Write failing server integration tests**

Create `src/server/provider-action-gating.test.ts`. Use an injected
`ProviderAuthService`, disposable workspace config, and manager spies. Prove 409 with no manager
call for:

- `POST /api/runs` when the selected provider is disabled;
- inline/mixed workflow when any agent step provider is disabled;
- `POST /api/plan` when the configured default runner is disabled;
- `POST /api/runs/:id/messages` using the run's current backend;
- `POST /api/runs/:id/continue` using an explicit override and using the persisted backend;
- `POST /api/todos/:id/start`.

Prove:

```ts
expect(response.status).toBe(409);
expect(await response.json()).toEqual({
  error: 'Codex is disabled. Enable it in Settings → Agents → Providers.',
});
expect(startRun).not.toHaveBeenCalled();
```

Also prove a task created before disable still dequeues/runs and a mixed existing workflow reaches
its later provider step; do not add an execution-time preference check.

- [ ] **Step 5: Run integration tests and verify RED**

Run:

```bash
npm test -- src/server/provider-action-gating.test.ts
```

Expected: FAIL because server entry points do not enforce provider availability.

- [ ] **Step 6: Add one shared async route guard and apply it only to new actions**

Inside `createApp`, reuse Task 1's `providerStatus` closure:

```ts
const providerActionError = async (
  required: readonly ProviderId[],
): Promise<string | null> =>
  unavailableProviderMessage(required, await providerStatus());
```

At `/plan`, load the repo config and require `[config.defaultRunner]` before calling `planChain`.

At `/runs`, after resolving `workflow`, load repo config, resolve:

```ts
const fallback = parsed.data.runner ?? (await loadConfig(repoRoot)).defaultRunner;
const blocked = await providerActionError(
  providersRequiredByWorkflow(workflow, fallback),
);
if (blocked) return c.json({ error: blocked }, 409);
```

At `/runs/:id/messages` and `/runs/:id/continue`, resolve the existing provider with
`providerForExistingRun`; at `/todos/:id/start`, apply `providersRequiredByWorkflow` before
`manager.startRun`.

Do not gate scheduler dequeue, workflow step transitions, cancellation, review, git actions, or
existing run recovery.

- [ ] **Step 7: Run Task 2 tests and verify GREEN**

Run:

```bash
npm test -- src/server/provider-action-gate.test.ts src/server/provider-action-gating.test.ts src/server/providers-api.test.ts src/server/route-parity.test.ts
```

Expected: all selected files pass.

- [ ] **Step 8: Commit Task 2**

```bash
git add src/server/provider-action-gate.ts src/server/provider-action-gate.test.ts src/server/provider-action-gating.test.ts src/server/server.ts
git commit -m "feat: block new actions for disabled providers"
```

---

### Task 3: Explicit runtime retry and structured per-task auth event

**Files:**
- Modify: `src/core/provider-auth.ts`
- Modify: `src/core/provider-auth.test.ts`
- Modify: `src/server/provider-auth-runtime.ts`
- Modify: `src/server/provider-auth-runtime.test.ts`
- Modify: `src/server/server.ts`
- Modify: `src/server/providers-api.test.ts`
- Modify: `src/server/workspace-events.test.ts`
- Modify: `src/runs/store.test.ts`

**Interfaces:**
- Consumes: current runtime-auth classifier and `RunStore.appendEvent/readEvents`.
- Produces:
  - `RuntimeAuthFailureReport.status` is a disconnected `ProviderStatus` with required
    `authFailureId`; `transitioned` distinguishes the first global latch edge.
  - `ProviderAuthService.clearRuntimeAuthFailure(provider: ProviderId, authFailureId: string): boolean`
  - persisted `provider-auth-required` run event
  - `POST /api/providers/:provider/retry`

- [ ] **Step 1: Write failing core tests for non-recovering refresh and incident-safe clear**

Replace the existing “fresh recovery probe clears the latch” expectation with:

```ts
const incident = service.reportRuntimeAuthFailure('claude').status.authFailureId!;
await expect(service.status({ refresh: true })).resolves.toMatchObject({
  providers: [expect.objectContaining({
    provider: 'claude',
    status: 'disconnected',
    authFailureId: incident,
  })],
});
expect(service.clearRuntimeAuthFailure('claude', 'stale')).toBe(false);
expect(service.clearRuntimeAuthFailure('claude', incident)).toBe(true);
await expect(service.status()).resolves.toMatchObject({
  providers: [expect.objectContaining({
    provider: 'claude',
    status: 'connected',
  })],
});
```

Assert duplicate reports return the same `authFailureId`, advance internal precedence, and report
`transitioned: false`.

- [ ] **Step 2: Run core auth tests and verify RED**

Run:

```bash
npm test -- src/core/provider-auth.test.ts
```

Expected: FAIL because refresh currently recovers and the clear/report APIs differ.

- [ ] **Step 3: Implement explicit-only recovery**

Change `reportRuntimeAuthFailure` to always return:

```ts
export interface RuntimeAuthFailureReport {
  status: ProviderStatus & {
    status: 'disconnected';
    authFailureId: string;
  };
  transitioned: boolean;
}
```

Return the stable incident row and `transitioned: current === undefined`.

Remove `recoverRuntimeFailures` from `status()` and delete the old
`recoverRuntimeFailures(...)` method. Add:

```ts
clearRuntimeAuthFailure(provider: ProviderId, authFailureId: string): boolean {
  const current = this.runtimeFailures.get(provider);
  if (!current || current.authFailureId !== authFailureId) return false;
  this.runtimeFailures.delete(provider);
  return true;
}
```

Clearing is synchronous before the retry route awaits a fresh status probe. A rejection arriving
afterward creates a new incident and therefore wins.

- [ ] **Step 4: Write failing observer tests for one task event per incident**

Extend `src/server/provider-auth-runtime.test.ts`:

```ts
store.appendEvent(run.id, {
  type: 'error',
  stepId: 'work',
  message: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
});
store.appendEvent(run.id, {
  type: 'session.error',
  stepId: 'work',
  message: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
});

expect(store.readEvents(run.id).filter(
  ({ type }) => type === 'provider-auth-required',
)).toEqual([
  expect.objectContaining({
    type: 'provider-auth-required',
    provider: 'claude',
    authFailureId: 'auth-incident-1',
    stepId: 'work',
  }),
]);
```

Add a second run failing while Claude is already latched and assert that second run gets one event
with the same incident ID, while the workspace invalidation callback fires only once. Add a mixed
workflow case proving `step.backend` wins.

- [ ] **Step 5: Run observer tests and verify RED**

Run:

```bash
npm test -- src/server/provider-auth-runtime.test.ts
```

Expected: FAIL because no structured task event is appended.

- [ ] **Step 6: Append and deduplicate the safe task event**

In `watchProviderRuntimeAuthFailures`, use the new report:

```ts
const report = providerAuth.reportRuntimeAuthFailure(provider);
if (report.transitioned) onInvalidated(report.status);

const duplicate = store.readEvents(runId).some((candidate) =>
  candidate.type === 'provider-auth-required'
  && candidate.provider === provider
  && candidate.authFailureId === report.status.authFailureId);
if (!duplicate) {
  store.appendEvent(runId, {
    type: 'provider-auth-required',
    provider,
    authFailureId: report.status.authFailureId,
    ...(event.stepId ? { stepId: event.stepId } : {}),
  });
}
```

The observer ignores the derived event because it is not in `AUTH_ERROR_EVENT_TYPES`, preventing
recursion.

- [ ] **Step 7: Write failing retry-route tests**

In `src/server/providers-api.test.ts`, pin:

- valid current ID clears the latch and returns all rows with `enabled`;
- stale/missing ID returns fixed 409 and retains the latch;
- malformed/unknown provider returns 400;
- retry does not remove the provider from `disabledProviders`;
- retry emits one updated `provider-status` row;
- raw error/probe text is absent.

Use:

```ts
const response = await apiRequest(server, '/api/providers/claude/retry', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ authFailureId: 'auth-incident-1' }),
});
expect(response.status).toBe(200);
expect((await response.json()).providers).toContainEqual({
  provider: 'claude',
  status: 'connected',
  enabled: false,
});
```

- [ ] **Step 8: Run retry/API tests and verify RED**

Run:

```bash
npm test -- src/server/providers-api.test.ts src/server/workspace-events.test.ts src/runs/store.test.ts
```

Expected: FAIL because the retry route is absent and existing payload expectations need the
structured event/additive `enabled` updates.

- [ ] **Step 9: Implement incident-safe retry**

Add a strict schema:

```ts
const providerRetrySchema = z.object({
  authFailureId: z.string().min(1).max(128),
}).strict();
```

Add:

```ts
app.post('/api/providers/:provider/retry', async (c) => {
  const provider = providerParamSchema.safeParse(c.req.param('provider'));
  const body = providerRetrySchema.safeParse(await c.req.json().catch(() => null));
  if (!provider.success || !body.success) {
    return c.json({ error: 'provider and current authFailureId are required' }, 400);
  }
  if (!providerAuth.clearRuntimeAuthFailure(
    provider.data,
    body.data.authFailureId,
  )) {
    return c.json({ error: 'Authentication incident changed. Refresh and try again.' }, 409);
  }
  const result = await providerStatus({ refresh: true });
  const row = result.providers.find(({ provider: id }) => id === provider.data);
  if (row) workspaceEvents.emit('provider-status', row);
  return c.json(result);
});
```

- [ ] **Step 10: Run Task 3 tests and verify GREEN**

Run:

```bash
npm test -- src/core/provider-auth.test.ts src/server/provider-auth-runtime.test.ts src/server/providers-api.test.ts src/server/workspace-events.test.ts src/runs/store.test.ts
```

Expected: all selected files pass.

- [ ] **Step 11: Commit Task 3**

```bash
git add src/core/provider-auth.ts src/core/provider-auth.test.ts src/server/provider-auth-runtime.ts src/server/provider-auth-runtime.test.ts src/server/server.ts src/server/providers-api.test.ts src/server/workspace-events.test.ts src/runs/store.test.ts
git commit -m "feat: attach authorization recovery to failed tasks"
```

---

### Task 4: Cockpit provider contracts, cache updates, and usable-runner derivation

**Files:**
- Modify: `web/app/src/api/types.ts`
- Modify: `web/app/src/api/client.ts`
- Modify: `web/app/src/api/client.test.ts`
- Modify: `web/app/src/api/queries.ts`
- Modify: `web/app/src/api/queries.test.tsx`
- Modify: `web/app/src/api/global-events.tsx`
- Modify: `web/app/src/api/global-events.test.tsx`
- Modify: `web/app/src/lib/provider-status.ts`
- Modify: `web/app/src/lib/provider-status.test.ts`
- Modify: `web/app/src/components/engine-pills.tsx`
- Modify: `web/app/src/components/engine-pills.test.ts`
- Modify: `web/app/src/components/provider-banner.tsx`
- Modify: `web/app/src/components/provider-banner.test.tsx`
- Modify: `web/app/src/routes/new-task.tsx`
- Modify: `web/app/src/routes/inbox.test.tsx`
- Modify: `web/app/src/routes/github/github.test.tsx`
- Modify: `web/app/src/routes/task-thread/follow-up-engine.test.tsx`
- Modify provider-status fixtures in:
  - `web/app/src/api/project-scope.test.ts`
  - `web/app/src/components/app-shell-container.test.tsx`
  - `web/app/src/components/provider-banner-container.test.tsx`
  - `web/app/src/lib/provider-auth-alert.test.ts`
  - `web/app/src/routes/new-task-project.test.tsx`
  - `web/app/src/routes/settings/agents-section.test.tsx`
  - `web/app/src/routes/settings/provider-settings.test.tsx`
  - `web/app/src/routes/settings/settings.test.tsx`
  - `web/app/src/routes/task-thread/review-panel.test.tsx`
  - `web/app/src/routes/task-thread/run-header.test.tsx`
  - `web/app/src/routes/task-thread/task-thread.test.tsx`

**Interfaces:**
- Consumes: enriched status, enable/disable API, retry API, additive SSE status rows.
- Produces:
  - required web `ProviderStatus.enabled: boolean`
  - `ProviderStatusEventRow = Omit<ProviderStatus, 'enabled'> & { enabled?: boolean }`
  - `parseProviderStatusEventRow(value: unknown): ProviderStatusEventRow | null`
  - `usableRunners(status): Runner[]`
  - `setProviderEnabled(provider, enabled)`
  - `retryProviderAuth(provider, authFailureId)`
  - `useRetryProviderAuth()`

- [ ] **Step 1: Write failing parser and derivation tests**

In `web/app/src/lib/provider-status.test.ts`, assert:

```ts
expect(parseProviderStatusResponse({
  providers: [
    { provider: 'claude', status: 'connected', enabled: true },
    { provider: 'codex', status: 'connected', enabled: false },
    { provider: 'opencode', status: 'disconnected', enabled: true },
  ],
})).toEqual({
  providers: [
    { provider: 'claude', status: 'connected', enabled: true },
    { provider: 'codex', status: 'connected', enabled: false },
    { provider: 'opencode', status: 'disconnected', enabled: true },
  ],
});

expect(() => parseProviderStatusResponse({
  providers: [
    { provider: 'claude', status: 'connected' },
    { provider: 'codex', status: 'connected', enabled: true },
    { provider: 'opencode', status: 'connected', enabled: true },
  ],
})).toThrow('Invalid provider status response');

expect(usableRunners(status)).toEqual(['claude']);
```

Assert event rows may omit `enabled`, and `applyProviderStatusRow` preserves the cached boolean
when omitted while accepting a boolean emitted by preference mutation.

- [ ] **Step 2: Run provider-status tests and verify RED**

Run:

```bash
npm test -- web/app/src/lib/provider-status.test.ts
```

Expected: FAIL because `enabled` and `usableRunners` are absent.

- [ ] **Step 3: Implement strict full-response parsing and lenient event merging**

Change the web type:

```ts
export interface ProviderStatus {
  provider: ProviderId
  status: ProviderConnectionState
  enabled: boolean
  hint?: string
  authFailureId?: string
}
```

Add the exact event-row type:

```ts
export type ProviderStatusEventRow =
  Omit<ProviderStatus, 'enabled'> & { enabled?: boolean }
```

Make the internal row parser accept a `requireEnabled` argument and return
`ProviderStatusEventRow | null`. `parseProviderStatusResponse` passes `true` and narrows every row
to `ProviderStatus`; export `parseProviderStatusEventRow` with `false`. Change
`applyProviderStatusRow` to accept `ProviderStatusEventRow`, then merge an event over the cached
row:

```ts
providers: providers.map((candidate) =>
  candidate.provider === row.provider
    ? { ...candidate, ...row, enabled: row.enabled ?? candidate.enabled }
    : candidate),
```

Rename `connectedRunners` to:

```ts
export function usableRunners(
  status: ProviderStatusResponse | undefined,
): Runner[] {
  const rows = completeProviderRows(status);
  if (rows === null) return [];
  const usable = new Set(rows
    .filter((row) => row.enabled && row.status === 'connected')
    .map((row) => row.provider));
  return RUNNER_ORDER.filter((runner) => usable.has(runner));
}
```

- [ ] **Step 4: Write failing API client/query tests**

Pin exact requests:

```ts
await setProviderEnabled('codex', false);
expect(fetchMock).toHaveBeenCalledWith('/api/providers/codex/enabled', expect.objectContaining({
  method: 'PUT',
  body: JSON.stringify({ enabled: false }),
}));

await retryProviderAuth('claude', 'incident-1');
expect(fetchMock).toHaveBeenCalledWith('/api/providers/claude/retry', expect.objectContaining({
  method: 'POST',
  body: JSON.stringify({ authFailureId: 'incident-1' }),
}));
```

Assert both client functions strictly parse the complete response. For `useRetryProviderAuth`,
assert success replaces `workspaceQueryKeys.providerStatus` and failure leaves the last confirmed
cache unchanged. Task 5 owns serialized optimistic enable/disable writes.

- [ ] **Step 5: Run client/query tests and verify RED**

Run:

```bash
npm test -- web/app/src/api/client.test.ts web/app/src/api/queries.test.tsx web/app/src/api/global-events.test.tsx
```

Expected: FAIL because the client functions/hooks are absent and SSE merging drops `enabled`.

- [ ] **Step 6: Implement client functions, hooks, and SSE merging**

Add:

```ts
export function setProviderEnabled(
  provider: ProviderId,
  enabled: boolean,
): Promise<ProviderStatusResponse> {
  return mutate<unknown>(
    'PUT',
    `/api/providers/${encodeURIComponent(provider)}/enabled`,
    { enabled },
  ).then(parseProviderStatusResponse);
}

export function retryProviderAuth(
  provider: ProviderId,
  authFailureId: string,
): Promise<ProviderStatusResponse> {
  return mutate<unknown>(
    'POST',
    `/api/providers/${encodeURIComponent(provider)}/retry`,
    { authFailureId },
  ).then(parseProviderStatusResponse);
}
```

Add the retry hook with an exact mutation input and cache update:

```tsx
export function useRetryProviderAuth() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      provider,
      authFailureId,
    }: {
      provider: ProviderId
      authFailureId: string
    }) => retryProviderAuth(provider, authFailureId),
    onSuccess: (result) => {
      queryClient.setQueryData(workspaceQueryKeys.providerStatus, result)
    },
  })
}
```

Update global events to call `parseProviderStatusEventRow`.

- [ ] **Step 7: Replace connected-only derivation with usable derivation**

Update `engine-pills.tsx`, `new-task.tsx`, and their tests to import `usableRunners`. Update the
generic provider banner:

```ts
const usable = normalized.providers.some(
  (row) => row.enabled && row.status === 'connected',
);
if (usable) return null;
const credentialsExist = normalized.providers.some(
  (row) => row.status === 'connected',
);
const message = credentialsExist
  ? 'No agent provider is enabled.'
  : normalized.providers.some((row) => row.status === 'unknown')
    ? 'No connected provider could be verified.'
    : 'No agent provider credentials were found.';
```

Keep runtime-auth incidents higher priority than the generic banner.

Add targeted route tests proving a connected-but-disabled provider is absent from new-task,
Inbox, GitHub handoff, and task follow-up choices while an enabled connected fallback remains
selectable.

- [ ] **Step 8: Update complete-response fixtures**

Every typed/mocked complete `ProviderStatusResponse` row must include `enabled`. Use:

```bash
rg -l "ProviderStatusResponse|/api/providers/status" web/app/src -g '*.test.ts' -g '*.test.tsx'
```

For ordinary fixtures, add `enabled: true`; add targeted `enabled: false` only to new disabled
cases. Do not add `enabled` to tests intentionally exercising a partial SSE event.

- [ ] **Step 9: Run Task 4 tests and typecheck**

Run:

```bash
npm test -- web/app/src/lib/provider-status.test.ts web/app/src/api/client.test.ts web/app/src/api/queries.test.tsx web/app/src/api/global-events.test.tsx web/app/src/components/engine-pills.test.ts web/app/src/components/provider-banner.test.tsx web/app/src/routes/new-task.test.tsx
npm run typecheck
```

Expected: all selected tests and both TypeScript projects pass.

- [ ] **Step 10: Commit Task 4**

```bash
git add web/app/src/api/types.ts web/app/src/api/client.ts web/app/src/api/client.test.ts web/app/src/api/queries.ts web/app/src/api/queries.test.tsx web/app/src/api/global-events.tsx web/app/src/api/global-events.test.tsx web/app/src/api/project-scope.test.ts web/app/src/lib/provider-status.ts web/app/src/lib/provider-status.test.ts web/app/src/lib/provider-auth-alert.test.ts web/app/src/components/engine-pills.tsx web/app/src/components/engine-pills.test.ts web/app/src/components/provider-banner.tsx web/app/src/components/provider-banner.test.tsx web/app/src/components/app-shell-container.test.tsx web/app/src/components/provider-banner-container.test.tsx web/app/src/routes/new-task.tsx web/app/src/routes/new-task.test.tsx web/app/src/routes/new-task-project.test.tsx web/app/src/routes/inbox.test.tsx web/app/src/routes/github/github.test.tsx web/app/src/routes/settings/agents-section.test.tsx web/app/src/routes/settings/provider-settings.test.tsx web/app/src/routes/settings/settings.test.tsx web/app/src/routes/task-thread/follow-up-engine.test.tsx web/app/src/routes/task-thread/review-panel.test.tsx web/app/src/routes/task-thread/run-header.test.tsx web/app/src/routes/task-thread/task-thread.test.tsx
git commit -m "feat: derive usable providers in the cockpit"
```

---

### Task 5: Settings labels, global toggle, and explicit Try again

**Files:**
- Modify: `web/app/src/routes/settings/provider-settings.tsx`
- Modify: `web/app/src/routes/settings/provider-settings.test.tsx`
- Modify: `web/app/src/routes/settings/agents-section.tsx`
- Modify: `web/app/src/routes/settings/agents-section.test.tsx`

**Interfaces:**
- Consumes: `useProviderStatus`, `useRefreshProviderStatus`, `setProviderEnabled`,
  `useRetryProviderAuth`, `ProviderStatus.enabled`, `authFailureId`.
- Produces: green **Credentials found**, accessible enable switch, **Disabled** state, and
  incident-safe **Try again**.

- [ ] **Step 1: Write failing presentation tests**

In `provider-settings.test.tsx`, render:

```ts
{
  providers: [
    { provider: 'claude', status: 'connected', enabled: true },
    { provider: 'codex', status: 'connected', enabled: false },
    {
      provider: 'opencode',
      status: 'disconnected',
      enabled: true,
      authFailureId: 'open-1',
      hint: 'Authentication was rejected during a run. Reconnect, then check again.',
    },
  ],
}
```

Assert:

- Claude says **Credentials found** with `data-tone="success"`;
- Codex keeps the green discovery dot and also says **Disabled**;
- switches are named `Use Claude Code` and `Use Codex`;
- OpenCode shows Connect and **Try again**;
- **Check again** remains available but a refreshed `connected` result with the same incident stays
  red because the server response retains the latch.

- [ ] **Step 2: Write failing mutation/race tests**

Use deferred responses to prove:

- disabling updates the cache immediately;
- a failed write restores the last confirmed response and shows a danger toast;
- two rapid toggles make only one request at a time;
- first failure cannot roll back a later successful toggle;
- retry posts the visible incident ID and replaces the cache;
- stale retry 409 leaves the red row intact and shows the server message;
- retrying a disabled provider keeps `enabled: false`.

- [ ] **Step 3: Run Settings tests and verify RED**

Run:

```bash
npm test -- web/app/src/routes/settings/provider-settings.test.tsx web/app/src/routes/settings/agents-section.test.tsx
```

Expected: FAIL because labels, controls, and retry do not exist.

- [ ] **Step 4: Implement truthful labels and controls**

Change:

```ts
connected: { label: 'Credentials found', tone: 'success' },
```

Import `Switch`. For every row except `not-installed`, render:

```tsx
<Switch
  checked={current?.enabled ?? true}
  aria-label={`Use ${provider.label}`}
  onCheckedChange={(enabled) => queueToggle(provider.id, enabled)}
/>
```

Render **Disabled** next to the status when `current?.enabled === false`. Do not hide Connect,
Check again, runtime hints, or Try again on a disabled card.

- [ ] **Step 5: Serialize optimistic toggle writes with confirmed rollback**

Add:

```ts
const writeChain = useRef<Promise<unknown>>(Promise.resolve())
const latestWrite = useRef(0)
const pendingWrites = useRef(0)
const lastConfirmed = useRef<ProviderStatusResponse | undefined>(status.data)

useEffect(() => {
  if (pendingWrites.current === 0) lastConfirmed.current = status.data
}, [status.data])

const queueToggle = useCallback((provider: ProviderId, enabled: boolean) => {
  const key = workspaceQueryKeys.providerStatus
  const previous = queryClient.getQueryData<ProviderStatusResponse>(key)
  if (!previous) return
  const optimistic: ProviderStatusResponse = {
    providers: previous.providers.map((row) =>
      row.provider === provider ? { ...row, enabled } : row),
  }
  pendingWrites.current += 1
  queryClient.setQueryData(key, optimistic)
  const seq = ++latestWrite.current
  writeChain.current = writeChain.current.then(async () => {
    try {
      const confirmed = await setProviderEnabled(provider, enabled)
      lastConfirmed.current = confirmed
      if (seq === latestWrite.current) queryClient.setQueryData(key, confirmed)
    } catch (error: unknown) {
      if (seq === latestWrite.current) {
        if (lastConfirmed.current) {
          queryClient.setQueryData(key, lastConfirmed.current)
        } else {
          queryClient.removeQueries({ queryKey: key, exact: true })
        }
        void queryClient.invalidateQueries({ queryKey: key })
        toast(error instanceof Error ? error.message : String(error), {
          tone: 'danger',
        })
      }
    } finally {
      pendingWrites.current -= 1
    }
  })
}, [queryClient])
```

Import `useCallback`, `useRef`, `ProviderStatusResponse`, `workspaceQueryKeys`, and
`setProviderEnabled` explicitly.

The switch remains operable while writes are queued; serialization, rather than disabling the
control, makes rapid intent changes deterministic.

- [ ] **Step 6: Implement Try again**

Assign `const incidentId = current?.authFailureId`. When it is defined, render:

```tsx
<Button
  type="button"
  variant="outline"
  size="sm"
  disabled={retry.isPending}
  onClick={() => retry.mutate({
    provider: provider.id,
    authFailureId: incidentId,
  }, {
    onSuccess: () => toast(`${provider.label} can be tried again.`),
    onError: (error) => toast(error.message, { tone: 'danger' }),
  })}
>
  Try again
</Button>
```

Add fixed helper copy: “Use this after completing the provider sign-in flow. cezar will verify it
on the next task.”

- [ ] **Step 7: Make saved defaults honor enablement**

In `agents-section.tsx`, replace every direct
`row.status === 'connected'` control gate with:

```ts
row?.enabled === true && row.status === 'connected'
```

Keep a saved disabled runner visibly selected and show:
“This provider is disabled. Enable it above or choose another provider.”

- [ ] **Step 8: Run Task 5 tests**

Run:

```bash
npm test -- web/app/src/routes/settings/provider-settings.test.tsx web/app/src/routes/settings/agents-section.test.tsx web/app/src/routes/settings/settings.test.tsx
npm run typecheck
```

Expected: all selected tests and typecheck pass.

- [ ] **Step 9: Commit Task 5**

```bash
git add web/app/src/routes/settings/provider-settings.tsx web/app/src/routes/settings/provider-settings.test.tsx web/app/src/routes/settings/agents-section.tsx web/app/src/routes/settings/agents-section.test.tsx
git commit -m "feat: manage provider availability in settings"
```

---

### Task 6: Persisted task-thread authorization callout

**Files:**
- Modify: `web/app/src/routes/task-thread/thread-state.ts`
- Modify: `web/app/src/routes/task-thread/thread-state.test.ts`
- Modify: `web/app/src/routes/task-thread/thread-items.tsx`
- Modify: `web/app/src/routes/task-thread/thread-items.test.tsx`
- Modify: `web/app/src/routes/task-thread/task-thread.tsx`
- Modify: `web/app/src/routes/task-thread/task-thread.test.tsx`
- Modify: `web/app/src/routes/task-thread/thread-groups.ts`
- Modify: `web/app/src/routes/task-thread/thread-groups.test.ts`
- Modify: `AGENT_PROTOCOL.md`

**Interfaces:**
- Consumes: loose persisted `RunEvent`.
- Produces:
  - `ThreadProviderAuthRequired`
  - `ProviderAuthRequiredCard`
  - reducer case for `provider-auth-required`

- [ ] **Step 1: Write failing reducer tests**

Add:

```ts
expect(reduceThread([
  line(1, 'provider-auth-required', {
    provider: 'claude',
    authFailureId: 'incident-1',
    stepId: 'work',
  }),
]).turns[0]?.items).toEqual([{
  kind: 'provider-auth-required',
  id: 'v1:1',
  provider: 'claude',
  authFailureId: 'incident-1',
}]);
```

Prove unknown provider, blank/overlong incident ID, and malformed payload are ignored. Prove replay
is deterministic and grouping keeps the callout at the failure location.

- [ ] **Step 2: Run reducer/group tests and verify RED**

Run:

```bash
npm test -- web/app/src/routes/task-thread/thread-state.test.ts web/app/src/routes/task-thread/thread-groups.test.ts
```

Expected: FAIL because the event is ignored.

- [ ] **Step 3: Implement the task-thread entry**

Add:

```ts
export interface ThreadProviderAuthRequired {
  kind: 'provider-auth-required'
  id: string
  provider: 'claude' | 'codex' | 'opencode'
  authFailureId: string
}
```

Include it in `ThreadEntry`. In the reducer, validate provider and incident length 1–128, then push
the entry with `id: v1:${event.seq}`. Treat it as an ordinary top-level non-tool entry in grouping.

- [ ] **Step 4: Write failing accessible rendering tests**

Render each provider and assert:

```ts
expect(screen.getByRole('alert').textContent).toContain(
  'Claude Code needs authorization',
);
expect(screen.getByRole('link', {
  name: 'Open provider settings',
}).getAttribute('href')).toBe('/p/acme/settings/agents#providers');
```

Assert Codex and OpenCode labels, fixed helper copy, keyboard-focusable link, and persistence after
the run later reaches `done`.

- [ ] **Step 5: Run rendering tests and verify RED**

Run:

```bash
npm test -- web/app/src/routes/task-thread/thread-items.test.tsx web/app/src/routes/task-thread/task-thread.test.tsx
```

Expected: FAIL because no callout component exists.

- [ ] **Step 6: Implement `ProviderAuthRequiredCard` and render it**

Add a fixed provider label map and:

```tsx
export function ProviderAuthRequiredCard({
  incident,
}: {
  incident: ThreadProviderAuthRequired
}) {
  const label = PROVIDER_LABEL[incident.provider]
  return (
    <div
      role="alert"
      data-slot="provider-auth-required"
      className="rounded-md border border-danger/30 bg-danger/5 px-3.5 py-3"
    >
      <p className="text-[13px] font-semibold text-foreground">
        {label} needs authorization
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        Authorize {label} in Settings before trying again.
      </p>
      <Link
        to="/settings/agents#providers"
        className="mt-2 inline-flex text-xs font-medium text-foreground underline-offset-2 hover:underline"
      >
        Open provider settings
      </Link>
    </div>
  )
}
```

Add a `provider-auth-required` branch to `ThreadEntryView`.

- [ ] **Step 7: Document the additive cezar event**

In `AGENT_PROTOCOL.md`, add a “cezar-owned run metadata events” subsection after v1:

```text
provider-auth-required is not emitted by a backend runner. The server derives it from an
authoritative v1/v2 authentication error, persists provider + opaque incident id + optional
stepId, and the cockpit renders recovery guidance. It does not change backend parity or expose
the raw error.
```

- [ ] **Step 8: Run Task 6 tests and typecheck**

Run:

```bash
npm test -- web/app/src/routes/task-thread/thread-state.test.ts web/app/src/routes/task-thread/thread-groups.test.ts web/app/src/routes/task-thread/thread-items.test.tsx web/app/src/routes/task-thread/task-thread.test.tsx
npm run typecheck
```

Expected: all selected tests and typecheck pass.

- [ ] **Step 9: Commit Task 6**

```bash
git add web/app/src/routes/task-thread/thread-state.ts web/app/src/routes/task-thread/thread-state.test.ts web/app/src/routes/task-thread/thread-items.tsx web/app/src/routes/task-thread/thread-items.test.tsx web/app/src/routes/task-thread/task-thread.tsx web/app/src/routes/task-thread/task-thread.test.tsx web/app/src/routes/task-thread/thread-groups.ts web/app/src/routes/task-thread/thread-groups.test.ts AGENT_PROTOCOL.md
git commit -m "feat: show task-local provider authorization recovery"
```

---

### Task 7: Feature-spec alignment, Browser QA, and full verification

**Files:**
- Modify: `.ai/specs/2026-07-22-provider-authentication.md`
- Modify: `docs/superpowers/specs/2026-07-24-provider-availability-and-task-auth-recovery-design.md` only if implementation revealed a necessary, user-approved correction
- Create: `.superpowers/sdd/provider-availability-task-auth-report.md` (ignored QA ledger)

**Interfaces:**
- Consumes: all earlier tasks.
- Produces: aligned design history, real-browser evidence, and repository validation evidence.

- [ ] **Step 1: Update the canonical feature spec**

Amend `.ai/specs/2026-07-22-provider-authentication.md` to state:

- `connected` means credentials found, presented as **Credentials found**;
- `enabled` is global, independent, default-true, and stored as `disabledProviders`;
- usable is `enabled && connected`;
- disable applies to new actions only;
- polling never clears runtime incidents;
- explicit Try again clears only the submitted incident;
- every failing task receives a safe persisted `provider-auth-required` event;
- the global runtime alert remains.

- [ ] **Step 2: Run the focused cross-layer regression**

Run:

```bash
npm test -- src/workspace/config.test.ts src/core/provider-availability.test.ts src/core/provider-auth.test.ts src/server/provider-action-gate.test.ts src/server/provider-action-gating.test.ts src/server/provider-auth-runtime.test.ts src/server/providers-api.test.ts src/server/workspace-events.test.ts src/runs/store.test.ts web/app/src/api/client.test.ts web/app/src/api/queries.test.tsx web/app/src/api/global-events.test.tsx web/app/src/lib/provider-status.test.ts web/app/src/components/engine-pills.test.ts web/app/src/components/provider-banner.test.tsx web/app/src/routes/new-task.test.tsx web/app/src/routes/settings/provider-settings.test.tsx web/app/src/routes/settings/agents-section.test.tsx web/app/src/routes/task-thread/thread-state.test.ts web/app/src/routes/task-thread/thread-groups.test.ts web/app/src/routes/task-thread/thread-items.test.tsx web/app/src/routes/task-thread/task-thread.test.tsx
```

Expected: every selected file passes.

- [ ] **Step 3: Start development mode for Browser QA**

Run:

```bash
npm run dev
```

Keep the process alive only for QA. Use the in-app Browser skill requested for this feature.

- [ ] **Step 4: Verify global disable and re-enable**

In Settings → Agents → Providers:

1. record an installed provider's discovery label and green dot;
2. disable it;
3. confirm the green **Credentials found** signal remains and **Disabled** appears;
4. confirm it disappears from new-task and follow-up provider choices;
5. confirm a pre-existing task is not cancelled or mutated;
6. reload and switch projects; confirm disabled state persists globally;
7. re-enable it and confirm it returns to choices.

Record provider, URLs, visible text, and outcomes in
`.superpowers/sdd/provider-availability-task-auth-report.md`.

- [ ] **Step 5: Verify a real Claude runtime 401**

Without editing or automating real credentials:

1. start a task with the currently invalid Claude credential;
2. observe the actual 401 in the task;
3. confirm Claude turns red immediately;
4. confirm the global runtime notification appears;
5. confirm the same task shows **Claude Code needs authorization**;
6. follow **Open provider settings** and confirm it lands at the providers anchor;
7. wait beyond 30 seconds and click **Check again**; confirm the runtime incident remains red;
8. do not click Try again unless the real login flow was completed by the user.

Delete only the disposable QA task/run/worktree/branch through normal recoverable app operations.
Do not modify provider credentials.

- [ ] **Step 6: Stop dev mode and confirm cleanup**

Stop the process, finalize Browser tabs, and verify no disposable run/worktree/branch remains.
Confirm the feature branch worktree is clean except the intended tracked documentation change.

- [ ] **Step 7: Run repository validation in required order**

Run:

```bash
npm run typecheck
npm test
npm run test:unit
npm run build
npm run test:package
```

Then run:

```bash
git diff --check
git status --short --branch
```

Expected:

- feature-focused tests pass;
- typecheck, unit, build/check:pack, and package gates pass;
- any full-Vitest failures are recorded with exact file/test names and clearly separated from the
  feature result;
- worktree contains only intended changes before the documentation commit.

- [ ] **Step 8: Commit Task 7**

```bash
git add .ai/specs/2026-07-22-provider-authentication.md
git commit -m "docs: record provider availability behavior"
```

- [ ] **Step 9: Request final whole-branch review**

Review from merge base `f93192d9db30b8ecef29c95caa4379ba5a9212cf` through `HEAD` against:

- `docs/superpowers/specs/2026-07-24-provider-availability-and-task-auth-recovery-design.md`
- this implementation plan;
- the canonical provider-authentication spec;
- `AGENT_PROTOCOL.md`;
- Browser and validation evidence.

Require findings ordered Critical, Important, Minor. Fix every finding test-first, rerun its
focused regression, and request re-review until no findings remain.
