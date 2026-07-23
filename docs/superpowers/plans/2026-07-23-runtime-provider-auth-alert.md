# Runtime Provider Authentication Alert Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a dismissible app-wide alert for every provider whose credentials are rejected at runtime, even when another provider remains connected.

**Architecture:** Extend the existing runtime-auth latch with an opaque incident ID and carry that additive field through the existing provider REST/SSE contract. Derive undismissed incidents in a small browser utility, persist dismissed provider-to-incident mappings through workspace UI state, and keep `ProviderBanner` presentational while a focused container owns queries and mutation ordering.

**Tech Stack:** Strict TypeScript ESM, Node 20+, Hono, Zod, React 19, TanStack Query, React Router, Tailwind v4, Vitest, Testing Library, in-app Browser.

## Global Constraints

- Keep `/api/health` unchanged; provider authentication remains under `/api/providers/status`.
- Never send raw runtime errors, credentials, account identity, or vendor command output to the browser.
- Keep `CEZ_DRY_RUN=1` connected and ignore runtime failure reports.
- Keep the 30-second provider poll and existing explicit **Check again** recovery semantics.
- Dismissal changes notification visibility only; it never reconnects a provider or enables task controls.
- Runtime alerts list providers in this exact order: Claude Code, Codex, OpenCode.
- The existing generic zero-connected-provider safety banner remains non-dismissible.
- Do not add dependencies, environment variables, config keys, endpoints, or migrations.

## File Structure

- `src/core/provider-auth.ts` — owns runtime latch identity and overlays `authFailureId` on status rows.
- `src/core/provider-auth.test.ts` — pins incident identity, duplicate-report, polling, recovery, and dry-run behavior.
- `src/server/provider-auth-runtime.test.ts` — pins the safe incident-bearing invalidation row emitted from run events.
- `src/server/providers-api.test.ts` — pins the REST response and workspace SSE payload.
- `src/server/server.ts` — validates the bounded workspace dismissal map.
- `src/server/workspace-api.test.ts` — pins workspace UI-state persistence and rejection of malformed maps.
- `src/server/api-types.test.ts` — continues to enforce exact server/browser provider-status types.
- `web/app/src/api/types.ts` — mirrors `authFailureId` and `dismissedProviderAuthFailures`.
- `web/app/src/lib/provider-status.ts` — validates and preserves the optional incident ID.
- `web/app/src/lib/provider-status.test.ts` — pins REST/SSE parsing and private-field stripping.
- `web/app/src/api/client.test.ts` — pins provider response normalization.
- `web/app/src/lib/provider-auth-alert.ts` — pure normalization, incident filtering, display labels, and dismissal merging.
- `web/app/src/lib/provider-auth-alert.test.ts` — table-tests alert derivation without React or network state.
- `web/app/src/components/provider-banner.tsx` — renders runtime and generic banner variants.
- `web/app/src/components/provider-banner.test.tsx` — pins copy, precedence, ordering, links, and accessibility.
- `web/app/src/components/provider-banner-container.tsx` — owns provider/UI-state queries and serialized optimistic dismissal writes.
- `web/app/src/components/provider-banner-container.test.tsx` — pins persistence, reload behavior, and rollback on failure.
- `web/app/src/components/app-shell-container.tsx` — mounts the focused provider banner container.
- `web/app/src/components/app-shell-container.test.tsx` — proves the alert occupies the global shell slot.
- `.ai/specs/2026-07-22-provider-authentication.md` — records the additive incident field and runtime-alert precedence.

---

### Task 1: Give Each Runtime Authentication Latch an Opaque Incident ID

**Files:**
- Modify: `src/core/provider-auth.ts:1-20, 215-315`
- Modify: `web/app/src/api/types.ts:43-60`
- Test: `src/core/provider-auth.test.ts`
- Test: `src/server/provider-auth-runtime.test.ts`
- Test: `src/server/providers-api.test.ts`

**Interfaces:**
- Produces: `ProviderStatus.authFailureId?: string`
- Produces: the exact browser mirror `ProviderStatus.authFailureId?: string`
- Produces: `ProviderAuthService` constructor option `createAuthFailureId?: () => string`
- Preserves: `reportRuntimeAuthFailure(provider: ProviderId): ProviderStatus | null`

