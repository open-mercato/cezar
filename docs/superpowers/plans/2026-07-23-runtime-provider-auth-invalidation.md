# Runtime Provider Authentication Invalidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Immediately mark a provider disconnected when a running agent reports an authentication rejection, and keep it non-green until the user explicitly rechecks after reconnecting.

**Architecture:** Extend `ProviderAuthService` with a conservative runtime-error classifier and an in-memory per-provider failure latch. Observe normalized `RunStore` error events in the server, resolve the owning step backend, latch that provider, and broadcast one coarse `provider-status` row over the existing workspace SSE stream; the web client patches the workspace-scoped TanStack provider cache immediately and reconciles it after stream gaps.

**Tech Stack:** TypeScript ESM, Node 20 EventEmitter, Hono SSE, React 19, TanStack Query, Vitest, Testing Library.

## Global Constraints

- Work only on `codex/provider-auth-setup`; do not commit feature work to `main`.
- Treat `.ai/specs/2026-07-22-provider-authentication.md` and `docs/superpowers/specs/2026-07-23-runtime-provider-auth-invalidation-design.md` as the behavior contracts.
- Keep `/api/health`, the provider status response shape, and the 30-second poll unchanged.
- Keep provider authentication knowledge in `src/core/provider-auth.ts`; server wiring must consume its public classifier instead of adding vendor strings elsewhere.
- Never expose raw runtime errors, vendor command output, credentials, tokens, or account identity through the provider-status API or SSE.
- Runtime invalidation is host-wide and provider-specific. Resolve a step-level backend before the run-level backend; old records with neither continue to mean Claude.
- Normal reads and polling preserve runtime latches. Only `GET /api/providers/status?refresh=1` may clear a latch after a fresh `connected` probe.
- `POST /api/providers/connect` must preserve the latch so revoked-but-locally-present credentials still open the vendor login command.
- `CEZ_DRY_RUN=1` remains all-connected and does not acquire runtime latches.
- Add no config key, state file, migration, environment variable, dependency, network validation request, or provider credential-file read.
- Use strict TDD: add one behavior test, run it and observe the expected failure, add the minimum production code, rerun to green, then refactor.
- Preserve unrelated changes. Use `apply_patch` for repository file edits.
- Before each commit, run the named focused tests and `git diff --check`.

---

## File Map

- `.ai/specs/2026-07-22-provider-authentication.md` — extend the approved product contract with runtime invalidation and recovery semantics.
- `src/core/provider-auth.ts` — own runtime-auth message classification, the in-memory latch, status overlay, and explicit recovery.
- `src/core/provider-auth.test.ts` — pin classifier boundaries, latch behavior, explicit recovery, connect-preserving refresh primitives, and dry-run.
- `src/server/provider-auth-runtime.ts` — translate normalized run events into provider invalidations without adding vendor knowledge.
- `src/server/provider-auth-runtime.test.ts` — pin event-type filtering and mixed-workflow backend resolution against a real `RunStore`.
- `src/server/server.ts` — attach runtime observers to boot/lazy project stores, expose explicit recovery on GET, preserve latches on POST, and relay `provider-status` SSE.
- `src/server/providers-api.test.ts` — prove a runtime rejection immediately changes API truth and does not let Connect mistake revoked credentials for connected.
- `src/server/workspace-events.test.ts` — prove runtime invalidation from a lazily built project reaches the workspace stream.
- `web/app/src/lib/provider-status.ts` — parse one safe provider row and patch an existing complete response without inventing a cache.
- `web/app/src/lib/provider-status.test.ts` — pin row validation and immutable replacement behavior.
- `web/app/src/api/global-events.tsx` — listen for workspace `provider-status`, patch the provider query, and reconcile it after missed events.
- `web/app/src/api/global-events.test.tsx` — prove immediate cache updates, malformed-frame isolation, workspace scope, and reconnect reconciliation.

---

### Task 1: Add Runtime Failure Classification and Latch Semantics

**Files:**

- Modify: `.ai/specs/2026-07-22-provider-authentication.md`
- Modify: `src/core/provider-auth.ts`
- Modify: `src/core/provider-auth.test.ts`

