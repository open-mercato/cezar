# Star count: refresh every 10 seconds

## Goal

The sidebar ⭐ chip shows cezar's real GitHub star count, refreshed every 10 seconds instead of once per session against a six-hour server cache.

## Scope

- `packages/cezar/src/server/star-count.ts`: success TTL 6 h → 10 s; failure backoff 15 min → 1 min; send `GITHUB_TOKEN` (or `GH_TOKEN`) when set; read GitHub's rate-limit headers so the reader paces itself to the remaining hourly budget and, once rate-limited, waits for `x-ratelimit-reset` / `retry-after`. The stale count is still served the whole time.
- `packages/web/src/api/queries.ts`: `useStarCount` refetches every 10 s while the tab is visible.
- Docs: AGENTS.md, BACKWARD_COMPATIBILITY.md, docs/reference.md, .env.example: update the "once per six hours" contract text.

## Non-goals

- No WebSocket topic: remote mode cannot open one, so it would need the HTTP poll anyway.
- No `gh auth token` spawning, and no change to the `{available, count?, url}` contract shape or the `CEZ_NO_BANNER=1` off switch.

## Risks

- Without a token, GitHub allows 60 requests/hour per IP. Pacing spreads that budget out, so an unauthenticated machine updates about once a minute rather than every 10 s, and never runs into the 403.
- More requests to github.com than before, on a default-on promo that the owner still has to ratify (AGENTS.md § Zero config). `CEZ_NO_BANNER=1` still stops all of them.

## Progress

PR: #1379

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Server refresh cadence

- [x] 1.1 Shorten the TTL, add token auth and rate-limit pacing to the star-count reader, with tests — 0c90bcd2

### Phase 2: Cockpit poll

- [x] 2.1 Poll `useStarCount` every 10 seconds, with a test — a955d76f

### Phase 3: Docs

- [x] 3.1 Update the star-count cadence in AGENTS.md, BACKWARD_COMPATIBILITY.md, docs/reference.md and .env.example — bceb57d6