- [ ] **Step 1: Write failing core tests for stable and renewed incident identity**

Add deterministic ID injection and assertions equivalent to:

```ts
it('keeps one incident id until recovery and creates a new id after recovery', async () => {
  const ids = ['incident-1', 'incident-2']
  const service = new ProviderAuthService({
    platform: 'linux',
    runCommand: runner(),
    createAuthFailureId: () => ids.shift()!,
  })

  expect(service.reportRuntimeAuthFailure('claude')).toEqual({
    provider: 'claude',
    status: 'disconnected',
    hint: 'Authentication was rejected during a run. Reconnect, then check again.',
    authFailureId: 'incident-1',
  })
  expect(service.reportRuntimeAuthFailure('claude')).toBeNull()
  await expect(service.status()).resolves.toMatchObject({
    providers: expect.arrayContaining([
      expect.objectContaining({ provider: 'claude', authFailureId: 'incident-1' }),
    ]),
  })

  await service.status({ refresh: true, recoverRuntimeFailures: true })

  expect(service.reportRuntimeAuthFailure('claude')).toMatchObject({
    authFailureId: 'incident-2',
  })
})
```

Extend the dry-run test to assert that no incident ID is allocated when
`reportRuntimeAuthFailure()` returns `null`.

- [ ] **Step 2: Write failing server-observer and API/SSE assertions**

Inject `createAuthFailureId: () => 'auth-incident-1'` into the relevant test services and require:

```ts
expect(onInvalidated).toHaveBeenCalledWith({
  provider: 'codex',
  status: 'disconnected',
  hint: expect.any(String),
  authFailureId: 'auth-incident-1',
})
```

and:

```ts
expect(seen).toEqual([{
  provider: 'claude',
  status: 'disconnected',
  hint: 'Authentication was rejected during a run. Reconnect, then check again.',
  authFailureId: 'auth-incident-1',
}])
```

Also require `GET /api/providers/status` to return the same ID while the latch remains active.

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```bash
npm test -- src/core/provider-auth.test.ts src/server/provider-auth-runtime.test.ts src/server/providers-api.test.ts
```

Expected: FAIL because `ProviderStatus` has no `authFailureId` and the constructor does not accept
`createAuthFailureId`.

- [ ] **Step 4: Implement incident identity in `ProviderAuthService`**

Import `randomUUID` from `node:crypto`, extend the server and browser `ProviderStatus` interfaces,
and replace the numeric map with:

```ts
interface RuntimeAuthFailure {
  generation: number
  authFailureId: string
}

export interface ProviderStatus {
  provider: ProviderId
  status: ProviderConnectionState
  hint?: string
  authFailureId?: string
}

private readonly createAuthFailureId: () => string
private readonly runtimeFailures = new Map<ProviderId, RuntimeAuthFailure>()
```

Initialize the factory without changing default construction:

```ts
constructor(options?: {
  runCommand?: RunProviderCommand
  now?: () => number
  platform?: NodeJS.Platform
  createAuthFailureId?: () => string
}) {
  this.runCommand = options?.runCommand ?? defaultRunProviderCommand
  this.now = options?.now ?? Date.now
  this.platform = options?.platform ?? process.platform
  this.createAuthFailureId = options?.createAuthFailureId ?? randomUUID
}
```

Preserve an incident across duplicate reports while still advancing the generation that protects
recovery races:

```ts
reportRuntimeAuthFailure(provider: ProviderId): ProviderStatus | null {
  if (process.env.CEZ_DRY_RUN === '1') return null
  const current = this.runtimeFailures.get(provider)
  const failure: RuntimeAuthFailure = {
    generation: ++this.nextRuntimeFailureGeneration,
    authFailureId: current?.authFailureId ?? this.createAuthFailureId(),
  }
  this.runtimeFailures.set(provider, failure)
  if (current) return null
  return {
    provider,
    status: 'disconnected',
    hint: RUNTIME_AUTH_HINT,
    authFailureId: failure.authFailureId,
  }
}
```

Update `withRuntimeFailures()` to include the latched ID. Update recovery snapshots/comparisons to
compare `failure.generation`, while successful recovery deletes the complete object.

