# Execution plan — Delivered card numbers overflow

## Goal

Keep the dashboard's Delivered card readable when line counts grow large: `+193,753 −2…` currently truncates the deletions count.

## Scope

- `packages/web/src/routes/dashboard/insights.tsx` — the `Delivered` stat cells.
- Its unit test.

Non-goals: the backend insights payload, other dashboard widgets, CSV export (keeps exact values).

## Implementation Plan

Phase 1 — compact large counts and let the Lines pair wrap instead of truncating. Values ≥ 10,000 render compact (`193.7k`), with the exact value in a `title`; the `+`/`−` halves sit in a wrapping flex row so neither is clipped.

## Risks

- Low: presentational only; exact numbers stay available via tooltip and CSV export.

## Progress

PR: #1715

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Fit delivered counts

- [x] 1.1 Compact large counts and wrap the Lines pair — 4b8ad9465