**Interfaces:**

- Produces:

```ts
export function isRuntimeProviderAuthFailure(message: string): boolean

export class ProviderAuthService {
  status(options?: {
    refresh?: boolean
    recoverRuntimeFailures?: boolean
  }): Promise<ProviderStatusResponse>

  reportRuntimeAuthFailure(provider: ProviderId): ProviderStatus | null
}
```

- `reportRuntimeAuthFailure()` returns the fixed disconnected row only on the first transition; duplicate v1/v2 reports return `null` so the server emits one SSE transition.

- [ ] **Step 1: Add failing classifier tests**

Add table-driven tests to `src/core/provider-auth.test.ts`:

```ts
describe('runtime provider authentication failures', () => {
  it.each([
    'claude CLI exited with code 1 — Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
    'codex: turn failed: unauthorized',
    'ProviderAuthError: API key expired — run `opencode auth login`',
    'access token is invalid',
    'authentication failed with HTTP 401',
  ])('recognizes an authoritative runtime auth rejection: %s', (message) => {
    expect(isRuntimeProviderAuthFailure(message)).toBe(true)
  })

  it.each([
    'claude CLI exited with code 1 — TypeScript check failed',
    'API Error: 429 rate limit exceeded',
    'the agent fixed a 401 response in src/auth.ts',
    'network connection reset',
  ])('does not turn unrelated failures into credential failures: %s', (message) => {
    expect(isRuntimeProviderAuthFailure(message)).toBe(false)
  })
})
```

- [ ] **Step 2: Run the classifier test and verify RED**

Run:

```bash
npm test -- src/core/provider-auth.test.ts
```

Expected: FAIL because `isRuntimeProviderAuthFailure` is not exported.

- [ ] **Step 3: Implement the conservative pure classifier**

Add anchored auth-context patterns in `src/core/provider-auth.ts`. Keep a bare `401` insufficient:

```ts
const RUNTIME_AUTH_FAILURE_PATTERNS = [
  /\b(?:failed to authenticate|authentication failed|unauthenticated|unauthorized)\b/i,
  /\bproviderautherror\b/i,
  /\b(?:oauth|access|refresh)?\s*token\b.{0,80}\b(?:revoked|expired|invalid)\b/i,
  /\b(?:revoked|expired|invalid)\b.{0,80}\b(?:oauth|access|refresh)?\s*token\b/i,
  /\bapi key\b.{0,80}\b(?:revoked|expired|invalid)\b/i,
  /\b(?:oauth|token|credential|unauthorized|unauthenticated)\b.{0,80}\b401\b/i,
  /\b401\b.{0,80}\b(?:oauth|token|credential|unauthorized|unauthenticated)\b/i,
] as const

export function isRuntimeProviderAuthFailure(message: string): boolean {
  return RUNTIME_AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(message))
}
```

- [ ] **Step 4: Run the classifier test and verify GREEN**

Run:

```bash
npm test -- src/core/provider-auth.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add failing latch and recovery tests**

Add tests using a command runner whose Claude probe always returns `{"loggedIn":true}`:

```ts
it('overrides a connected probe after a runtime rejection and survives ordinary polling', async () => {
  const service = new ProviderAuthService({ runCommand: runner() })

  await expect(service.status()).resolves.toMatchObject({
    providers: [{ provider: 'claude', status: 'connected' }],
  })
  expect(service.reportRuntimeAuthFailure('claude')).toEqual({
    provider: 'claude',
    status: 'disconnected',
    hint: 'Authentication was rejected during a run. Reconnect, then check again.',
  })
  expect(service.reportRuntimeAuthFailure('claude')).toBeNull()

  await expect(service.status()).resolves.toMatchObject({
    providers: [{ provider: 'claude', status: 'disconnected' }],
  })
})

