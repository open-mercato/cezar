# Provider Authentication Discovery and Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect Claude Code, Codex, and OpenCode credentials through their own CLIs, guide users through login from Settings → Agents, and prevent disconnected providers from being offered by interactive run-start surfaces.

**Architecture:** Add one host-wide `ProviderAuthService` that owns vendor commands, parsers, timeouts, cache, and login-command rendering. Expose it through same-origin workspace routes at `/api/providers/status` and `/api/providers/connect`; mirror the response in the web API client and a 30-second TanStack Query. Settings renders connection cards, AppShell renders the approved compact banner, and task surfaces derive runnable providers from this status rather than changing installation-oriented `/api/health` checks.

**Tech Stack:** TypeScript ESM, Node 20 `child_process.execFile`, Hono, Zod, React 19, TanStack Query, React Router, Tailwind v4/shadcn UI, Vitest, Testing Library, in-app Browser.

## Global Constraints

- Work only on `codex/provider-auth-setup`; do not commit feature work to `main`.
- Treat `.ai/specs/2026-07-22-provider-authentication.md` as the approved behavior contract.
- Do not change `/api/health`, `BackendCheck.available`, or `availableRunners()`; those remain installation/legacy compatibility surfaces.
- Never read credential files, keychains, environment-secret values, tokens, account identifiers, or return/log raw CLI output.
- Add no config key, state file, migration, daemon, port, or environment variable. Continue honoring `CEZ_CODEX_BIN`, `CEZ_OPENCODE_BIN`, and `CEZ_DRY_RUN`.
- Keep provider routes workspace-level and same-origin. They must not be mounted under `/api/p/:projectId`.
- Validate the connect body with Zod before selecting a server-owned provider descriptor. Request text must never become a command.
- Provider probe failures are per-row degradation, not route failures. A healthy route always returns all three rows in `claude`, `codex`, `opencode` order.
- The normal client poll interval is 30 seconds. An explicit “Check again” uses `?refresh=1` and bypasses only the completed-result cache, not an in-flight probe.
- `CEZ_DRY_RUN=1` must report all providers connected without spawning vendor CLIs.
- Preserve unrelated user changes. Use `apply_patch` for source edits.
- At every task boundary: run the named focused test, inspect `git diff --check`, then commit only the files named by that task.

---

### Task 1: Add the provider-authentication core seam

**Files:**

- Create: `src/core/provider-auth.ts`
- Create: `src/core/provider-auth.test.ts`

- [ ] **Step 1: Write parser and service tests before implementation**

Create `src/core/provider-auth.test.ts` with a deterministic injected command runner and fake clock. The suite must cover these exact contracts:

```ts
describe('provider auth parsers', () => {
  it('accepts only Claude JSON with loggedIn true as connected')
  it('maps Claude loggedIn false, including exit 1 JSON, to disconnected')
  it('treats malformed Claude JSON as unknown')
  it.each([
    'Logged in using ChatGPT',
    'Logged in using an API key',
  ])('recognizes Codex connected output: %s')
  it.each([
    'Not logged in',
    'Run codex login to authenticate',
  ])('recognizes Codex disconnected output: %s')
  it('does not guess from unrecognized Codex output')
  it('recognizes an OpenCode credential row as connected')
  it('recognizes OpenCode explicit empty/no-credentials output as disconnected')
  it('does not guess from an OpenCode error or future output')
})

describe('ProviderAuthService', () => {
  it('always returns claude, codex, opencode in descriptor order')
  it('runs the three status commands concurrently with a 10 second timeout')
  it('maps an ENOENT command failure to not-installed')
  it.each(['ETIMEDOUT', 'EACCES'])('maps %s to unknown without exposing raw output')
  it('reuses a completed result for five seconds')
  it('refresh bypasses a completed cache entry')
  it('coalesces ordinary and refresh callers while a probe is in flight')
  it('uses CEZ_CODEX_BIN and CEZ_OPENCODE_BIN for both probe and login commands')
  it('reports all three providers connected in CEZ_DRY_RUN without executing a command')
})
```

Use a runner result that retains exit status without throwing so non-zero vendor status answers can still be parsed:

```ts
export interface ProviderCommandResult {
  stdout: string
  stderr: string
  exitCode: number | null
  errorCode?: string
  timedOut?: boolean
}

export type RunProviderCommand = (
  executable: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<ProviderCommandResult>
```

Assert that returned `hint` text contains no sentinel secret placed in fake stdout/stderr.

- [ ] **Step 2: Run the focused test and confirm the red state**

Run:

```bash
npm test -- src/core/provider-auth.test.ts
```

Expected: FAIL because `src/core/provider-auth.ts` does not exist.

- [ ] **Step 3: Implement the public model and immutable descriptors**

Create `src/core/provider-auth.ts` with these public types and constants:

```ts
import { execFile } from 'node:child_process'

export const PROVIDER_IDS = ['claude', 'codex', 'opencode'] as const
export type ProviderId = (typeof PROVIDER_IDS)[number]
export type ProviderConnectionState =
  | 'connected'
  | 'disconnected'
  | 'not-installed'
  | 'unknown'

export interface ProviderStatus {
  provider: ProviderId
  status: ProviderConnectionState
  hint?: string
}

export interface ProviderStatusResponse {
  providers: ProviderStatus[]
}

export interface ProviderCommandResult {
  stdout: string
  stderr: string
  exitCode: number | null
  errorCode?: string
  timedOut?: boolean
}

export type RunProviderCommand = (
  executable: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<ProviderCommandResult>
```

Keep the descriptor table private and closed:

```ts
interface ProviderDescriptor {
  id: ProviderId
  executable: () => string
  statusArgs: readonly string[]
  loginArgs: readonly string[]
  installHint: string
  parse: (result: ProviderCommandResult) => ProviderConnectionState | null
}

const DESCRIPTORS: readonly ProviderDescriptor[] = [
  {
    id: 'claude',
    executable: () => 'claude',
    statusArgs: ['auth', 'status', '--json'],
    loginArgs: ['auth', 'login'],
    installHint: 'Install Claude Code, then run `claude auth login`.',
    parse: parseClaudeStatus,
  },
  {
    id: 'codex',
    executable: () => process.env.CEZ_CODEX_BIN ?? 'codex',
    statusArgs: ['login', 'status'],
    loginArgs: ['login'],
    installHint: 'Install the Codex CLI, then run `codex login`.',
    parse: parseCodexStatus,
  },
  {
    id: 'opencode',
    executable: () => process.env.CEZ_OPENCODE_BIN ?? 'opencode',
    statusArgs: ['auth', 'list'],
    loginArgs: ['auth', 'login'],
    installHint: 'Install OpenCode, then run `opencode auth login`.',
    parse: parseOpenCodeStatus,
  },
]
```

Export neither raw output nor descriptors. Export only service behavior and the coarse model.

- [ ] **Step 4: Implement bounded command execution and conservative parsers**

Wrap callback-style `execFile` so every completion, including a non-zero exit, becomes `ProviderCommandResult`. Pass `{ timeout: timeoutMs, windowsHide: true, maxBuffer: 256 * 1024 }`. Normalize thrown values only into `exitCode`, `errorCode`, and `timedOut`; do not log them.

Implement parsers with these rules:

```ts
function parseClaudeStatus(result: ProviderCommandResult): ProviderConnectionState | null {
  try {
    const value = JSON.parse(result.stdout) as { loggedIn?: unknown }
    return value.loggedIn === true
      ? 'connected'
      : value.loggedIn === false
        ? 'disconnected'
        : null
  } catch {
    return null
  }
}
```

For Codex and OpenCode, strip ANSI sequences, lowercase once, and match only the positive and negative fixtures in the test. Never treat an arbitrary exit `0` as connected. Return `null` for unrecognized output so the caller maps it to `unknown`.

- [ ] **Step 5: Implement cache, in-flight coalescing, dry-run behavior, and login commands**

Expose one constructible service so API tests can inject it without module mocking:

```ts
export class ProviderAuthService {
  constructor(options?: {
    runCommand?: RunProviderCommand
    now?: () => number
    platform?: NodeJS.Platform
  })

  status(options?: { refresh?: boolean }): Promise<ProviderStatusResponse>
  loginCommand(provider: ProviderId): string
  installHint(provider: ProviderId): string
}
```

`status()` must follow this order:

1. If `CEZ_DRY_RUN === '1'`, return the three connected mock rows immediately.
2. If a probe promise exists, return it even for `refresh: true`.
3. If `refresh !== true` and the completed cache age is below `5_000`, return the cache.
4. Set one `inFlight = Promise.all(DESCRIPTORS.map(probe))`.
5. Save the completed result and timestamp only on success; clear `inFlight` in `finally`.

Each probe maps:

```ts
if (result.errorCode === 'ENOENT') return { provider: id, status: 'not-installed', hint: installHint }
if (result.timedOut) return { provider: id, status: 'unknown', hint: 'Authentication check timed out. Try again.' }
const parsed = descriptor.parse(result)
if (parsed !== null) return { provider: id, status: parsed }
return { provider: id, status: 'unknown', hint: 'Authentication could not be verified. Try again.' }
```

Render the login command from the descriptor-selected executable and fixed arguments. Quote the executable as a single shell word, using the injected `platform` only to make POSIX and Windows rendering deterministic in tests. Cover paths containing spaces and quote characters on both branches; add Windows metacharacter cases for `%`, `&`, and `!`. Do not concatenate request input. Keep the returned command human-copyable, e.g. `'codex' login` on POSIX.

- [ ] **Step 6: Run core tests and quality checks**

Run:

```bash
npm test -- src/core/provider-auth.test.ts
npm run typecheck:server
git diff --check
```

Expected: all pass.

- [ ] **Step 7: Commit the core seam**

```bash
git add src/core/provider-auth.ts src/core/provider-auth.test.ts
git commit -m "feat: detect agent provider authentication"
```

---

### Task 2: Add workspace provider status and connect APIs

**Files:**

- Modify: `src/server/server.ts`
- Create: `src/server/providers-api.test.ts`

- [ ] **Step 1: Write route tests with injected provider and terminal adapters**

Add `src/server/providers-api.test.ts` using the same temp-root/`RunStore` pattern as `src/server/models-api.test.ts`. Inject a real `ProviderAuthService` with a fake runner, and inject terminal opening through a new optional `ServerDeps.openTerminal` dependency that defaults to `openInTerminal`.

Cover:

```ts
describe('workspace provider API', () => {
  it('GET /api/providers/status returns all provider rows')
  it('GET ?refresh=1 bypasses the completed provider cache')
  it('GET without refresh reuses the completed provider cache')
  it('is workspace-level rather than project-scoped')
  it('does not add provider fields or calls to /api/health')

  it('POST opens the fixed login command for a disconnected provider')
  it('POST returns opened false and does not open a terminal when already connected')
  it('POST returns 409 plus install guidance when not installed')
  it('POST returns 409 plus retry guidance when status is unknown')
  it('POST returns 409 plus command when localHandoff is false')
  it('POST returns 409 plus command when the terminal launcher returns false')
  it.each([{}, { provider: 'other' }, { provider: 1 }])('rejects invalid body %# with 400')
  it('never places request-controlled text in the opened command')
})
```

