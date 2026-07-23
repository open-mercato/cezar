# Runtime Provider Authentication Invalidation

**Date:** 2026-07-23  
**Status:** Approved

## Problem

The provider-status probes ask each vendor CLI whether it has stored authentication. That is
useful for initial setup, but it is not a live validity check. Claude Code can report
`loggedIn: true` while the provider later rejects that stored OAuth token with:

```text
Failed to authenticate. API Error: 401 OAuth access token has been revoked.
```

The runtime rejection is more authoritative than the earlier local status probe. Leaving the
provider green until the next 30-second poll is misleading, and allowing the poll to restore the
same stale green result would repeat the defect.

## Decision

Add a host-wide, in-memory runtime-authentication failure latch to `ProviderAuthService`.

When a normalized run event carries a conservative authentication-failure signature, cezar:

1. resolves the provider from the event's step backend, falling back to the run backend;
2. latches only that provider as `disconnected`;
3. overlays the latched result on subsequent `/api/providers/status` responses;
4. emits a workspace-level `provider-status` SSE event containing the coarse disconnected row;
5. patches the TanStack Query provider-status cache immediately in every open cockpit tab.

The disconnected row uses a fixed cezar-owned hint. Raw runtime error text, credentials, account
identity, and vendor command output do not cross the provider-status API or SSE boundary.

## Runtime Error Classification

`src/core/provider-auth.ts` remains the only provider-authentication knowledge seam. It exposes a
pure classifier for runtime error messages and recognizes only explicit authentication signals,
including:

- failed authentication or unauthenticated/unauthorized responses;
- OAuth/access/refresh tokens reported revoked, expired, or invalid;
- API keys reported revoked, expired, or invalid;
- an HTTP/API 401 when accompanied by authentication, token, or credential context;
- vendor `ProviderAuthError` messages.

Unrelated process exits, rate limits, network failures, and prose that merely discusses an HTTP
401 are not enough to invalidate a provider.

The server observes persisted run events of type `error`, `session.error`, and `note`. Including
`note` is necessary because Codex and OpenCode surface asynchronous follow-up prompt failures on
that channel. The existing event redaction runs before the observer; classification never needs
or retains secrets.

## Recovery Semantics

A normal status read, the five-second server cache, and the 30-second browser poll preserve the
runtime latch. This prevents a vendor CLI's stale local “logged in” answer from silently turning
the provider green again.

The explicit Settings “Check again” request (`GET /api/providers/status?refresh=1`) performs fresh
vendor probes and clears a latched provider only when that fresh probe reports `connected`.
`POST /api/providers/connect` refreshes probe state without clearing the latch, so a revoked
provider still opens the vendor login flow rather than returning “already connected.” After the
user completes that flow, “Check again” is the deliberate recovery action.

The latch is in memory only. Restarting cezar rebuilds status from vendor CLIs, preserving the
project's zero-configuration and no-new-state guarantees.

## Data Flow

```text
runner runtime rejection
        |
        v
RunStore normalized event
        |
        v
server runtime-auth observer
        |
        +--> ProviderAuthService latch --> GET /api/providers/status overlay
        |
        +--> workspace event bus --> provider-status SSE
                                      |
                                      v
                           TanStack provider-status cache
                                      |
                                      v
                         badge/banner/pickers update now
```

## API and Compatibility

- No existing HTTP response shape changes.
- `/api/health` remains unchanged.
- `provider-status` is additive on `/api/workspace/events`; older clients ignore the unknown
  event name.
- The event payload is one existing `ProviderStatus` row, not a new credential-bearing model.
- No provider credential files, keychains, or network validation calls are added.
- `CEZ_DRY_RUN=1` remains connected and does not acquire runtime latches.

## Alternatives Rejected

### Client-only cache invalidation

Parsing a failed run in the browser would update one tab, but the server would remain green and
the next poll would overwrite the correction. Other tabs and API consumers would also retain the
wrong state.

### Live network credential probes

Making a provider request during every status check could validate token usability, but it adds
network traffic, latency, possible cost, model/provider-specific behavior, and new failure modes
outside the supported CLI status contracts.

### Persisting revoked state

A disk latch would survive restarts but introduces state that can become stale and need repair.
The runtime signal and explicit recheck are sufficient without creating configuration or
migration work.

## Verification

- Core tests pin positive and negative runtime-authentication signatures, latch overlay, ordinary
  polling behavior, explicit recovery, connect-preserving refresh, and dry-run behavior.
- Server tests prove boot and lazily built project stores invalidate the correct provider and
  emit only the coarse SSE row.
- Client stream tests prove `provider-status` patches an existing provider cache immediately,
  ignores malformed rows, and stays workspace-wide rather than project-filtered.
- Existing provider API, settings, banner, and runner-gating tests remain green.