it('clears a runtime latch only after an explicit fresh connected recovery probe', async () => {
  const service = new ProviderAuthService({ runCommand: runner() })
  service.reportRuntimeAuthFailure('claude')

  await expect(service.status({ refresh: true })).resolves.toMatchObject({
    providers: [{ provider: 'claude', status: 'disconnected' }],
  })
  await expect(service.status({
    refresh: true,
    recoverRuntimeFailures: true,
  })).resolves.toMatchObject({
    providers: [{ provider: 'claude', status: 'connected' }],
  })
})

it('keeps CEZ_DRY_RUN connected and ignores runtime invalidation', async () => {
  process.env.CEZ_DRY_RUN = '1'
  const service = new ProviderAuthService({ runCommand: runner() })

  expect(service.reportRuntimeAuthFailure('claude')).toBeNull()
  await expect(service.status()).resolves.toMatchObject({
    providers: [{ provider: 'claude', status: 'connected' }],
  })
})
```

- [ ] **Step 6: Run the latch tests and verify RED**

Run:

```bash
npm test -- src/core/provider-auth.test.ts
```

Expected: FAIL because `reportRuntimeAuthFailure` and `recoverRuntimeFailures` do not exist.

- [ ] **Step 7: Implement raw-cache overlay and explicit recovery**

Keep the existing cached/in-flight promise as the raw vendor answer so the current promise
coalescing contract remains intact. Add:

```ts
const RUNTIME_AUTH_HINT =
  'Authentication was rejected during a run. Reconnect, then check again.'

private readonly runtimeFailures = new Set<ProviderId>()

reportRuntimeAuthFailure(provider: ProviderId): ProviderStatus | null {
  if (process.env.CEZ_DRY_RUN === '1' || this.runtimeFailures.has(provider)) return null
  this.runtimeFailures.add(provider)
  return { provider, status: 'disconnected', hint: RUNTIME_AUTH_HINT }
}

private withRuntimeFailures(response: ProviderStatusResponse): ProviderStatusResponse {
  if (this.runtimeFailures.size === 0) return response
  return {
    providers: response.providers.map((row) =>
      this.runtimeFailures.has(row.provider)
        ? { provider: row.provider, status: 'disconnected', hint: RUNTIME_AUTH_HINT }
        : row),
  }
}

