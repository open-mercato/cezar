# Provider Availability and Task Authentication Recovery

**Date:** 2026-07-24
**Status:** Proposed

## Problem

cezar discovers provider authentication through the vendor CLIs:

- `claude auth status --json`
- `codex login status`
- `opencode auth list`

Those commands report locally available, provider-owned credentials. They do not prove that the
credential will be accepted by the next model request. In particular, Claude Code can report
`loggedIn: true` for a stored OAuth token that the API later rejects with a 401.

The current Settings label, **Connected**, overstates that inexpensive signal. Runtime rejection
is handled globally, but the task that encountered the rejection contains only the vendor error;
it does not give the user a direct recovery path. Automatically discovered providers also cannot
be excluded from cezar without removing or modifying the provider's own credentials.

## Goals

- Keep provider discovery cost-free and consistent across Claude Code, Codex, and OpenCode.
- Present discovered credentials with a green dot without claiming live authentication.
- Show a structured authorization callout inside every task that encounters an authoritative
  provider authentication rejection.
- Link that callout directly to Settings → Agents → Providers.
- Allow a user to disable or re-enable a discovered provider globally across cezar projects.
- Exclude disabled providers from new tasks and follow-ups without interrupting existing tasks.
- Preserve the current app-wide runtime-authentication notification.
- Keep raw credentials, account identity, commands, and vendor output behind existing boundaries.

## Non-goals

- No background model request, network credential check, quota consumption, or billing validation.
- No credential reads, token copies, token refreshes, or provider-specific OAuth callback handling.
- No automatic cancellation of running, queued, waiting, or review tasks when a provider is
  disabled.
- No per-project provider preference.
- No change to backend availability detection or runner implementations.

## Status Semantics

`ProviderStatus.status` continues to describe the vendor CLI's discovery result:

- `connected`: provider-owned credentials were found;
- `disconnected`: the vendor reports no credentials, or a runtime authentication failure is
  latched;
- `not-installed`: the executable is missing;
- `unknown`: the probe could not be interpreted or completed.

The Settings presentation for `connected` changes from **Connected** to **Credentials found**.
Its green dot remains. This label is used for Claude Code, Codex, and OpenCode; cezar does not
pretend that one provider's local status command is more authoritative than another's.

Provider usability is a separate rule:

```text
usable = enabled && status == connected
```

The API adds `enabled: boolean` to every provider-status row. New clients require the field from a
complete status response but accept its absence on additive workspace `provider-status` events,
preserving the cached value. Older clients ignore the additive field.

A disabled provider retains its discovered status and dot. Settings also shows **Disabled**, so a
green discovery dot is never mistaken for permission to use that provider.

## Global Provider Preferences

The optional user-level workspace config `~/.cezar/config.json` gains:

```json
{
  "disabledProviders": ["opencode"]
}
```

The field defaults to an empty array. Parsing salvages valid values from the fixed provider set
(`claude`, `codex`, `opencode`), drops invalid entries, deduplicates them, and preserves unrelated
unknown config keys. Writes go only through `mergeWriteWorkspaceConfig`, retaining the existing
atomic, mode-`0600`, read-modify-write behavior.

Provider preference is global because credentials and discovery are host-wide. Every status
request reads current workspace config, so separate cezar processes converge on the shared setting
on their next status poll without adding a daemon or file watcher.

Disabling affects future actions only:

- new tasks cannot select or submit with the provider;
- new follow-ups and other agent-starting actions cannot use the provider;
- default-runner controls keep the saved value visible but warn when it is disabled;
- tasks that already exist continue through their configured workflow, including queued tasks and
  later steps;
- disabling never cancels a task, kills a session, or edits a workflow.

## API Contracts

The existing workspace-level status route remains separate from health:

```http
GET /api/providers/status
```

Every returned row includes `enabled`.

Two workspace-level mutating routes are added:

```http
PUT /api/providers/:provider/enabled
Content-Type: application/json

{ "enabled": false }
```

The route validates the provider path and a strict boolean body, merge-writes workspace config,
returns the refreshed `ProviderStatusResponse`, and emits the affected coarse status row to the
workspace event stream. A failed write returns a fixed error and leaves query state unchanged.

```http
POST /api/providers/:provider/retry
Content-Type: application/json

{ "authFailureId": "opaque-current-incident-id" }
```

Retry is an explicit user acknowledgement after completing the vendor login flow. It clears only
the matching provider incident. A missing, malformed, or stale incident ID cannot clear a newer
failure and returns a fixed 400 or 409 response. Retry does not enable a disabled provider.

`GET /api/providers/status?refresh=1` continues to bypass the short probe cache, but no longer
clears a runtime-authentication latch from a local “credentials found” answer. **Check again**
therefore refreshes discovery only. It cannot turn a known revoked credential green.

The existing connect route continues to open or return the provider-owned login command. It does
not clear the runtime latch merely because a terminal was opened.

All mutating provider routes remain same-origin guarded and validate JSON through zod. Responses
contain no credential data, raw probe output, account identifiers, environment-secret values, or
terminal output.

## Runtime Authentication Event

The server runtime-auth observer remains the only classifier for authoritative authentication
errors. When a run event matches:

1. resolve the provider from the failing step backend, then the run backend, then the legacy
   Claude default;
2. create or advance that provider's runtime failure generation;
3. preserve one stable opaque `authFailureId` for the active provider latch;
4. emit the coarse disconnected row through workspace `provider-status` when the global latch
   first transitions;
