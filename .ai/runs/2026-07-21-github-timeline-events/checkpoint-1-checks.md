# Checkpoint 1 — after Step 1.5 (server side of Phase 1 complete)

**Steps covered:** 1.1 → 1.5
**Commits:** `717bd65`, `615d239`, `c0fc673`, `b943dc2`, `ec00a6d`

## Targeted validation

| Command | Result |
|---|---|
| `npm run typecheck` (server + web) | ✅ clean |
| `npx vitest run src/server/forge` | ✅ 101 passed (3 files) |
| `npx vitest run src/server` | ⚠️ 551 passed, **1 pre-existing failure** (see below) |

**UI verification: skipped — no UI changed yet.** Steps 1.1–1.5 are entirely server-side
(types, zod boundary, normalizer, fetch). The first user-visible change lands at Step 1.7.

## Pre-existing failure (not this branch)

`src/server/request-validation.test.ts` → *"rejects an open-in with no target (400)"* fails with
`409 ≠ 400`. **Verified against a clean `origin/main` worktree: it fails there too.** Pre-existing
drift, out of scope here, recorded so the final gate is not misread as green-with-a-regression.

## What the new tests actually prove

The suite grew by 30 cases. The ones that carry weight — each pinning a trap the spec verified
against the live API, where the naive implementation is silently wrong rather than loudly broken:

- **`comments[]` is byte-identical to pre-change output** for the same rows, asserted both against
  `normalizeComments` directly and against the legacy fetch path. This is the §2 guarantee.
- **A `committed` row resolves its timestamp from `author.date`**, never `created_at` (which is
  `null`). The naive mapping string-sorts every commit to the top and reorders the whole thread.
- **Non-UTC `author.date` is normalized** — `+09:00` would otherwise sort after a UTC time it
  actually precedes.
- **The event cap keeps the newest window** (`slice(-cap)`), the opposite of the neighbouring
  `mergeThread`. Asserted by id at both ends, not just by length.
- **The shared page budget drains** — pages are handed `[15000, 11000, 7000, 3000]`, and the loop
  stops rather than running 10 × 15 s. This is the 150 s-ceiling regression.
- **A timeline 404 still returns populated `comments[]`** with `available: true` — the inner catch
  being scoped inside the outer one.
- **`ENOENT` spawns exactly one subprocess** — no pointless second attempt.
- **A page-capped, comment-poor prefix returns the full 200 comments** via the top-up, and **a
  throwing top-up still returns the timeline's own rows** with `available: true` rather than
  falling through to the empty-thread path.
- **`mergeThread`'s output cannot be moved by event volume.**

## Notes

One test-fixture bug was found and fixed during this checkpoint: the `gh` mock returned the same
full page for every page, so the 10-page walk duplicated a single comment ten times. The fixtures
are now page-aware. The source behavior was correct throughout — worth recording because a
page-insensitive mock would have hidden a real paging bug just as easily as it manufactured a fake
one.

## Next

Step 1.6 — mirror the wire types into `web/app/src/api/types.ts`, then 1.7 (`EventRow`, the
client-side interleave, and the header/empty-guard changes), which is where the first screenshots
become possible.