private recoverRuntimeFailures(response: ProviderStatusResponse): ProviderStatusResponse {
  for (const row of response.providers) {
    if (row.status === 'connected') this.runtimeFailures.delete(row.provider)
  }
  return this.withRuntimeFailures(response)
}
```

Refactor `status()` so its existing probe/cache path produces `base`, then:

```ts
if (options?.recoverRuntimeFailures) {
  return base.then((response) => this.recoverRuntimeFailures(response))
}
if (this.runtimeFailures.size > 0) {
  return base.then((response) => this.withRuntimeFailures(response))
}
return base
```

Do not clear latches on `refresh: true` alone.

- [ ] **Step 8: Run core provider tests and verify GREEN**

Run:

```bash
npm test -- src/core/provider-auth.test.ts
```

Expected: all provider parser, cache, coalescing, runtime latch, and dry-run tests pass.

- [ ] **Step 9: Extend the approved feature spec**

Add a “Runtime invalidation” section to `.ai/specs/2026-07-22-provider-authentication.md` covering:

- runtime rejection outranks stored-login status;
- per-provider in-memory latch;
- ordinary 30-second polling preserves the latch;
- explicit `?refresh=1` recovery;
- Connect preserves the latch;
- additive workspace `provider-status` SSE;
- no raw runtime error leaves the server.

- [ ] **Step 10: Check and commit Task 1**

Run:

```bash
git diff --check
npm test -- src/core/provider-auth.test.ts
```

Commit:

```bash
git add .ai/specs/2026-07-22-provider-authentication.md src/core/provider-auth.ts src/core/provider-auth.test.ts
git commit -m "feat: latch runtime provider auth failures"
```

---

### Task 2: Observe Run Errors and Broadcast Provider Invalidation

**Files:**

- Create: `src/server/provider-auth-runtime.ts`
- Create: `src/server/provider-auth-runtime.test.ts`
- Modify: `src/server/server.ts`
- Modify: `src/server/providers-api.test.ts`
- Modify: `src/server/workspace-events.test.ts`

**Interfaces:**

- Consumes:

```ts
isRuntimeProviderAuthFailure(message: string): boolean
ProviderAuthService.reportRuntimeAuthFailure(provider: ProviderId): ProviderStatus | null
```

- Produces:

```ts
export function watchProviderRuntimeAuthFailures(
  store: RunStore,
  providerAuth: ProviderAuthService,
  onInvalidated: (status: ProviderStatus) => void,
): () => void
```

- Adds workspace event name `provider-status` whose JSON payload is one `ProviderStatus`.

- [ ] **Step 1: Add failing runtime observer tests**

Create `src/server/provider-auth-runtime.test.ts` with real temporary `RunStore` instances and a
real `ProviderAuthService` using the existing deterministic command runner pattern. Cover:

```ts
it('invalidates the step backend for an auth error in a mixed-provider run')
it('falls back to the run backend when the event has no matching step')
it('treats a legacy run with no backend as Claude')
it.each(['error', 'session.error', 'note'])(
  'observes auth failures carried by %s events',
)
it('ignores unrelated errors and non-message events')
it('emits only once when v1 and v2 report the same provider failure')
it('unsubscribes cleanly')
```

The mixed-provider setup must prove precedence:

```ts
const run = store.createRun({
  title: 'mixed',
  workflow: 'mixed',
  task: 'work',
  runner: 'claude',
  steps: [{ id: 'implement', name: 'Implement', kind: 'agent' }],
})
store.updateStep(run.id, 'implement', { backend: 'codex' })
store.appendEvent(run.id, {
  type: 'error',
  stepId: 'implement',
  message: 'authentication failed with HTTP 401',
})
expect(onInvalidated).toHaveBeenCalledWith({
  provider: 'codex',
  status: 'disconnected',
  hint: expect.any(String),
})
```

- [ ] **Step 2: Run observer tests and verify RED**

Run:

```bash
npm test -- src/server/provider-auth-runtime.test.ts
```

Expected: FAIL because `src/server/provider-auth-runtime.ts` does not exist.

- [ ] **Step 3: Implement the normalized event observer**

Create `src/server/provider-auth-runtime.ts`:

```ts
import {
  isRuntimeProviderAuthFailure,
  type ProviderAuthService,
  type ProviderId,
  type ProviderStatus,
} from '../core/provider-auth.js'
import type { RunEvent, RunStore } from '../runs/store.js'

const AUTH_ERROR_EVENT_TYPES = new Set(['error', 'session.error', 'note'])

export function watchProviderRuntimeAuthFailures(
  store: RunStore,
  providerAuth: ProviderAuthService,
  onInvalidated: (status: ProviderStatus) => void,
): () => void {
  const onEvent = ({ runId, event }: { runId: string; event: RunEvent }): void => {
    if (!AUTH_ERROR_EVENT_TYPES.has(event.type)) return
    const message = event.message
    if (typeof message !== 'string' || !isRuntimeProviderAuthFailure(message)) return

    const run = store.getRun(runId)
    if (!run) return
    const step = typeof event.stepId === 'string'
      ? run.steps.find(({ id }) => id === event.stepId)
      : undefined
    const provider: ProviderId = step?.backend ?? run.runner ?? 'claude'
    const status = providerAuth.reportRuntimeAuthFailure(provider)
    if (status) onInvalidated(status)
  }

  store.on('event', onEvent)
  return () => store.off('event', onEvent)
}
```

Do not inspect `event.text`, tool output, or user prompts.

- [ ] **Step 4: Run observer tests and verify GREEN**

Run:

```bash
npm test -- src/server/provider-auth-runtime.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add failing API and workspace-stream tests**

In `src/server/providers-api.test.ts`, add a real boot-store integration test:

```ts
it('changes API truth immediately after a runtime auth rejection', async () => {
  const providerAuth = service()
  const bus = new WorkspaceEventBus()
  const seen: unknown[] = []
  bus.on((event, data) => {
    if (event === 'provider-status') seen.push(data)
  })
  const server = app({ providerAuth, workspaceEvents: bus })
  const run = store.createRun({
    title: 'auth',
    workflow: 'quick-task',
    task: 'work',
    runner: 'claude',
    steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
  })
  store.updateStep(run.id, 'work', { backend: 'claude' })

  store.appendEvent(run.id, {
    type: 'error',
    stepId: 'work',
    message: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
  })

  expect(seen).toEqual([{
    provider: 'claude',
    status: 'disconnected',
    hint: 'Authentication was rejected during a run. Reconnect, then check again.',
  }])
  await expect((await apiRequest(server, '/api/providers/status')).json()).resolves
    .toMatchObject({ providers: [{ provider: 'claude', status: 'disconnected' }] })
})
```

Add two route-semantics tests:

- `POST /api/providers/connect` still opens Claude login while the raw probe says connected but a
  runtime latch exists.
- `GET /api/providers/status?refresh=1` clears that latch after the fresh connected probe.

In `src/server/workspace-events.test.ts`, add a test that builds the non-boot context, opens
`/api/workspace/events`, temporarily disables `CEZ_DRY_RUN`, appends an auth error to that lazy
context's store, and expects:

```text
event: provider-status
data: {"provider":"opencode","status":"disconnected",...}
```

Restore `CEZ_DRY_RUN=1` in a `finally` block.

- [ ] **Step 6: Run server tests and verify RED**

Run:

```bash
npm test -- src/server/providers-api.test.ts src/server/workspace-events.test.ts
```

Expected: FAIL because the app does not attach runtime observers, GET does not request recovery,
and the workspace event type does not include `provider-status`.

- [ ] **Step 7: Wire boot and lazy project stores into the host-wide latch**

In `src/server/server.ts`:

1. Extend the additive workspace event union:

```ts
export type WorkspaceEventName =
  | 'project-added'
  | 'project-removed'
  | 'checkout-progress'
  | 'provider-status'
```

2. After `providerAuth`, `contexts`, and `workspaceEvents` exist, attach each store exactly once:

```ts
const watchedProviderStores = new WeakSet<RunStore>()
const watchProviderStore = (store: RunStore): void => {
  if (watchedProviderStores.has(store)) return
  watchedProviderStores.add(store)
  watchProviderRuntimeAuthFailures(store, providerAuth, (status) => {
    workspaceEvents.emit('provider-status', status)
  })
}

watchProviderStore(bootContext.store)
for (const id of contexts.ids()) {
  const ctx = contexts.peek(id)
  if (ctx) watchProviderStore(ctx.store)
}
contexts.onContextBuilt((ctx) => watchProviderStore(ctx.store))
```

The lazy-context hook must not instantiate any project.

3. Change only the explicit GET recovery path:

```ts
const refresh = query.data.refresh === '1'
return c.json(await providerAuth.status({
  refresh,
  recoverRuntimeFailures: refresh,
}))
```

4. Leave Connect on:

```ts
providerAuth.status({ refresh: true })
```

so it sees the latched disconnected overlay and opens login.

The existing workspace SSE bus relay automatically carries `provider-status`; do not stamp it
with a project id.

- [ ] **Step 8: Run all focused server tests and verify GREEN**

Run:

```bash
npm test -- src/server/provider-auth-runtime.test.ts src/server/providers-api.test.ts src/server/workspace-events.test.ts
```

Expected: PASS.

- [ ] **Step 9: Check and commit Task 2**

Run:

```bash
git diff --check
npm run typecheck
```

Commit:

```bash
git add src/server/provider-auth-runtime.ts src/server/provider-auth-runtime.test.ts src/server/server.ts src/server/providers-api.test.ts src/server/workspace-events.test.ts
git commit -m "feat: broadcast runtime provider auth failures"
```

---

### Task 3: Patch Provider Status in the Cockpit Immediately

**Files:**

- Modify: `web/app/src/lib/provider-status.ts`
- Modify: `web/app/src/lib/provider-status.test.ts`
- Modify: `web/app/src/api/global-events.tsx`
- Modify: `web/app/src/api/global-events.test.tsx`

**Interfaces:**