Assert `/api/p/default/providers/status` and `/api/p/default/providers/connect` are 404. For hosted mode, create the app with `bindHost: '0.0.0.0'` and assert the terminal spy has no calls.

- [ ] **Step 2: Run the route test and confirm the red state**

```bash
npm test -- src/server/providers-api.test.ts
```

Expected: FAIL with missing routes and dependencies.

- [ ] **Step 3: Add injectable server dependencies**

In `src/server/server.ts`:

```ts
import {
  PROVIDER_IDS,
  ProviderAuthService,
  type ProviderId,
} from '../core/provider-auth.js'
```

Extend `ServerDeps`:

```ts
/** Host-wide provider authentication discovery. Tests inject deterministic probes. */
providerAuth?: ProviderAuthService
/** Local terminal handoff for provider-owned login. */
openTerminal?: typeof openInTerminal
```

Inside `createApp`, construct exactly one service per app and bind the terminal adapter:

```ts
const providerAuth = deps.providerAuth ?? new ProviderAuthService()
const openTerminal = deps.openTerminal ?? openInTerminal
```

- [ ] **Step 4: Register the GET route next to `/api/models`, not `/api/health`**

Add the workspace route immediately after `/api/models`:

```ts
app.get('/api/providers/status', async (c) => {
  const query = z.object({ refresh: z.literal('1').optional() }).safeParse(c.req.query())
  if (!query.success) return c.json({ error: 'refresh must be 1 when provided' }, 400)
  return c.json(await providerAuth.status({ refresh: query.data.refresh === '1' }))
})
```

This route must not use the project route table and must not gain CORS middleware.

- [ ] **Step 5: Register the validated connect route**

Define once:

```ts
const providerConnectSchema = z.object({
  provider: z.enum(PROVIDER_IDS),
}).strict()
```

The route flow is:

```ts
app.post('/api/providers/connect', async (c) => {
  const body = providerConnectSchema.safeParse(await c.req.json().catch(() => null))
  if (!body.success) return c.json({ error: 'provider must be claude, codex, or opencode' }, 400)

  const provider = body.data.provider as ProviderId
  const command = providerAuth.loginCommand(provider)
  const row = (await providerAuth.status({ refresh: true })).providers.find(
    (candidate) => candidate.provider === provider,
  )!

  if (row.status === 'connected') {
    return c.json({ opened: false, connected: true, command })
  }
  if (row.status === 'not-installed') {
    return c.json({ error: row.hint ?? providerAuth.installHint(provider), command }, 409)
  }
  if (row.status === 'unknown') {
    return c.json({ error: row.hint ?? 'Authentication could not be verified. Try again.', command }, 409)
  }
  if (!capabilities().localHandoff) {
    return c.json({ error: 'Run this command on the machine hosting cezar.', command }, 409)
  }
  if (!(await openTerminal(bootRoot, command))) {
    return c.json({ error: 'No terminal emulator could be opened. Run this command manually.', command }, 409)
  }
  return c.json({ opened: true, command })
})
```

Do not include the probe output in any error path.

- [ ] **Step 6: Run route, origin-guard, parity, and health regression tests**

```bash
npm test -- src/server/providers-api.test.ts src/server/request-origin-guard.test.ts src/server/route-parity.test.ts src/server/health-forge.test.ts
npm run typecheck:server
git diff --check
```

Expected: all pass; route parity ignores these workspace routes because they are not in the scoped manifest.

- [ ] **Step 7: Commit the workspace API**

```bash
git add src/server/server.ts src/server/providers-api.test.ts
git commit -m "feat: expose provider authentication API"
```

---

### Task 3: Add the browser API model, workspace query, and runnable-provider helper

**Files:**

- Modify: `web/app/src/api/types.ts`
- Modify: `src/server/api-types.test.ts`
- Modify: `web/app/src/api/client.ts`
- Modify: `web/app/src/api/client.test.ts`
- Modify: `web/app/src/api/queries.ts`
- Modify: `web/app/src/api/queries.test.tsx`
- Modify: `web/app/src/api/project-scope.ts`
- Modify: `web/app/src/api/project-scope.test.ts`
- Create: `web/app/src/lib/provider-status.ts`
- Create: `web/app/src/lib/provider-status.test.ts`

- [ ] **Step 1: Add failing client and helper tests**

Add assertions for:

```ts
expect(getProviderStatus()).toFetch('GET', '/api/providers/status')
expect(getProviderStatus(true)).toFetch('GET', '/api/providers/status?refresh=1')
expect(connectProvider('codex')).toFetch('POST', '/api/providers/connect', { provider: 'codex' })
```

Add query-hook tests that prove:

- the initial request uses `/api/providers/status`;
- the query key is exactly `['workspace', 'providers', 'status']` regardless of active project;
- fake time at `29_999` ms causes no second fetch and `30_000` ms does;
- window focus triggers a refetch;
- the query exposes an `ApiError` for a route-level failure rather than synthesizing disconnected rows.

Add project-scope assertions for both provider endpoints, including `?refresh=1`, while a non-boot project is active.

Create helper tests:

```ts
describe('connectedRunners', () => {
  it('returns only connected providers in canonical order')
  it('returns [] for undefined/pending status')
  it('does not fall back to claude when none is connected')
  it('excludes disconnected, not-installed, and unknown rows')
})

describe('providerStatusFor', () => {
  it('returns the matching provider row')
  it('returns undefined while data is unavailable')
})
```