5. append a safe task event:

```json
{
  "type": "provider-auth-required",
  "provider": "claude",
  "authFailureId": "opaque-current-incident-id",
  "stepId": "implementation"
}
```

The task event is persisted in the run's NDJSON and replayed normally. It deliberately contains no
copy of the vendor error. Repeated v1/v2 representations of the same rejection are deduplicated per
run, provider, and incident ID. If another task fails against an already-latched provider, that
task still receives its own callout while the global latch and incident ID remain stable.

The new event is additive to `AGENT_PROTOCOL.md`. Older cockpit builds ignore the unknown event;
new builds render it without changing backend runner contracts.

## Task-thread Experience

`provider-auth-required` becomes a dedicated thread entry at the point of failure. It is not
derived by reparsing raw vendor text in the browser.

The callout uses fixed cezar-owned copy:

```text
Claude Code needs authorization
Authorize Claude Code in Settings before trying again.
Open provider settings
```

Provider labels come from the existing fixed descriptor table. The link resolves through the
active project route to `/p/:projectId/settings/agents#providers`.

The event stays in task history after recovery because it explains why that turn failed. It is not
dismissible and does not claim the current provider state. The existing workspace-wide,
dismissible runtime incident alert remains unchanged and continues to list all currently latched
providers.

## Settings Experience

Each provider card shows:

- the discovery dot and **Credentials found**, **Not connected**, **Not installed**, or
  **Could not verify** label;
- an Enable/Disable control when the provider executable is installed or credentials are
  discoverable;
- a visible **Disabled** state when disabled;
- the existing Connect action for missing or runtime-rejected credentials;
- **Check again** for a fresh, cost-free discovery probe;
- **Try again** only for a current runtime-authentication incident.

**Try again** explains that cezar cannot validate the credential without making a model request.
The action is available after the user has followed the provider login flow. It submits the exact
visible `authFailureId`; success clears the latch and updates all provider-status consumers. If the
credential is still rejected, the next task creates a new incident and the provider returns red.

Enable/Disable mutations are optimistic only if rollback uses the last confirmed server state.
Rapid toggles are serialized so an earlier failed write cannot overwrite a later confirmed choice.

## Server Enforcement

The server derives usable providers from both discovery status and the global preference. Every
route or service that starts a new agent action enforces the same rule, including:

- task creation and multi-variant task creation;
- queued-message or follow-up entry points that open a new agent turn;
- GitHub handoff and inbox actions;
- plan-review starts and other existing runner pickers.

Client filtering improves the experience but is not the authorization boundary. A stale or
hand-crafted client request for a disabled provider receives a fixed 409 error with a Settings
link-safe message. Existing run execution does not repeat the preference gate, preserving the
approved non-destructive behavior.

## Failure and Race Handling

- A preference write failure leaves the server config unchanged and restores the last confirmed
  client state.
- A read-only or corrupt workspace config degrades to the zero-config default: all providers
  enabled, with the existing single warning behavior.
- Ordinary polling cannot clear runtime latches.
- Retry clears only the incident ID it observed; a newer concurrent rejection wins.
- Disabling and retrying are independent. Retry never silently enables a provider, and enabling
  never clears an authentication incident.
- Runtime rejection always outranks an older in-flight discovery response.
- An unknown provider event is ignored by the UI rather than crashing task replay.
- Disabled state never hides installation, discovery, or runtime-authentication diagnostics.

## Testing

Core and server tests cover:

- workspace config defaults, per-entry salvage, deduplication, atomic merge writes, and read-only
  degradation;
- status responses combining discovery with current global preferences;
- enable/disable request validation, response shape, workspace event fan-out, and write failures;
- runtime retry success, stale-incident conflicts, newer-generation races, and no implicit recovery
  from refresh;
- one structured task event per run/provider/incident, including a second task failing against an
  already-latched provider;
- multi-provider workflow attribution through `stepId`;
- no credential, raw error, command output, or account identity in new API/SSE/task payloads;
- server-side blocking for every new task and follow-up entry point;
- existing runs continuing after disable.

Cockpit tests cover:

- strict additive parsing of `enabled`;
- the **Credentials found** label and green dot for all providers;
- disabled cards, toggle serialization, rollback, and cross-project query updates;
- disabled providers excluded from every picker and submit path;
- persisted defaults remaining visible when disabled;
- `provider-auth-required` replay into an accessible task-local callout;
- project-aware Settings links;
- global notification behavior remaining intact.

Browser QA uses the real development cockpit:

1. disable an installed provider and confirm it remains discovered but disappears from new task and
   follow-up choices;
2. confirm an already-existing task is not cancelled;
3. re-enable the provider and confirm it returns to choices;
4. start a task with a Claude credential that produces a real 401;
5. confirm Claude turns red, the global notification appears, and the failing task contains the
   authorization callout with a working Settings link;
6. confirm ordinary polling and **Check again** do not clear the incident;
7. avoid automating or modifying the real provider login flow.

## Documentation

The provider-authentication feature spec is updated to define:

- green as credential discovery rather than live verification;
- global provider enablement as a separate availability dimension;
- the structured task-local authorization event;
- explicit incident-safe retry instead of probe-driven runtime recovery.

`AGENT_PROTOCOL.md` documents the additive `provider-auth-required` cezar event and confirms that it
does not alter the backend parity contract.