- [ ] **Step 5: Run the focused tests and typecheck**

Run:

```bash
npm test -- src/core/provider-auth.test.ts src/server/provider-auth-runtime.test.ts src/server/providers-api.test.ts
npm run typecheck
```

Expected: all selected tests pass and both TypeScript projects report no errors.

- [ ] **Step 6: Commit the core incident contract**

```bash
git add src/core/provider-auth.ts web/app/src/api/types.ts src/core/provider-auth.test.ts src/server/provider-auth-runtime.test.ts src/server/providers-api.test.ts
git commit -m "feat: identify runtime provider auth incidents"
```

---

### Task 2: Validate the Incident Field and Workspace Dismissal State

**Files:**
- Modify: `web/app/src/api/types.ts:388-410`
- Modify: `web/app/src/lib/provider-status.ts:1-35`
- Test: `web/app/src/lib/provider-status.test.ts`
- Test: `web/app/src/api/client.test.ts`
- Modify: `src/server/server.ts:439-475`
- Test: `src/server/workspace-api.test.ts:234-300`
- Verify: `src/server/api-types.test.ts:140-150`

**Interfaces:**
- Consumes: `ProviderStatus.authFailureId?: string`
- Produces: `WorkspaceUiState.dismissedProviderAuthFailures?: Partial<Record<ProviderId, string>>`
- Preserves: `parseProviderStatusRow(value: unknown): ProviderStatus | null`

- [ ] **Step 1: Write failing client-boundary tests**

Require the parser to preserve a bounded incident field:

```ts
expect(parseProviderStatusRow({
  provider: 'claude',
  status: 'disconnected',
  hint: 'Reconnect.',
  authFailureId: 'incident-1',
  raw: 'private',
})).toEqual({
  provider: 'claude',
  status: 'disconnected',
  hint: 'Reconnect.',
  authFailureId: 'incident-1',
})
```

Add malformed cases for `authFailureId: 1`, `authFailureId: ''`, and a 129-character string, all
of which must return `null`. Update the API client normalization test so a valid ID survives while
unrecognized fields remain stripped.

- [ ] **Step 2: Write failing workspace UI-state API tests**

Add this accepted write:

```ts
const response = await putUiState({
  dismissedProviderAuthFailures: {
    claude: 'incident-1',
    opencode: 'incident-9',
  },
})
expect(response.status).toBe(200)
expect(await response.json()).toMatchObject({
  dismissedProviderAuthFailures: {
    claude: 'incident-1',
    opencode: 'incident-9',
  },
})
```

Add rejected writes for an unknown provider key, an empty ID, a non-string ID, and a string longer
than 128 characters. Each response must be 400 and must not create the UI-state file.

- [ ] **Step 3: Run the boundary tests and verify RED**

Run:

```bash
npm test -- web/app/src/lib/provider-status.test.ts web/app/src/api/client.test.ts src/server/workspace-api.test.ts src/server/api-types.test.ts
```

Expected: FAIL because the client strips `authFailureId` and the workspace schema accepts or strips
the new map instead of validating it.

- [ ] **Step 4: Implement strict row parsing**

Preserve the Task 1 browser field only when valid. In `parseProviderStatusRow()` validate:

```ts
const { provider, status, hint, authFailureId } = value
if (
  typeof provider !== 'string'
  || !RUNNER_ORDER.includes(provider as Runner)
  || typeof status !== 'string'
  || !PROVIDER_STATES.has(status)
  || (hint !== undefined && typeof hint !== 'string')
  || (
    authFailureId !== undefined
    && (
      typeof authFailureId !== 'string'
      || authFailureId.length < 1
      || authFailureId.length > 128
      || status !== 'disconnected'
    )
  )
) return null
return {
  provider: provider as Runner,
  status: status as ProviderStatus['status'],
  ...(hint === undefined ? {} : { hint }),
  ...(authFailureId === undefined ? {} : { authFailureId }),
}
```

- [ ] **Step 5: Implement the bounded workspace dismissal schema and browser mirror**

Add the browser type:

```ts
dismissedProviderAuthFailures?: Partial<Record<ProviderId, string>>
```

Add a strict server schema with only fixed provider keys:

```ts
const providerAuthDismissalsSchema = z
  .object({
    claude: z.string().min(1).max(128).optional(),
    codex: z.string().min(1).max(128).optional(),
    opencode: z.string().min(1).max(128).optional(),
  })
  .strict()
```

Then add
`dismissedProviderAuthFailures: providerAuthDismissalsSchema.optional()` to
`workspaceUiStateSchema`. Do not add it to the per-project `uiStateSchema`.

- [ ] **Step 6: Run focused boundary tests and typecheck**

Run:

```bash
npm test -- web/app/src/lib/provider-status.test.ts web/app/src/api/client.test.ts src/server/workspace-api.test.ts src/server/api-types.test.ts web/app/src/api/global-events.test.tsx
npm run typecheck
```

Expected: all selected tests pass; the existing SSE cache reducer preserves `authFailureId`.

- [ ] **Step 7: Commit the validated browser/persistence contract**

```bash
git add web/app/src/api/types.ts web/app/src/lib/provider-status.ts web/app/src/lib/provider-status.test.ts web/app/src/api/client.test.ts src/server/server.ts src/server/workspace-api.test.ts src/server/api-types.test.ts
git commit -m "feat: validate provider auth alert state"
```

---

### Task 3: Derive Visible Runtime Authentication Incidents Purely

**Files:**
- Create: `web/app/src/lib/provider-auth-alert.ts`
- Create: `web/app/src/lib/provider-auth-alert.test.ts`

**Interfaces:**
- Consumes: `ProviderStatusResponse`, `WorkspaceUiState.dismissedProviderAuthFailures`
- Produces: `ProviderAuthIncident`
- Produces: `visibleProviderAuthIncidents(status, dismissals): ProviderAuthIncident[]`
- Produces: `mergeProviderAuthDismissals(current, incidents): Partial<Record<ProviderId, string>>`

- [ ] **Step 1: Write the failing pure tests**

Cover canonical ordering, connected-provider coexistence, matching dismissals, stale dismissals,
malformed stored maps, and merge behavior:

```ts
it('lists every undismissed incident in catalog order even when Codex is connected', () => {
  const status: ProviderStatusResponse = {
    providers: [
      { provider: 'opencode', status: 'disconnected', authFailureId: 'open-1' },
      { provider: 'codex', status: 'connected' },
      { provider: 'claude', status: 'disconnected', authFailureId: 'claude-1' },
    ],
  }

  expect(visibleProviderAuthIncidents(status, {})).toEqual([
    { provider: 'claude', label: 'Claude Code', authFailureId: 'claude-1' },
    { provider: 'opencode', label: 'OpenCode', authFailureId: 'open-1' },
  ])
})

it('hides only the matching incident and resurfaces a different id', () => {
  expect(visibleProviderAuthIncidents(STATUS, { claude: 'claude-1' })).toEqual([])
  expect(visibleProviderAuthIncidents(NEW_STATUS, { claude: 'claude-1' })).toEqual([
    { provider: 'claude', label: 'Claude Code', authFailureId: 'claude-2' },
  ])
})
```

- [ ] **Step 2: Run the pure tests and verify RED**

Run:

```bash
npm test -- web/app/src/lib/provider-auth-alert.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the focused pure module**

Use one closed label map and canonical order:

```ts
import type {
  ProviderId,
  ProviderStatusResponse,
  WorkspaceUiState,
} from '@/api/types'

const PROVIDERS: readonly ProviderId[] = ['claude', 'codex', 'opencode']
const LABELS: Record<ProviderId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
}

export interface ProviderAuthIncident {
  provider: ProviderId
  label: string
  authFailureId: string
}

export type ProviderAuthDismissals = NonNullable<
  WorkspaceUiState['dismissedProviderAuthFailures']
>

export function providerAuthDismissals(value: unknown): ProviderAuthDismissals {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const record = value as Record<string, unknown>
  const dismissals: ProviderAuthDismissals = {}
  for (const provider of PROVIDERS) {
    const id = record[provider]
    if (typeof id === 'string' && id.length > 0 && id.length <= 128) {
      dismissals[provider] = id
    }
  }
  return dismissals
}

