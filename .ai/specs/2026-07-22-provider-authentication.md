# Provider authentication discovery and setup

Status: approved in design review · Date: 2026-07-22

## Summary

cezar currently knows whether the Claude Code, Codex, OpenCode, and pi executables are installed,
but it treats an installed CLI as runnable even when that CLI has no usable provider
credentials. The task composer then offers an agent that fails only after a run starts, while
Settings → Agents cannot explain or repair the missing authentication.

This feature adds a same-origin, host-wide provider-status API and extends Settings → Agents
with provider connection cards. cezar asks each vendor CLI for its own authentication status;
it never reads credential files or handles tokens. When no CLI reports usable credentials, a
compact, non-dismissible banner links directly to the provider controls, and task surfaces stop
offering disconnected providers.

The chosen notification is the compact global banner shown in the approved visual comparison.
Provider status refreshes every 30 seconds, on window focus, after a Connect action, and when the
user explicitly asks to check again.

## Goals

- Detect provider-owned credentials for Claude Code, Codex, OpenCode, and pi through supported CLI
  commands.
- Distinguish connected, disconnected, not-installed, and indeterminate providers without
  exposing credentials or account details.
- Reuse credentials automatically by continuing to launch each runner as the same host user;
  no token injection or credential copy is necessary.
- Guide local users through the vendor's login flow and give hosted users an exact command to
  run on the cezar host.
- Keep provider setup inside the existing Settings → Agents page.
- Make disconnected providers unavailable in task and follow-up runner pickers.
- Preserve zero configuration, dry-run behavior, and graceful degradation.

## Non-goals

- cezar does not implement, proxy, or embed a third-party OAuth flow.
- cezar does not read Keychain entries, credential JSON, environment-secret values, emails,
  organizations, subscription tiers, or provider tokens.
- cezar does not install missing CLIs automatically.
- cezar does not validate billing, quotas, model access, or network reachability. A connected
  credential can still fail later for reasons only the provider can diagnose.
- Request shapes remain compatible, but every new agent-starting action now applies a
  provider-availability gate before it starts a runner. A request that requires a disabled
  provider or unavailable credentials receives the fixed 409 recovery message; existing runs
  continue unchanged, and credentials can still expire between that gate and process spawn.
- `/api/health` remains byte-shape compatible and does not gain authentication fields or extra
  probes.

## Vendor-owned contracts

The status implementation uses commands supplied by the tools rather than inferring state from
private storage:

| Provider | Status command | Login command | Interpretation |
| --- | --- | --- | --- |
| Claude Code | `claude auth status --json` | `claude auth login` | Exit 0 plus `loggedIn: true` is connected; the documented not-logged-in result is disconnected. |
| Codex | `codex login status` | `codex login` | A recognized logged-in result is connected; a recognized not-logged-in result is disconnected. |
| OpenCode | `opencode auth list` | `opencode auth login` | One or more CLI-reported credentials is connected; an explicitly empty list is disconnected. |
| pi | `pi --list-models` | `pi /login` | One or more CLI-reported available models is connected; pi's explicit no-models guidance is disconnected. |

Claude documents `claude auth status` as returning JSON and exiting 0 when logged in and 1 when
not logged in: <https://code.claude.com/docs/en/cli-usage>. OpenCode documents `opencode auth
login` and `opencode auth list`: <https://opencode.ai/docs/cli/>. The installed Codex CLI's
`login` help exposes both `login` and `login status`; parser fixtures pin the accepted output so
unrecognized future output degrades to `unknown` rather than guessing.

`connected` means the CLI found provider-owned stored credentials, including OAuth where the CLI
supports it. In Settings this is presented as **Credentials found** with a green dot; it is not a
claim that the next model request will succeed. cezar deliberately trusts the CLI's effective
discovery answer instead of trying to classify or reproduce the vendor's credential-precedence
rules.

## Core model and detection

Create `src/core/provider-auth.ts` as the only provider-authentication knowledge seam. It owns
the command table, parsers, process timeouts, hints, and cache. It does not change
`src/core/backend-detect.ts`, whose `available` field continues to mean executable availability
for the Tools menu and other compatibility surfaces.

```ts
export type ProviderId = 'claude' | 'codex' | 'opencode' | 'pi';
export type ProviderConnectionState =
  | 'connected'
  | 'disconnected'
  | 'not-installed'
  | 'unknown';

