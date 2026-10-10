# Plan — GitHub tab under one second

**Issue:** #1261
**Branch:** `cez/4882295a`
**Source spec:** `.ai/specs/2026-07-25-github-tab-incremental-loading.md` (Phase 2/3, amended by issue #1261)
**Mode:** spec-implementation run

## Tasks

> Authoritative status table. Each Step is exactly one commit.

| Phase | Step | Title | Exec | Status | Commit |
|---|---|---|---|---|---|
| 1 | 1.1 | Define paged GitHub contracts and body-detail migration | dispatch:standard | done | 26bf35c9 |
| 1 | 1.2 | Implement GraphQL cursor pages and cheap open totals | group:A:capable | done | 1ebbcfa9 |
| 1 | 1.3 | Add validated paged GitHub API parameters and detail payload | group:A:capable | done | 2424bdf5 |
| 1 | 1.4 | Update forge fixtures for the GraphQL list migration | inline | done | bb75ed0f |
| 2 | 2.1 | Add paged GitHub client queries and cache helpers | dispatch:standard | done | b29aff0c |
| 2 | 2.2 | Render cursor pages with load-more and virtualization | dispatch:capable | todo | — |
| 2 | 2.3 | Hydrate details and visible metadata in the background | group:B:capable | todo | — |
| 3 | 3.1 | Add regression coverage for pagination, totals, migration, and hydration | group:B:standard | todo | — |
| 3 | 3.2 | Run dry-run UI verification and finalize documentation | inline | todo | — |

## Goal

Make the GitHub tab paint its first page and real open totals quickly on busy repositories, then append later pages without re-fetching earlier rows. Move expensive body/diffstat/check/comment detail work behind background or on-demand hydration while preserving quiet degradation and the approved backward-compatibility migration.

## Scope

- `packages/cezar/src/server/forge/github.ts` and forge seam: GraphQL cursor pages, total counts, cached cursors, list/detail mapping.
- `packages/cezar/src/server/server.ts`, `packages/contract`, and route inventory/parity tests: validated additive query/response fields and detail body payload.
- `packages/web/src/api` and `packages/web/src/routes/github`: infinite paging, load-more/virtualized rows, count labels, background hydration and refresh behavior.
- `README.md`, `CHANGELOG.md`, and `BACKWARD_COMPATIBILITY.md`: body migration/deprecation and breaking-change callout.

## Non-goals

- Changes to GitHub search, checks, merge-state, PR changes, or tracker integrations beyond the list/detail data they consume.
- Visual redesign of the GitHub tab.
- New forge providers or persistent pagination state.

## Risks

- This changes a protected API field (`body`) from required list data to optional detail data; the issue explicitly approved the documented migration.
- Cursor pages, scoped route aliases, and the typed client must stay in parity.
- GitHub GraphQL availability and dry-run behavior must continue to degrade to usable empty/partial payloads.

## External references

- Issue: https://github.com/open-mercato/cezar/issues/1261
- No external skill URLs were supplied.