- [ ] **Step 2: Run focused browser-unit tests and confirm failure**

```bash
npm test -- web/app/src/api/client.test.ts web/app/src/api/queries.test.tsx web/app/src/api/project-scope.test.ts web/app/src/lib/provider-status.test.ts
```

Expected: FAIL because the types, functions, key, and helper are missing.

- [ ] **Step 3: Mirror provider API types and pin them to the server**

In `web/app/src/api/types.ts` add:

```ts
export type ProviderId = Runner
export type ProviderConnectionState =
  | 'connected'
  | 'disconnected'
  | 'not-installed'
  | 'unknown'

export interface ProviderStatus {
  provider: ProviderId
  status: ProviderConnectionState
  hint?: string
}

export interface ProviderStatusResponse {
  providers: ProviderStatus[]
}

export type ProviderConnectResponse =
  | { opened: true; command: string }
  | { opened: false; connected: true; command: string }
```

In `src/server/api-types.test.ts`, import the server and web provider types and add both `Exact` and `ExactKeys` guards for `ProviderStatus` and `ProviderStatusResponse`.

- [ ] **Step 4: Add client methods and workspace routing exemption**

In `web/app/src/api/client.ts`:

```ts
export function getProviderStatus(
  refresh = false,
  opts?: ReadOptions,
): Promise<ProviderStatusResponse> {
  return get<ProviderStatusResponse>(
    `/api/providers/status${refresh ? '?refresh=1' : ''}`,
    opts,
  )
}

export function connectProvider(provider: ProviderId): Promise<ProviderConnectResponse> {
  return mutate<ProviderConnectResponse>('POST', '/api/providers/connect', { provider })
}
```

In `web/app/src/api/project-scope.ts`, extend `WORKSPACE_LEVEL` with `providers(?:$|[/?])`. Update its comment to name `/api/providers/*` as host credential state shared across projects.

- [ ] **Step 5: Add the 30-second query and explicit refresh mutation**

In `web/app/src/api/queries.ts` add:

```ts
providerStatus: ['workspace', 'providers', 'status'] as const,
```

and:

```ts
export function useProviderStatus() {
  return useQuery({
    queryKey: workspaceQueryKeys.providerStatus,
    queryFn: ({ signal }) => getProviderStatus(false, { signal }),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  })
}

export function useRefreshProviderStatus() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => getProviderStatus(true),
    onSuccess: (result) => queryClient.setQueryData(workspaceQueryKeys.providerStatus, result),
  })
}
```

The connect component will use `connectProvider` directly through its own mutation and invalidate this key on success/error as appropriate; do not hide command-carrying 409s inside a generic hook.

- [ ] **Step 6: Add the pure runnable-provider helper**

Create `web/app/src/lib/provider-status.ts`:

```ts
import type { ProviderStatus, ProviderStatusResponse, Runner } from '@/api/types'

const RUNNER_ORDER: readonly Runner[] = ['claude', 'codex', 'opencode']

export function connectedRunners(status: ProviderStatusResponse | undefined): Runner[] {
  if (!status) return []
  const connected = new Set(
    status.providers
      .filter((row) => row.status === 'connected')
      .map((row) => row.provider),
  )
  return RUNNER_ORDER.filter((runner) => connected.has(runner))
}

export function providerStatusFor(
  status: ProviderStatusResponse | undefined,
  provider: Runner,
): ProviderStatus | undefined {
  return status?.providers.find((row) => row.provider === provider)
}
```

- [ ] **Step 7: Run focused tests, both typechecks, and diff checks**

```bash
npm test -- web/app/src/api/client.test.ts web/app/src/api/queries.test.tsx web/app/src/api/project-scope.test.ts web/app/src/lib/provider-status.test.ts src/server/api-types.test.ts
npm run typecheck
git diff --check
```

Expected: all pass.

- [ ] **Step 8: Commit the client seam**

```bash
git add web/app/src/api/types.ts src/server/api-types.test.ts web/app/src/api/client.ts web/app/src/api/client.test.ts web/app/src/api/queries.ts web/app/src/api/queries.test.tsx web/app/src/api/project-scope.ts web/app/src/api/project-scope.test.ts web/app/src/lib/provider-status.ts web/app/src/lib/provider-status.test.ts
git commit -m "feat: add provider status client"
```

---

### Task 4: Extend Settings → Agents with provider connection cards

**Files:**

- Create: `web/app/src/routes/settings/provider-settings.tsx`
- Create: `web/app/src/routes/settings/provider-settings.test.tsx`
- Modify: `web/app/src/routes/settings/agents-section.tsx`
- Modify: `web/app/src/routes/settings/agents-section.test.tsx`

- [ ] **Step 1: Write card and settings-control tests first**

In `provider-settings.test.tsx`, render the component under QueryClient and MemoryRouter. Cover:

- three cards always render in Claude Code, Codex, OpenCode order;
- `connected` gets success status and no Connect button;
- `disconnected` gets pending status, Connect, and Check again;
- `not-installed` shows install hint and no Connect;
- `unknown` says verification failed and offers Check again without claiming disconnected;
- Connect POSTs only `{ provider }`, then shows the terminal-flow toast and refreshes status;
- a 409 with `{ error, command }` reveals the exact command and a copy button;
- copy writes exactly the server command to `navigator.clipboard`;
- a route failure renders “Provider status could not be loaded” plus Retry;
- Check again requests `/api/providers/status?refresh=1`.