export interface ProviderStatus {
  provider: ProviderId;
  status: ProviderConnectionState;
  /** Present on workspace-enriched rows; absent on raw discovery rows and some SSE rows. */
  enabled?: boolean;
  hint?: string;
  /** Present only for a current, runtime-latched disconnected incident. */
  authFailureId?: string;
}

/** Complete workspace HTTP response: all four providers, ordered, with enablement applied. */
export interface ProviderStatusResponse {
  providers: Array<ProviderStatus & { enabled: boolean }>;
}
```

`ProviderStatus` is the additive core row shared by discovery, runtime invalidation, and workspace
SSE. The server applies the global preference before returning a complete HTTP response, so REST
clients always receive every provider with required `enabled`; the browser may merge an unstamped
SSE row whose optional `enabled` field is absent into that cached complete response. An
`authFailureId` is opaque and is present only on the current runtime-latched `disconnected` row.

All four probes run concurrently with a 10-second per-process timeout, matching existing host
tool probes. Each provider always produces one row, in `claude`, `codex`, `opencode`, `pi` order:

- `ENOENT` means `not-installed`.
- A recognized vendor answer means `connected` or `disconnected`.
- A timeout, malformed output, unexpected exit, permission failure, or unrecognized future
  format means `unknown` with a concise retry hint.
- Probe stdout and stderr are parsed in memory and never logged or returned.

The detector coalesces concurrent requests and caches the completed result for five seconds so
multiple tabs do not fan out identical processes. An explicit refresh bypasses the completed
cache while still joining an already-running probe. `CEZ_DRY_RUN=1` returns all four providers
as connected mock providers and invokes no real CLI, preserving offline runner selection.

Existing binary overrides remain authoritative: `CEZ_CLAUDE_BIN`, `CEZ_CODEX_BIN`,
`CEZ_OPENCODE_BIN`, and `CEZ_PI_BIN` select the executable used by both status and login commands. The executable
is shell-quoted before it is rendered into the terminal command; every argument comes from the
closed server descriptor. The pi runner already documents `CEZ_PI_BIN` in `.env.example`; this
integration reuses it and adds no new environment variable or configuration key.

## Runtime invalidation

A provider's authoritative runtime authentication rejection outranks its stored-login status:
an agent can discover that a token has been revoked after the vendor CLI reported it as logged
in. The status service keeps an in-memory latch per provider for that condition and reports the
latched provider as disconnected with a safe, fixed reconnect hint.

Ordinary 30-second polling and **Check again** preserve a latch, even when the vendor's
stored-login probe still finds credentials. Check again (`?refresh=1`) refreshes discovery only;
it cannot turn a known runtime rejection green. Connect also preserves the latch, so a launched
login command cannot prematurely claim recovery.

The latch is generation-aware: every runtime rejection advances that provider's generation.
Responses apply the current latch only after their asynchronous probes resolve, so an older
in-flight result cannot restore green. Explicit **Try again** is an incident-safe recovery
operation: it accepts the submitted opaque `authFailureId` and clears only that still-current
incident. A stale or malformed incident cannot clear a newer rejection. Store observation is
installed before startup recovery for the boot project and every lazy project context.

The server emits the resulting latch transition as an additive, workspace-level
`provider-status` SSE event. A duplicate v1/v2 runtime report causes no second transition. Raw
runtime error text never leaves the server: that event carries only the provider id, disconnected
state, fixed hint, and opaque `authFailureId` (not a project stamp or vendor output).

A runtime-latched provider row includes an opaque `authFailureId`. The identifier stays stable for
that latch, is removed by successful explicit recovery, and changes if a later runtime rejection
creates a new latch. It contains no vendor output or credential data.

## Global availability and task recovery

Provider enablement is a separate, global host-user preference, independent of credential
discovery. It defaults to enabled and is persisted as the optional workspace-config
`disabledProviders` list. A provider is usable only when:

```text
usable = enabled && status == connected
```

Disabling applies to new actions only: it removes the provider from new-task, follow-up, and
other agent-starting choices, but never cancels, edits, or otherwise mutates existing tasks.
Disabled cards keep their discovery state and green **Credentials found** signal, plus a visible
**Disabled** state. The preference is global rather than project-scoped, so it persists through
reloads and project switches.

Every task that encounters an authoritative provider authentication rejection receives a safe,
persisted `provider-auth-required` event containing only the provider, opaque incident id, and
step context. It renders the task-local authorization recovery card (for example, “Claude Code
needs authorization”) and its project-aware Settings link. The global runtime-authentication
alert remains in place independently of that task-local history.

## HTTP API

Provider credentials belong to the host user, not to a repository. All four provider endpoints
are workspace routes mounted once, outside `/api/p/:projectId`, and remain protected by the
existing global same-origin request guard.

### `GET /api/providers/status`

Returns the complete `ProviderStatusResponse`: exactly the four ordered provider rows, each with
required `enabled`, plus optional `hint` and current runtime `authFailureId`. `?refresh=1`
bypasses the five-second completed-result cache for the Check again action, but does not clear a
runtime-authentication incident. The query accepts only the literal `refresh=1`; another value is
`400 { error: 'refresh must be 1 when provided' }`. One failed provider does not fail the
response; its row is `unknown`, so the route normally returns 200 even on a smaller or partially
broken host.

The route is deliberately separate from `/api/health`: health is CORS-open, latency-sensitive,
and covered by a backwards-compatibility contract. Authentication state is neither necessary
nor appropriate on that surface.

### `POST /api/providers/connect`

The strict JSON body is validated with Zod (no extra keys):

```ts
{ provider: 'claude' | 'codex' | 'opencode' | 'pi' }
```

The validated provider id selects a server-owned descriptor; request text never becomes an
executable or argument. The descriptor supplies fixed arguments, while the canonical executable
or its existing `CEZ_*_BIN` override is shell-quoted before terminal handoff. The 200 response is
one of:

```ts
{ opened: true; command: string }
{ opened: false; connected: true; command: string }
```

Behavior:

- In local-handoff mode, an already-connected provider returns the second 200 response without
  opening a terminal, a not-installed provider returns 409 with its install hint, and a
  disconnected provider opens the vendor login command in a real terminal rooted at the boot
  repository.
- A successful launch returns 200 with `{ opened: true, command }`.
- If no terminal emulator can be opened, the route returns 409 with a human error and the exact
  copyable `command`.
- When `capabilities.localHandoff` is false, the route never attempts a local GUI launch. It
  returns 409 with the command and tells the user to run it on the cezar host.
- Invalid JSON or provider ids return
  `400 { error: 'provider must be claude, codex, opencode, or pi' }`.
- If the selected provider row cannot be found after a fresh probe, the route returns
  `500 { error: 'Authentication could not be verified. Try again.' }`. The route's 409 responses
  always include the copyable command; they cover not-installed, unknown, hosted-handoff, and
  terminal-launch cases.

Launching the vendor CLI is the maximum safe automation: the CLI owns browser authorization,
callback handling, credential storage, and consent. cezar neither observes nor receives the
resulting token.

### `PUT /api/providers/:provider/enabled`

The provider path is the closed provider enum and the JSON body is the strict shape
`{ enabled: boolean }`; malformed JSON, an unknown provider, a non-boolean value, or extra keys
returns `400 { error: 'provider and enabled boolean are required' }`. A successful request merge-writes the global
`disabledProviders` preference, returns the complete `ProviderStatusResponse`, and emits the
selected enriched provider row as workspace `provider-status`. A preference-write failure returns
`500 { error: 'Provider preference could not be saved.' }` and emits no event. The response does
not change discovery or clear a runtime incident.

### `POST /api/providers/:provider/retry`

Try again uses the closed provider path and strict JSON `{ authFailureId: string }`. Missing,
malformed, unknown-provider, empty, or extra-key input returns
`400 { error: 'provider and current authFailureId are required' }`. It clears only the submitted
current runtime incident, then force-refreshes discovery, returns the complete
`ProviderStatusResponse`, and emits the selected enriched provider row. If the incident is stale
or no longer current, it returns
`409 { error: 'Authentication incident changed. Refresh and try again.' }` and preserves the
current latch. Retry never enables a disabled provider; it has no preference-write 500 path.

## Client model and refresh behavior

Add provider response types, client methods, query keys, and a `useProviderStatus()` hook. The
normal query uses a 30-second `refetchInterval`. It also refetches on window focus. Connect
success invalidates the status query immediately; the explicit Check again control requests
`?refresh=1` so a fresh discovery result is not hidden behind the short server cache. Only the
incident-specific Try again action can clear the runtime-authentication latch.

While the first status request is pending, the UI does not flash the missing-provider banner and
does not invent a fallback provider. Task submission waits until provider status is known. A
route-level fetch failure is shown as an honest verification error with Retry; it is not treated
as proof that every account is disconnected.

## Settings → Agents

Extend `web/app/src/routes/settings/agents-section.tsx`; do not add a separate Providers settings
route. A Providers block with `id="providers"` appears first and gives each supported provider a
card. The controls are a state/action matrix, not a claim that discovery proves a live model
request:

| Card state | Discovery label | Available actions |
| --- | --- | --- |
| `connected` | green **Credentials found** | Enable/Disable |
| `disconnected` | amber **Not connected** | Enable/Disable, Connect, Check again, and Try again only for a current runtime incident |
| `not-installed` | **Not installed** with install hint | no enablement, Connect, Check again, or Try again control |
| `unknown` | **Could not verify** | Enable/Disable and Check again, without asserting that credentials are absent |

Enable/Disable calls the PUT route. Connect calls the POST route; a successful terminal launch
shows a toast explaining that the vendor flow must be completed there. A 409 carrying `command`
reveals a copyable manual command; other failures use the server's message verbatim. Check again
uses `GET /api/providers/status?refresh=1` and refreshes discovery only. Try again posts the
visible opaque `authFailureId` to the retry route only when that current runtime incident exists;
it explains that cezar cannot validate the credential without a later task/model request.

The existing project-specific Default runner and Default models controls remain where they are.
Every provider stays visible for discoverability, but controls for anything other than
`connected` are disabled and carry a concise reason. If the saved default runner is no longer
connected, it remains visibly selected so Settings does not lie about persisted configuration;
the page asks the user to connect it or choose another connected provider.

## Global banner

Use the existing generic `AppShell` banner slot. `AppShellContainer` derives the banner from the
provider-status query:

- If any provider is `connected`, render no banner.
- If status is loaded, none is connected, and every row is definitive, show “No agent provider
  is connected.”
- If none is connected and any row is `unknown`, show “No connected provider could be verified.”
- While loading or when the route itself is unreachable, do not show the definitive missing
  banner; surface verification failure in the provider-dependent controls instead.

The banner is compact, non-dismissible, keyboard accessible, and visible above the route
scroller on desktop and mobile. Its project-aware link targets `/settings/agents#providers`; a
global-settings page falls back through the existing boot-project redirect. The Providers block
uses scroll margin so the hash target is not obscured by sticky settings chrome.