export function visibleProviderAuthIncidents(
  status: ProviderStatusResponse | undefined,
  dismissals: ProviderAuthDismissals,
): ProviderAuthIncident[] {
  if (!status) return []
  const rows = new Map(status.providers.map((row) => [row.provider, row]))
  return PROVIDERS.flatMap((provider) => {
    const row = rows.get(provider)
    if (
      row?.status !== 'disconnected'
      || !row.authFailureId
      || dismissals[provider] === row.authFailureId
    ) return []
    return [{
      provider,
      label: LABELS[provider],
      authFailureId: row.authFailureId,
    }]
  })
}

export function mergeProviderAuthDismissals(
  current: ProviderAuthDismissals,
  incidents: readonly ProviderAuthIncident[],
): ProviderAuthDismissals {
  return {
    ...current,
    ...Object.fromEntries(incidents.map(({ provider, authFailureId }) => [
      provider,
      authFailureId,
    ])),
  }
}
```

- [ ] **Step 4: Run the pure tests and typecheck**

Run:

```bash
npm test -- web/app/src/lib/provider-auth-alert.test.ts
npm run typecheck
```

Expected: all pure tests pass and both TypeScript projects report no errors.

- [ ] **Step 5: Commit the pure alert derivation**

```bash
git add web/app/src/lib/provider-auth-alert.ts web/app/src/lib/provider-auth-alert.test.ts
git commit -m "feat: derive provider auth alerts"
```

---

### Task 4: Render and Persist the App-wide Dismissible Alert

**Files:**
- Modify: `web/app/src/components/provider-banner.tsx`
- Test: `web/app/src/components/provider-banner.test.tsx`
- Create: `web/app/src/components/provider-banner-container.tsx`
- Create: `web/app/src/components/provider-banner-container.test.tsx`
- Modify: `web/app/src/components/app-shell-container.tsx:1-125`
- Test: `web/app/src/components/app-shell-container.test.tsx:270-330`

**Interfaces:**
- Consumes: Task 3's `ProviderAuthIncident`, `providerAuthDismissals()`,
  `visibleProviderAuthIncidents()`, and `mergeProviderAuthDismissals()`
- Produces: `ProviderBannerContainer`
- Preserves: existing generic `ProviderBanner` messages and settings link

- [ ] **Step 1: Write failing presentational banner tests**

Add a helper with `dismissals={}` and `onDismissAuthFailures={vi.fn()}`. Require:

```ts
it('shows every runtime incident even while another provider is connected', () => {
  const onDismiss = vi.fn()
  renderBanner({
    status: {
      providers: [
        { provider: 'claude', status: 'disconnected', authFailureId: 'claude-1' },
        { provider: 'codex', status: 'connected' },
        { provider: 'opencode', status: 'disconnected', authFailureId: 'open-1' },
      ],
    },
    onDismissAuthFailures: onDismiss,
  })

  const alert = screen.getByRole('alert')
  expect(alert.textContent).toContain(
    'Provider authentication failed during a task: Claude Code, OpenCode.',
  )
  fireEvent.click(screen.getByRole('button', {
    name: 'Dismiss provider authentication alert',
  }))
  expect(onDismiss).toHaveBeenCalledWith([
    { provider: 'claude', label: 'Claude Code', authFailureId: 'claude-1' },
    { provider: 'opencode', label: 'OpenCode', authFailureId: 'open-1' },
  ])
})
```

Also assert a matching dismissal hides the runtime alert, a newer ID resurfaces it, the link remains
project-aware, and dismissing the runtime variant reveals the generic safety banner when no
providers are connected.

- [ ] **Step 2: Write failing container persistence tests**

Mount `ProviderBannerContainer` in `QueryClientProvider` and `MemoryRouter`, seed the provider and
workspace UI-state query caches, click dismiss, and assert:

```ts
expect(client.getQueryData<WorkspaceUiState>(workspaceQueryKeys.uiState))
  .toMatchObject({
    dismissedProviderAuthFailures: {
      claude: 'claude-1',
      opencode: 'open-1',
    },
  })