In `agents-section.test.tsx`, make the fetch stub return connected rows by default and add regressions:

- Providers is the first section and has `id="providers"` plus scroll margin;
- disconnected default runner stays `aria-checked="true"` but its radio is disabled;
- disconnected provider model select is disabled;
- connected provider radio/model controls remain enabled;
- pending/error provider status disables provider-specific runner/model controls without disabling unrelated settings.

- [ ] **Step 2: Run the focused settings tests and confirm failure**

```bash
npm test -- web/app/src/routes/settings/provider-settings.test.tsx web/app/src/routes/settings/agents-section.test.tsx
```

Expected: FAIL because provider controls do not exist.

- [ ] **Step 3: Implement the provider cards**

Create `ProviderSettings` with `useProviderStatus`, `useRefreshProviderStatus`, `connectProvider`, `ApiError`, `StatusDot`, `Button`, `toast`, and `useQueryClient`.

Use a fixed presentation table:

```ts
const PROVIDERS = [
  { id: 'claude', label: 'Claude Code', login: 'claude auth login' },
  { id: 'codex', label: 'Codex', login: 'codex login' },
  { id: 'opencode', label: 'OpenCode', login: 'opencode auth login' },
] as const

const STATUS_PRESENTATION = {
  connected: { label: 'Connected', tone: 'success' },
  disconnected: { label: 'Not connected', tone: 'pending' },
  'not-installed': { label: 'Not installed', tone: 'neutral' },
  unknown: { label: 'Could not verify', tone: 'danger' },
} as const
```

The root must be:

```tsx
<section id="providers" data-slot="provider-settings" className="scroll-mt-6">
```

Connect behavior:

```ts
const connect = useMutation({
  mutationFn: connectProvider,
  onSuccess: async (result) => {
    setManual(null)
    toast(result.opened ? 'Finish signing in in the terminal, then check again.' : 'Provider is already connected.')
    await queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.providerStatus })
  },
  onError: (error: Error) => {
    if (error instanceof ApiError && error.command) {
      setManual({ message: error.message, command: error.command })
      return
    }
    toast(error.message, { tone: 'danger' })
  },
})
```

Use one manual fallback panel immediately below the affected card with `<code>` and a “Copy command” button. Never render account data because none exists in the response model.

- [ ] **Step 4: Mount Providers first and gate provider-specific config controls**

In `AgentsSection`, call `useProviderStatus()` alongside config/catalog. Do not make a provider-status error replace the entire settings page; pass query state into `AgentsForm` and let `ProviderSettings` own its retry UI.

At the top of `AgentsForm` render:

```tsx
<ProviderSettings />
```

For every runner radio and model select derive:

```ts
const providerConnected = providerStatusFor(providerStatus.data, runner.id)?.status === 'connected'
const providerReason = providerStatus.isPending
  ? 'Checking provider authentication…'
  : providerStatus.isError
    ? 'Provider authentication could not be verified.'
    : providerConnected
      ? undefined
      : 'Connect this provider before selecting it.'
```

Set `disabled={save.isPending || !providerConnected}` and `title={providerReason ?? option.desc}`. Do not change `aria-checked`, selected `<option>`, or persisted config; a disconnected saved default must stay visible.

- [ ] **Step 5: Run settings tests, accessibility-oriented assertions, and typecheck**

```bash
npm test -- web/app/src/routes/settings/provider-settings.test.tsx web/app/src/routes/settings/agents-section.test.tsx web/app/src/routes/settings/settings.test.tsx
npm run typecheck:web
git diff --check
```

Expected: all pass.

- [ ] **Step 6: Commit Settings integration**

```bash
git add web/app/src/routes/settings/provider-settings.tsx web/app/src/routes/settings/provider-settings.test.tsx web/app/src/routes/settings/agents-section.tsx web/app/src/routes/settings/agents-section.test.tsx
git commit -m "feat: add provider setup to agent settings"
```

---

### Task 5: Add the approved compact global missing-provider banner

**Files:**

- Create: `web/app/src/components/provider-banner.tsx`
- Create: `web/app/src/components/provider-banner.test.tsx`
- Modify: `web/app/src/components/app-shell-container.tsx`
- Modify: `web/app/src/components/app-shell-container.test.tsx`

- [ ] **Step 1: Write banner decision tests**

The component tests must prove:

```ts
it('renders nothing while provider status is pending')
it('renders nothing when the route itself failed')
it('renders nothing when any provider is connected')
it('says no provider is connected when every row is definitive and none is connected')
it('says no provider could be verified when any row is unknown and none is connected')
it('links to the active project Settings → Agents providers anchor')
it('is non-dismissible and keyboard-accessible')
```

Add AppShellContainer tests verifying the provider query is wired into the existing `banner` slot and the rest of the shell still renders when provider status fails. Update the test `serve()` helper to provide a connected default for `/api/providers/status`, so existing shell tests retain their prior chrome expectation.

- [ ] **Step 2: Run focused tests and confirm failure**

```bash
npm test -- web/app/src/components/provider-banner.test.tsx web/app/src/components/app-shell-container.test.tsx
```

Expected: FAIL because the component and shell query are missing.

- [ ] **Step 3: Implement the pure banner component**

Create a presentational component whose props carry query state explicitly:

```ts
interface ProviderBannerProps {
  status: ProviderStatusResponse | undefined
  pending: boolean
  error: boolean
}
```

Decision logic:

```ts
if (pending || error || !status) return null
if (status.providers.some((row) => row.status === 'connected')) return null
const uncertain = status.providers.some((row) => row.status === 'unknown')
```