The global banner first renders every undismissed runtime-authentication incident, even when another
provider is connected. Dismissals are provider-to-incident mappings in workspace UI state and never
change provider status. When no runtime incident remains visible, the existing zero-connected
provider banner rules apply.

## Runnable-provider gating

Do not overload `BackendCheck.available`: it remains installation state. Introduce a helper that
derives connected runner ids from `ProviderStatusResponse`, with no legacy Claude fallback.

The helper feeds every interactive provider picker:

- new-task runner selection and submission;
- parallel-variant engine pills;
- follow-up runner selection.

Disabled, disconnected, not-installed, unknown, and still-loading providers are not selectable.
When the usable set is empty, the new-task form disables submission and shows a direct link to
the Providers block. Existing Agent config “not installed” badges continue to use health checks,
because config-file visibility depends on installation rather than login.

## Security and privacy

- Status is same-origin only and is not added to the CORS-open health endpoint.
- Responses contain provider ids, coarse state, and human hints only.
- Provider ids and command arguments are fixed server constants selected by a closed Zod enum;
  existing executable overrides are server environment only and are shell-quoted.
- Connect is gated by `localHandoff`, matching other open-on-this-machine capabilities.
- Credential files, keychains, tokens, account identifiers, and raw command output never cross
  the API boundary.