expect(fetchMock).toHaveBeenCalledWith(
  '/api/workspace/ui-state',
  expect.objectContaining({
    method: 'PUT',
    body: JSON.stringify({
      dismissedProviderAuthFailures: {
        claude: 'claude-1',
        opencode: 'open-1',
      },
    }),
  }),
)
```

Unmount and remount with the persisted response to prove the runtime alert stays hidden. Add a
500-response test that restores the previous cache, renders the alert again, and shows the server
error in the existing danger toaster.

- [ ] **Step 3: Run component tests and verify RED**

Run:

```bash
npm test -- web/app/src/components/provider-banner.test.tsx web/app/src/components/provider-banner-container.test.tsx web/app/src/components/app-shell-container.test.tsx
```

Expected: FAIL because the runtime variant and container do not exist.

- [ ] **Step 4: Implement the runtime banner variant**

Extend the presentational props:

```ts
interface ProviderBannerProps {
  status: ProviderStatusResponse | undefined
  pending: boolean
  error: boolean
  dismissals: ProviderAuthDismissals
  onDismissAuthFailures: (incidents: readonly ProviderAuthIncident[]) => void
}
```

After parsing status, derive incidents before checking connected providers. Render runtime incidents
with:

```tsx
<div
  data-slot="provider-banner"
  role="alert"
  className="flex min-h-9 items-center gap-2 border-b border-border bg-destructive/10 px-4 text-sm text-foreground"
>
  <StatusDot tone="danger" />
  <span>
    Provider authentication failed during a task: {incidents.map(({ label }) => label).join(', ')}.
  </span>
  <Link
    to="/settings/agents#providers"
    className="ml-auto shrink-0 font-medium underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
  >
    Open agent settings
  </Link>
  <button
    type="button"
    aria-label="Dismiss provider authentication alert"
    onClick={() => onDismissAuthFailures(incidents)}
    className="shrink-0 rounded-sm p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
  >
    <XIcon className="size-4" aria-hidden="true" />
  </button>
</div>
```

Keep the existing `role="status"` generic branch unchanged except for its position after runtime
incident derivation.

- [ ] **Step 5: Implement serialized optimistic dismissal persistence**

Create `ProviderBannerContainer`. It reads `useProviderStatus()` and `useWorkspaceUiState()`, then
uses `useQueryClient()`, a resolved `writeChain` ref, and a monotonically increasing `latestWrite`
ref. The dismiss callback must:

```ts
const dismiss = useCallback((incidents: readonly ProviderAuthIncident[]) => {
  const key = workspaceQueryKeys.uiState
  const previous = queryClient.getQueryData<WorkspaceUiState>(key)
  const currentDismissals = providerAuthDismissals(
    previous?.dismissedProviderAuthFailures,
  )
  const nextDismissals = mergeProviderAuthDismissals(currentDismissals, incidents)
  const optimistic = {
    ...previous,
    dismissedProviderAuthFailures: nextDismissals,
  }
  queryClient.setQueryData(key, optimistic)

  const seq = ++latestWrite.current
  writeChain.current = writeChain.current.then(async () => {
    try {
      const merged = await putWorkspaceUiState({
        dismissedProviderAuthFailures: nextDismissals,
      })
      if (seq === latestWrite.current) queryClient.setQueryData(key, merged)
    } catch (error: unknown) {
      if (seq === latestWrite.current) {
        if (previous === undefined) {
          queryClient.removeQueries({ queryKey: key, exact: true })
        } else {
          queryClient.setQueryData(key, previous)
        }
        void queryClient.invalidateQueries({ queryKey: key })
        toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
      }
    }
  })
}, [queryClient])
```

Treat unavailable or malformed UI state as `{}` so an authentication incident stays visible. Render
the presentational banner with the provider query state, normalized dismissals, and this callback.

- [ ] **Step 6: Mount the focused container in the app shell**

Remove `useProviderStatus()` from `AppShellContainer`, import `ProviderBannerContainer`, and set:

```tsx
banner={<ProviderBannerContainer />}
```

Update the app-shell integration fixture to answer `GET /api/workspace/ui-state` with `{}`. Add a
runtime incident response where Codex is connected and assert the global banner slot contains
`screen.getByRole('alert')`.

- [ ] **Step 7: Run component, client, and stream tests**

Run:

```bash
npm test -- web/app/src/components/provider-banner.test.tsx web/app/src/components/provider-banner-container.test.tsx web/app/src/components/app-shell-container.test.tsx web/app/src/lib/provider-auth-alert.test.ts web/app/src/api/global-events.test.tsx
npm run typecheck
```

Expected: all selected tests pass and both TypeScript projects report no errors.

- [ ] **Step 8: Commit the app-wide alert**

```bash
git add web/app/src/components/provider-banner.tsx web/app/src/components/provider-banner.test.tsx web/app/src/components/provider-banner-container.tsx web/app/src/components/provider-banner-container.test.tsx web/app/src/components/app-shell-container.tsx web/app/src/components/app-shell-container.test.tsx
git commit -m "feat: show dismissible provider auth alerts"
```

---

### Task 5: Update the Feature Record and Verify the Complete Behavior

**Files:**
- Modify: `.ai/specs/2026-07-22-provider-authentication.md:119-145, 228-245`
- Verify: all files changed in Tasks 1-4

**Interfaces:**
- Documents: `ProviderStatus.authFailureId`
- Documents: workspace dismissal map and banner precedence
- Verifies: the complete server-to-Browser behavior

- [ ] **Step 1: Update the provider-authentication feature spec**

Record these exact contract points:

```md
A runtime-latched provider row includes an opaque `authFailureId`. The identifier stays stable for
that latch, is removed by successful explicit recovery, and changes if a later runtime rejection
creates a new latch. It contains no vendor output or credential data.