Render a compact `role="status"` strip, a `StatusDot` (`danger` for uncertain, `pending` for definitive missing), the approved copy, and a project-aware `Link` imported from `@/lib/project-router`:

```tsx
<Link to="/settings/agents#providers">Configure providers</Link>
```

Do not add a dismiss control or persisted banner state.

- [ ] **Step 4: Wire the banner through AppShellContainer**

Call `useProviderStatus()` once in `AppShellContainer` and pass:

```tsx
banner={
  <ProviderBanner
    status={providers.data}
    pending={providers.isPending}
    error={providers.isError}
  />
}
```

Use the existing generic `AppShell` banner slot; do not modify layout primitives unless a failing visual test proves the slot cannot host the compact strip.

- [ ] **Step 5: Run shell tests and typecheck**

```bash
npm test -- web/app/src/components/provider-banner.test.tsx web/app/src/components/app-shell-container.test.tsx web/app/src/components/app-shell.test.tsx
npm run typecheck:web
git diff --check
```

Expected: all pass.

- [ ] **Step 6: Commit the global notice**

```bash
git add web/app/src/components/provider-banner.tsx web/app/src/components/provider-banner.test.tsx web/app/src/components/app-shell-container.tsx web/app/src/components/app-shell-container.test.tsx
git commit -m "feat: show missing provider banner"
```

---

### Task 6: Gate the new-task composer with connected providers

**Files:**

- Modify: `web/app/src/routes/new-task-form.ts`
- Modify: `web/app/src/routes/new-task-form.test.ts`
- Modify: `web/app/src/routes/new-task-autostart.ts`
- Modify: `web/app/src/routes/new-task-autostart.test.ts`
- Modify: `web/app/src/routes/new-task.tsx`
- Modify: `web/app/src/routes/new-task.test.tsx`

- [ ] **Step 1: Add payload and UI regression tests**

In `new-task-form.test.ts`, change the `buildCreateRunBody` contract from `runnerCount` to `defaultRunner` and prove:

- runner omitted when the chosen connected runner equals the server default;
- runner sent when chosen runner differs from default, even if it is the only connected runner;
- existing model/variants/images/worktree/autonomous/follow-up/todo behavior is unchanged.

Keep existing `availableRunners` tests unchanged; they pin the legacy installation behavior.

In `new-task.test.tsx`, make the fetch stub answer provider status and add:

- pending provider status disables the Composer without showing a missing-provider claim;
- no connected providers disables Start/Plan and offers `/settings/agents#providers`;
- a route error disables submission with verification-failed copy and Retry/setup guidance;
- disconnected providers do not appear in RunnerPill options;
- one connected provider suppresses RunnerPill but still enables submission;
- a disconnected configured default falls back to a connected provider and POSTs that `runner` explicitly;
- any connected provider enables the form even when another row is `unknown`;
- status refresh can enable an already-open form without reload.

For auto-start, prove a valid bookmarklet waits for provider status, uses a connected fallback when the saved default is disconnected, and remains on the disabled prefilled composer when none is connected.

- [ ] **Step 2: Run focused tests and confirm failure**

```bash
npm test -- web/app/src/routes/new-task-form.test.ts web/app/src/routes/new-task-autostart.test.ts web/app/src/routes/new-task.test.tsx
```

Expected: FAIL on the old count rule and health-based runner list.

- [ ] **Step 3: Fix the create-run body omission rule**

Replace `runnerCount: number` with `defaultRunner: Runner` in `buildCreateRunBody` and emit:

```ts
runner: runner === defaultRunner ? undefined : runner,
```

Update every call site, including bookmarklet helpers. `bookmarkletRunBody` must accept the resolved runner/default runner from `NewTaskRoute`; when both match, it still produces the protected legacy shape with no runner field.

- [ ] **Step 4: Resolve runners from provider status in NewTaskRoute**

Replace the use of `availableRunners(health.data?.checks ?? [])` with:

```ts
const providers = useProviderStatus()
const runners = connectedRunners(providers.data)
const defaultRunner = health.data?.defaultRunner ?? 'claude'
const runner = resolveRunner(draft.runner, runners, defaultRunner)
const providersReady = providers.isSuccess && runners.length > 0
```

Do not call `modelsForRunner` with an invented runner while `runners` is empty. Use a harmless display runner only to keep existing hook order/layout stable, but disable every engine control and submission until `providersReady`. Guard `submit`, planned-run start, and valid auto-start before any `createRun` call.

Pass Composer:

```tsx
disabled={!providersReady || starting}
disabledReason={
  providers.isPending
    ? 'Checking agent providers…'
    : providers.isError
      ? 'Provider authentication could not be verified.'
      : 'Connect an agent provider before starting a task.'
}
disabledAction={
  !providers.isPending ? (
    <Link to="/settings/agents#providers">Configure providers</Link>
  ) : undefined
}
```

Disable runner/model pills in the same state. Preserve drafts, deep-link text, and the existing project/workflow controls.

- [ ] **Step 5: Preserve bookmarklet compatibility on connected hosts**

The auto-start effect must wait until provider status is settled. On a connected host its POST payload remains byte-identical when the connected resolved runner equals the server default. When only a fallback is connected, send the explicit fallback runner so the server cannot resolve back to the disconnected default. When no provider is connected, do not POST; retain the prefill and show setup guidance.

- [ ] **Step 6: Run new-task regression suite and typecheck**

```bash
npm test -- web/app/src/routes/new-task-form.test.ts web/app/src/routes/new-task-autostart.test.ts web/app/src/routes/new-task.test.tsx web/app/src/routes/new-task-plan.test.ts
npm run typecheck:web
git diff --check
```