- Consumes the existing `ProviderStatus` and `ProviderStatusResponse` types.
- Produces:

```ts
export function parseProviderStatusRow(value: unknown): ProviderStatus | null

export function applyProviderStatusRow(
  response: ProviderStatusResponse | undefined,
  row: ProviderStatus,
): ProviderStatusResponse | undefined
```

- [ ] **Step 1: Add failing pure row parser/reducer tests**

In `web/app/src/lib/provider-status.test.ts`, add:

```ts
it('parses one coarse provider-status SSE row', () => {
  expect(parseProviderStatusRow({
    provider: 'claude',
    status: 'disconnected',
    hint: 'Reconnect, then check again.',
  })).toEqual({
    provider: 'claude',
    status: 'disconnected',
    hint: 'Reconnect, then check again.',
  })
})

it.each([
  null,
  { provider: 'future', status: 'disconnected' },
  { provider: 'claude', status: 'future' },
  { provider: 'claude', status: 'disconnected', hint: 1 },
])('rejects malformed provider-status SSE rows: %#', (value) => {
  expect(parseProviderStatusRow(value)).toBeNull()
})

it('replaces one row immutably without inventing a missing cache', () => {
  expect(applyProviderStatusRow(undefined, {
    provider: 'claude',
    status: 'disconnected',
  })).toBeUndefined()

  expect(applyProviderStatusRow(CONNECTED, {
    provider: 'claude',
    status: 'disconnected',
  })).toEqual({
    providers: [
      { provider: 'claude', status: 'disconnected' },
      CONNECTED.providers[1],
      CONNECTED.providers[2],
    ],
  })
})
```

- [ ] **Step 2: Run provider-status library tests and verify RED**

Run:

```bash
npm test -- web/app/src/lib/provider-status.test.ts
```

Expected: FAIL because the row parser and reducer do not exist.

- [ ] **Step 3: Implement one-row validation and immutable replacement**

Refactor the existing validation predicates in `web/app/src/lib/provider-status.ts` without
loosening complete-response validation:

```ts
export function parseProviderStatusRow(value: unknown): ProviderStatus | null {
  if (!isRecord(value)) return null
  const { provider, status, hint } = value
  if (
    typeof provider !== 'string'
    || !RUNNER_ORDER.includes(provider as Runner)
    || typeof status !== 'string'
    || !PROVIDER_STATES.has(status)
    || (hint !== undefined && typeof hint !== 'string')
  ) return null
  return {
    provider: provider as Runner,
    status: status as ProviderStatus['status'],
    ...(hint === undefined ? {} : { hint }),
  }
}

export function applyProviderStatusRow(
  response: ProviderStatusResponse | undefined,
  row: ProviderStatus,
): ProviderStatusResponse | undefined {
  const providers = completeProviderRows(response)
  if (providers === null) return undefined
  return {
    providers: providers.map((candidate) =>
      candidate.provider === row.provider ? row : candidate),
  }
}
```

Reuse `parseProviderStatusRow()` inside `safeProviderRows()` so full responses and SSE rows have
one validation rule.

- [ ] **Step 4: Run provider-status library tests and verify GREEN**

Run:

```bash
npm test -- web/app/src/lib/provider-status.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add failing global SSE cache tests**

In `web/app/src/api/global-events.test.tsx`, seed
`workspaceQueryKeys.providerStatus`, mount the real `useGlobalEvents`, and add:

```ts
it('patches the provider cache immediately from a workspace provider-status event', () => {
  client.setQueryData(workspaceQueryKeys.providerStatus, CONNECTED_PROVIDERS)
  const { source } = mount()

  source.emit('provider-status', JSON.stringify({
    provider: 'claude',
    status: 'disconnected',
    hint: 'Authentication was rejected during a run. Reconnect, then check again.',
  }))

  expect(client.getQueryData<ProviderStatusResponse>(
    workspaceQueryKeys.providerStatus,
  )?.providers[0]).toEqual({
    provider: 'claude',
    status: 'disconnected',
    hint: 'Authentication was rejected during a run. Reconnect, then check again.',
  })
  expect(fetch).not.toHaveBeenCalled()
})
```

Also add tests that:

- malformed JSON and malformed rows leave the cache unchanged and do not poison the next event;
- an absent provider cache remains absent;
- the event applies while a different project scope is active because provider auth is
  workspace-wide;
- reconnect and visibility reconciliation include `workspaceQueryKeys.providerStatus`.

- [ ] **Step 6: Run global stream tests and verify RED**

Run:

```bash
npm test -- web/app/src/api/global-events.test.tsx
```

Expected: FAIL because `provider-status` has no listener and reconcile omits the provider key.

- [ ] **Step 7: Add the workspace provider-status listener and reconcile key**

In `web/app/src/api/global-events.tsx`:

```ts
import { applyProviderStatusRow, parseProviderStatusRow } from '@/lib/provider-status'
import type {
  ApiRun,
  HealthResponse,
  ProcessUsage,
  ProviderStatusResponse,
} from './types'
```

Add provider status to reconciliation:

```ts
void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.providerStatus })
```

Register one dedicated workspace-wide listener:

```ts
source.addEventListener('provider-status', (event) => {
  let payload: unknown
  try {
    payload = JSON.parse((event as MessageEvent<string>).data)
  } catch {
    return
  }
  const row = parseProviderStatusRow(payload)
  if (!row) return
  queryClient.setQueryData<ProviderStatusResponse>(
    workspaceQueryKeys.providerStatus,
    (response) => applyProviderStatusRow(response, row),
  )
})
```

Do not project-filter the event and do not invalidate/refetch on each runtime transition.

- [ ] **Step 8: Run client-focused tests and verify GREEN**

Run:

```bash
npm test -- web/app/src/lib/provider-status.test.ts web/app/src/api/global-events.test.tsx web/app/src/components/app-shell-container.test.tsx web/app/src/routes/settings/provider-settings.test.tsx
```

Expected: PASS; the existing banner/settings components react through the shared query without
component changes.

- [ ] **Step 9: Check and commit Task 3**

Run:

```bash
git diff --check
npm run typecheck
```

Commit:

```bash
git add web/app/src/lib/provider-status.ts web/app/src/lib/provider-status.test.ts web/app/src/api/global-events.tsx web/app/src/api/global-events.test.tsx
git commit -m "feat: update provider status from runtime failures"
```

---

### Task 4: Full Verification and Review

**Files:**

- No planned production edits. If a verification failure is caused by this feature, return to the
  owning task and add a failing regression test before fixing it.

- [ ] **Step 1: Run the focused regression suite**

Run:

```bash
npm test -- src/core/provider-auth.test.ts src/server/provider-auth-runtime.test.ts src/server/providers-api.test.ts src/server/workspace-events.test.ts web/app/src/lib/provider-status.test.ts web/app/src/api/global-events.test.tsx web/app/src/components/app-shell-container.test.tsx web/app/src/routes/settings/provider-settings.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run repository validation in required order**

Run:

```bash
npm run typecheck
npm test
npm run test:unit
npm run build
npm run test:package
```

Record pre-existing unrelated failures separately; do not weaken tests or broaden this fix to
make unrelated red gates disappear.

- [ ] **Step 3: Run the separate browser suite**

Run:

```bash
npm run test:e2e
```

Report its explicit `TEST_E2E_STATUS=passed|skipped|failed` marker.

- [ ] **Step 4: Manually verify the runtime transition with safe shims**

Run `npm run dev` with temporary provider CLI shims, not real credentials. Start with Claude
connected, open the cockpit using the in-app Browser, append or trigger the same normalized
runtime error through the test harness, and verify:

1. Claude turns non-green without a 30-second wait;
2. the global banner and provider-gated task controls update immediately;
3. an ordinary poll does not restore green;
4. Connect still offers the Claude login flow;
5. explicit “Check again” restores green only after the shim reports connected.

- [ ] **Step 5: Review and final diff checks**

Run:

```bash
git diff --check
git status --short
git log --oneline --decorate -8
```

Use `superpowers:requesting-code-review` for the completed branch. Address only verified findings
through a new red-green cycle.