The global banner first renders every undismissed runtime-authentication incident, even when another
provider is connected. Dismissals are provider-to-incident mappings in workspace UI state and never
change provider status. When no runtime incident remains visible, the existing zero-connected
provider banner rules apply.
```

- [ ] **Step 2: Run focused regression tests**

Run:

```bash
npm test -- src/core/provider-auth.test.ts src/server/provider-auth-runtime.test.ts src/server/providers-api.test.ts src/server/workspace-api.test.ts src/server/api-types.test.ts web/app/src/lib/provider-status.test.ts web/app/src/lib/provider-auth-alert.test.ts web/app/src/api/client.test.ts web/app/src/api/global-events.test.tsx web/app/src/components/provider-banner.test.tsx web/app/src/components/provider-banner-container.test.tsx web/app/src/components/app-shell-container.test.tsx src/core/claude-ui-mapper.test.ts
```

Expected: every selected test passes, including the real Claude Code `is_error` envelope regression.

- [ ] **Step 3: Run repository validation in mandated order**

Run:

```bash
npm run typecheck
npm test
npm run test:unit
npm run build
npm run test:package
```

Expected: typecheck, unit, build, and package gates pass. If the full Vitest suite repeats the known
watcher timing, OpenCode mock-session, or macOS sandbox failures, record their exact test names and
counts; do not report the suite as passing.

- [ ] **Step 4: Start dev mode and reproduce the real revoked-token flow**

Run:

```bash
BROWSER=none npm run dev
```

Using the `browser:control-in-app-browser` skill:

1. Open the local Vite URL.
2. Confirm the provider banner is absent while Claude and Codex appear connected.
3. Start a Claude Code task that reaches the real revoked OAuth token.
4. Confirm an app-wide `role="alert"` appears immediately and names Claude Code while Codex remains
   connected.
5. Follow **Open agent settings** and confirm it lands on Settings → Agents → Providers with Claude
   marked **Not connected**.
6. Return to any project route, dismiss the alert, and reload.
7. Confirm the runtime alert remains dismissed while Claude stays **Not connected**.
8. Delete the disposable QA run and stop the dev server.

- [ ] **Step 5: Inspect the final diff**

Run:

```bash
git diff --check
git status --short
git log -5 --oneline
```

Expected: no whitespace errors and only the intended feature documentation remains uncommitted.

- [ ] **Step 6: Commit the feature-record update**

```bash
git add .ai/specs/2026-07-22-provider-authentication.md
git commit -m "docs: record provider auth alert behavior"
```

- [ ] **Step 7: Recheck the committed worktree**

Run:

```bash
git status --short --branch
```

Expected: `## codex/provider-auth-setup` with no modified or untracked files.