Expected: all pass.

- [ ] **Step 7: Commit new-task gating**

```bash
git add web/app/src/routes/new-task-form.ts web/app/src/routes/new-task-form.test.ts web/app/src/routes/new-task-autostart.ts web/app/src/routes/new-task-autostart.test.ts web/app/src/routes/new-task.tsx web/app/src/routes/new-task.test.tsx
git commit -m "feat: require connected provider for new tasks"
```

---

### Task 7: Gate Inbox, GitHub, engine pills, and follow-up Continue

**Files:**

- Modify: `web/app/src/components/engine-pills.tsx`
- Modify: `web/app/src/components/engine-pills.test.ts`
- Modify: `web/app/src/routes/inbox.tsx`
- Modify: `web/app/src/routes/inbox.test.tsx`
- Modify: `web/app/src/routes/github/hand-to-agent.tsx`
- Modify: `web/app/src/routes/github/github.test.tsx`
- Modify: `web/app/src/routes/task-thread/follow-up-engine.tsx`
- Modify: `web/app/src/routes/task-thread/follow-up-engine.test.tsx`

- [ ] **Step 1: Add connected-provider regressions to every start surface**

Extend `ResolvedEngine` fixtures with `canRun: boolean` and test:

- `useResolvedEngine` derives its runner list from provider status, not health checks;
- `canRun` is false while pending, on route error, and with zero connected providers;
- callers guard `engineBody` and never mutate when `canRun` is false;
- a disconnected configured default resolves to and explicitly sends the connected fallback.

Inbox tests:

- Run disabled with zero connected providers while Dismiss/Acknowledge remains enabled;
- engine pills are disabled and a setup link is visible;
- mutation is not called if a click is forced while unavailable.

GitHub tests:

- “Run agent…” and the shortcut are disabled/no-op with zero connected providers;
- setup link visible; issue/PR browsing remains intact;
- connected fallback runner is in the create body.

Follow-up tests:

- current run provider disconnected + another connected provider selects/sends the fallback even when the user did not touch the pill;
- no connected provider hides/disables Continue and shows setup link;
- a connected current provider preserves the existing untouched `{ runner: undefined, model: undefined }` contract;
- disconnected providers never appear in RunnerPill options.

- [ ] **Step 2: Run focused tests and confirm failure**

```bash
npm test -- web/app/src/components/engine-pills.test.ts web/app/src/routes/inbox.test.tsx web/app/src/routes/github/github.test.tsx web/app/src/routes/task-thread/follow-up-engine.test.tsx
```

Expected: FAIL because these surfaces still consume health installation checks.

- [ ] **Step 3: Switch the shared engine resolver to provider status**

In `engine-pills.tsx`:

```ts
const providers = useProviderStatus()
const runners = connectedRunners(providers.data)
const defaultRunner = health.data?.defaultRunner ?? 'claude'
const canRun = providers.isSuccess && runners.length > 0
const runner = resolveRunner(pick.runner, runners, defaultRunner)
```

Keep `useHealth()` only for `defaultRunner`; remove `availableRunners`. Add to `ResolvedEngine`:

```ts
canRun: boolean
providerPending: boolean
providerError: boolean
```

Disable both pills when `disabled || !canRun`. Render no picker options from disconnected providers.

- [ ] **Step 4: Gate Inbox and GitHub mutation entry points**

For Inbox and GitHub:

- check `if (!resolved.canRun) return` at the start of the mutation function as defense in depth;
- set the Run button disabled when pending or unavailable;
- pass `disabled={!resolved.canRun || existingBusyState}` to `EnginePills`;
- render a project-aware “Configure providers” link beside the disabled controls when provider status is settled and no provider can run;
- do not disable non-agent actions, navigation, text editing, Dismiss, or Acknowledge.

Keep `engineBody`’s compare-with-default rule. Do not add a server-side run preflight.

- [ ] **Step 5: Gate follow-up Continue and preserve session affinity when possible**

Replace `useHealth`/`availableRunners` runner discovery with `useProviderStatus`/`connectedRunners`. Resolve against `currentRunner` as before.

When the current provider is no longer connected, the untouched action must explicitly override it:

```ts
const currentRunnerConnected = runners.includes(currentRunner)

runner:
  pickedRunner !== null || !currentRunnerConnected
    ? runner
    : undefined,
```

If `runners.length === 0`, render a compact setup link in place of the engine controls and do not expose an enabled Continue button. If the status route failed, say authentication could not be verified and offer Settings; do not claim the provider is disconnected.

- [ ] **Step 6: Run all focused task-surface tests and typecheck**

```bash
npm test -- web/app/src/components/engine-pills.test.ts web/app/src/routes/inbox.test.tsx web/app/src/routes/github/github.test.tsx web/app/src/routes/task-thread/follow-up-engine.test.tsx
npm run typecheck:web
git diff --check
```

Expected: all pass.

- [ ] **Step 7: Commit remaining runnable-provider gating**

```bash
git add web/app/src/components/engine-pills.tsx web/app/src/components/engine-pills.test.ts web/app/src/routes/inbox.tsx web/app/src/routes/inbox.test.tsx web/app/src/routes/github/hand-to-agent.tsx web/app/src/routes/github/github.test.tsx web/app/src/routes/task-thread/follow-up-engine.tsx web/app/src/routes/task-thread/follow-up-engine.test.tsx
git commit -m "feat: gate agent actions by provider connection"
```

---

### Task 8: Browser QA with safe CLI shims and full release validation

