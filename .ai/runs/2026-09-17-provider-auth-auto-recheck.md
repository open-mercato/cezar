# Provider auth failures verify themselves before they stick

## Goal

A provider rejection observed during a run must be checked against the provider's own CLI before it
is left standing, so a transient or misread rejection clears itself instead of parking the cockpit
behind a red banner that only a human's "Try again" can dismiss.

## Scope

The reported symptom: a task dies with `Provider authentication failed during a task: Claude Code.`,
and opening Settings → Agents and pressing **Try again** clears it every time. That button is
`POST /api/v1/providers/:provider/retry` (`server.ts`), which does exactly two things —
`clearRuntimeAuthFailure(provider, id)` and a refreshed probe. It succeeds because the credentials
were never actually gone.

The mechanism behind that: `watchProviderRuntimeAuthFailures` (`provider-auth-runtime.ts`) pattern-
matches a run's `error` / `session.error` / `note` message with `isRuntimeProviderAuthFailure` and
latches the provider `disconnected` via `reportRuntimeAuthFailure`. The latch is authoritative —
`withRuntimeFailures` overrides even a fresh `connected` probe — and `clearRuntimeAuthFailure` is
the ONLY exit. Nothing calls it except the retry route. So a rejection that was transient (a 401
during a token refresh, a vendor blip) or a false positive of the text match becomes a permanent red
banner until a human clicks.

This run adds the missing exit: one bounded self-check per incident, in the observer that raised it.

- `packages/cezar/src/core/provider-auth.ts` — the self-check and its cooldown.
- `packages/cezar/src/server/provider-auth-runtime.ts` — trigger it on the latch edge, fan the
  recovery out through the callback that already carries `provider-status`.

### Non-goals

- Resuming or restarting the run that hit the rejection. The self-check repairs cockpit state; a
  dead run is still resumed by the user. Worth a follow-up, deliberately not bundled here.
- Changing `isRuntimeProviderAuthFailure`'s patterns, the latch's authority over a cached probe, or
  `provider-action-gate`'s refuse-before-start behavior.
- Suppressing the `provider-auth-required` event recorded on the affected task. The task transcript
  keeps its record of what the runner reported; only the workspace-wide status self-heals.
- Any new setting. Per AGENTS.md § Zero config this is discovered behavior, not a knob.

## Implementation Plan

### Phase 1: The self-check in the service

1. Add `verifyRuntimeAuthFailure(provider)` to `ProviderAuthService`: probe that one provider fresh,
   and when the CLI still reports `connected`, clear the exact incident by its `authFailureId` and
   return the recovered row. Guard it with a per-provider in-flight flag, a one-minute cooldown on
   the injected clock, and the existing `CEZ_DRY_RUN` / `CEZ_AGENT_MODELS_LOCKED` bypasses. Fold the
   probed row into the cached response so clearing the latch cannot expose an older answer.
2. Cover it in `provider-auth.test.ts`: clears on a connected CLI, keeps the latch on a disconnected
   one, is a no-op inside the cooldown, does not clear an incident it did not observe, and never
   probes under the two bypasses.

### Phase 2: Trigger it where the latch is raised

3. In `watchProviderRuntimeAuthFailures`, kick the self-check off on the latch edge only
   (`report.transitioned`) and report a successful recovery through the same status callback the
   invalidation already uses, so `provider-status` reaches every open cockpit with no new wiring at
   the three `ProviderRuntimeAuthObserver` construction sites.
4. Cover it in `provider-auth-runtime.test.ts`: a recovery row follows the invalidation when the CLI
   verifies fine, none follows when it does not, and repeat failures under one latch probe once.

### Phase 3: Verification and handoff

5. Run the full validation gate (`npm run typecheck`, `npm test`, `npm run test:unit`,
   `npm run build`, `npm run test:package`).
6. Open the PR, run the authoritative review pass, apply labels and the summary comment.

## Risks

- **A CLI that reports `connected` while the vendor rejects the token** (server-side revocation the
  CLI cannot see) would have its banner cleared while runs keep failing. Accepted: every subsequent
  rejection re-latches, the cooldown bounds it to one probe a minute, and the pre-existing manual
  Connect path is untouched. The alternative — the status quo — is worse: it treats a heuristic text
  match as more authoritative than the CLI itself.
- **Extra CLI spawns.** Bounded by the latch edge plus the one-minute per-provider cooldown, so a run
  emitting a burst of auth-shaped lines costs one probe, not one per line.
- **An existing test changes meaning.** `attaches boot-store observation before recovery can emit an
  auth failure` asserts a latch survives against a mock CLI that reports logged in — which is now
  exactly the case that self-heals. It is re-pointed at a logged-out mock so its subject (observation
  is attached before recovery runs) is preserved rather than weakened.

## Progress

PR: #1014

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: The self-check in the service

- [x] 1.1 Add `verifyRuntimeAuthFailure` with its in-flight guard, cooldown, and cache fold — 48c58eb0
- [x] 1.2 Cover the self-check in `provider-auth.test.ts` — 48c58eb0

### Phase 2: Trigger it where the latch is raised

- [x] 2.1 Kick the self-check off on the latch edge and fan recovery out as `provider-status` — 0c043b72
- [x] 2.2 Cover the observer behavior in `provider-auth-runtime.test.ts` — 0c043b72

### Phase 3: Verification and handoff

- [x] 3.1 Run the full validation gate — fe715376
- [x] 3.2 Open the PR, review pass, labels, summary comment — 3396e0ff
