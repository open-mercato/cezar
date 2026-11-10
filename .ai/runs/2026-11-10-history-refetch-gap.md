# Fix transcript gap after a run-history refetch (#2018)

Issue: #2018

## Goal

A refetch of `run-history` after loading older pages must never leave a hole between the rendered
pages and the live stream.

## Scope

- Server (`packages/cezar/src/runs/event-history.ts`): a page with a `newerCursor` gets an
  `asOfSeq` and `liveCursor` that end at its own last event (byte offset after that line), not at
  the file high-water mark.
- Client (`packages/web/src/api/run-history.ts`): drop the `pages.at(-1)` live-anchor fallback;
  when no cursorless page or cached tail exists, reset the query to the newest page.

Non-goals: page size, `maxPages`, storage format, the #1909 truncated-replay refill, and the
reconcile invalidation itself (with both fixes a forward-rebuilt window is still contiguous).

## Risks

- Contract shape unchanged; only the values on non-newest pages shrink to what they really cover.
- Old clients that anchored on `pages.at(-1)` now replay from that page's end: correct, larger replay.

## Progress

PR: #2062

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Fix

- [x] 1.1 Bound non-newest page asOfSeq/liveCursor on the server — bc0e80bcc
- [x] 1.2 Never anchor the live stream on a non-newest page in the cockpit — bc0e80bcc
- [x] 1.3 Regression tests (red without fix) and full validation gate — bc0e80bcc