**Files:**

- Modify only if QA exposes a defect: files from Tasks 1–7 and their matching tests
- Do not commit generated `web/dist`, `.ai/qa`, logs, screenshots, temp credentials, or shim directories

- [ ] **Step 1: Run the fast combined regression set before browser work**

```bash
npm run typecheck
npm test -- src/core/provider-auth.test.ts src/server/providers-api.test.ts web/app/src/api/queries.test.tsx web/app/src/routes/settings/provider-settings.test.tsx web/app/src/components/provider-banner.test.tsx web/app/src/routes/new-task.test.tsx web/app/src/routes/inbox.test.tsx web/app/src/routes/github/github.test.tsx web/app/src/routes/task-thread/follow-up-engine.test.tsx
git diff --check
```

Expected: all pass.

- [ ] **Step 2: Create temporary provider CLI shims without touching real credentials**

Use `mktemp -d` for a shim directory outside the repository and retain its absolute path as `provider_shim_dir`. Create executable `claude`, `codex`, and `opencode` scripts there with `apply_patch`; never invoke the installed real login commands.

The shims must implement:

- `claude auth status --json` → disconnected fixture;
- `codex login status` → connected fixture;
- `opencode auth list` → explicit empty fixture;
- login commands → print a harmless message and exit, with no browser/OAuth action.

Start dev mode with that directory first on PATH and normal provider behavior (not `CEZ_DRY_RUN`, because dry-run intentionally reports everything connected):

```bash
provider_shim_dir="$(mktemp -d)"
PATH="$provider_shim_dir:$PATH" npm run dev
```

Record the actual URL printed by the dev command. Keep the terminal session alive for Browser QA.

- [ ] **Step 3: Use the in-app Browser skill for the mixed-status happy path**

Open the dev URL in the in-app Browser and verify:

1. No global banner appears because Codex is connected.
2. Settings → Agents → Providers shows Claude “Not connected”, Codex “Connected”, OpenCode “Not connected”.
3. The URL hash after following a provider setup link is `#providers` and the section is visible.
4. Default runner and default model controls are enabled only for Codex.
5. New task offers Codex only and Start is enabled.
6. Mobile viewport keeps provider cards, banner slot, buttons, and manual command panel inside the page width.
7. Keyboard Tab reaches Check again, Connect, copy command, and settings links with visible focus.

Capture one screenshot of Settings and one of the new-task composer for review; store them in `.ai/qa` or a temp directory, not git.

- [ ] **Step 4: Exercise the no-provider banner and recovery path**

Change the shim fixtures so all installed providers report disconnected, then wait 30 seconds or use Check again. Verify:

1. The compact non-dismissible global banner appears with “No agent provider is connected.”
2. “Configure providers” navigates straight to Settings → Agents → Providers.
3. New-task, Inbox Run, GitHub Run, and follow-up Continue cannot start an agent.
4. Non-agent actions remain usable.
5. Connect launches only the harmless shim command in a terminal when local handoff is available; if the Browser environment cannot observe the terminal, use the API response and server terminal-adapter test as the authoritative assertion.
6. After changing one shim to connected and clicking Check again, the banner disappears and task submission enables without reload.

- [ ] **Step 5: Exercise unknown and not-installed degradation**

Make one shim print unrecognized output and remove another shim executable. Verify Settings shows “Could not verify” and “Not installed” respectively, while the global copy says “No connected provider could be verified.” Confirm no raw shim output appears anywhere in the UI or server console.

- [ ] **Step 6: Stop dev mode and clean only the temporary test environment**

Stop the dev server normally. Remove the exact `mktemp` shim directory and generated QA state if it is safe and untracked. Do not remove repo/user files or run broad cleanup commands.

- [ ] **Step 7: Run the repository-required validation sequence in order**

Run exactly:

```bash
npm run typecheck
npm test
npm run test:unit
npm run build
npm run test:package
```

Then run the separate smoke suite:

```bash
npm run test:e2e
```

Record whether the marker is `TEST_E2E_STATUS=passed`, `skipped`, or `failed`; skipped is not a pass. If sandbox process restrictions cause `EPERM`, rerun the same command with the required escalation rather than changing tests.

- [ ] **Step 8: Review the final diff for privacy, route placement, and generated files**

```bash
git status --short
git diff --check
git diff --stat origin/main...HEAD
git diff origin/main...HEAD -- src/server/server.ts src/core/provider-auth.ts web/app/src/api/project-scope.ts
```

Confirm:

- no provider status fields landed in `/api/health`;
- no credential path/token/account fields exist;
- no raw stdout/stderr is logged or serialized;
- `/api/providers/*` is workspace-only and project-scope-exempt;
- poll interval is `30_000`, server completed cache is `5_000`, process timeout is `10_000`;
- no generated assets or temporary shims are tracked;
- all commits are on `codex/provider-auth-setup`.

- [ ] **Step 9: Use Superpowers verification and review skills before completion**

Invoke `superpowers:verification-before-completion`, then `superpowers:requesting-code-review`. Resolve any review findings with `superpowers:receiving-code-review` and `superpowers:systematic-debugging` before claiming completion.

- [ ] **Step 10: Commit any QA-driven fixes, otherwise leave the verified branch clean**

If QA required code changes, inspect `git status --short`, stage only the explicit corrected source and matching test paths from Tasks 1–7, then commit them with `git commit -m "fix: harden provider authentication setup"`.

If no fixes were necessary, create no empty commit. Finish with `superpowers:finishing-a-development-branch` and present merge/PR/keep-branch options to the user; never merge automatically.
