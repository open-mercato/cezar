# Star count: refresh alongside other requests, at most every 15 minutes

## Goal

The ⭐ chip stops polling on its own timer. The star count refreshes only when the cockpit is already making other requests, and cezar asks github.com at most once per 15 minutes.

## Scope

- `packages/cezar/src/server/star-count.ts`: success TTL 10 s → 15 min, failure backoff 1 min → 15 min. GitHub's rate-limit pacing stays as a further brake.
- `packages/web/src/api/queries.ts`: `useStarCount` loses its `refetchInterval`. A query-cache subscription refreshes the count when another query finishes fetching, and only once the cached count is 15 minutes old.
- Docs: AGENTS.md, BACKWARD_COMPATIBILITY.md, docs/reference.md and .env.example describe the new cadence.

## Non-goals

- No change to the `{available, count?, url}` contract, the `CEZ_NO_BANNER=1` off switch, the disk cache or token auth.
- No server-side request hook: the browser is the only consumer, and an idle cockpit should not spend requests.

## Risks

- A cockpit making no other requests (idle, hidden tab) shows a stale count. The number is decoration, so this is acceptable.

## Progress

PR: #1944

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Server cadence

- [x] 1.1 Raise the star-count TTL and failure backoff to 15 minutes, with tests — fff34e0cc

### Phase 2: Cockpit piggyback refresh

- [x] 2.1 Replace the star-count poll with a refresh triggered by other queries, with a test — 41c4dd233

### Phase 3: Docs

- [x] 3.1 Update the star-count cadence in AGENTS.md, BACKWARD_COMPATIBILITY.md, docs/reference.md and .env.example — c66ace7db