- Probe failures degrade per provider; they never prevent cezar from booting.

## Compatibility and zero configuration

- No existing route or response changes shape.
- No state file, migration, daemon, port, account, or authored configuration is introduced.
- Missing CLIs and read-only or hosted environments remain supported.
- The Tools menu keeps reporting installed tools from `/api/health`; authentication belongs only
  to the new provider surface.
- Old direct API clients keep their existing request shapes. Their new agent actions receive the
  same fixed 409 response when a required provider is disabled or its credentials are unavailable.

## Test plan

### Core and API

- `src/core/provider-auth.test.ts`: Claude JSON and exit behavior; Codex positive/negative output
  ordering; OpenCode empty and populated lists; ANSI/whitespace tolerance; missing binaries;
  timeouts; malformed output; per-provider isolation; five-second cache; forced refresh;
  in-flight coalescing; and dry-run with zero process calls.
- `src/server/providers-api.test.ts`: complete GET response, refresh flag, one-provider failure,
  strict POST body validation, descriptor command selection and executable quoting,
  already-connected and not-installed handling, local terminal success, no-terminal command
  fallback, and hosted-mode refusal.

### Client and UI

- API/query tests pin route paths, response types, 30-second polling, focus behavior, normal
  invalidation, and forced refresh.
- Agents-section tests cover all four card states, Connect, Check again, manual-command fallback,
  persisted-but-disconnected defaults, and disabled model/default controls.
- App-shell-container tests cover definitive and indeterminate banner copy, project-aware hash
  navigation, non-dismissible behavior, loading suppression, and disappearance after connection.
- New-task, engine-pill, and follow-up tests prove only connected providers are selectable, the
  old Claude fallback is absent for this status source, and submission is disabled at zero.

### Browser verification

Run `npm run dev` and use temporary executable shims placed first on `PATH` to simulate installed
but disconnected CLIs. The shims contain no credentials and do not modify real provider state.
Using the requested in-app Browser, verify:

1. the compact global banner appears;
2. its link lands on the Providers block inside Settings → Agents;
3. cards and disabled default controls match provider state;
4. task submission is blocked with a setup link;
5. a second shim state with one connected provider removes the banner and enables that provider.

Do not automate the real vendor login or touch the user's real credentials during QA. Route and
UI tests mock the terminal handoff.

### Repository validation

Run the repository gates in their documented order before any final commit or PR:

```bash
npm run typecheck
npm test
npm run test:unit
npm run build
npm run test:package
```

Run `npm run test:e2e` separately and report `passed`, `skipped`, or `failed` according to its
marker rather than treating a skip as success.
