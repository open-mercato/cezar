# Multiple schedules sharing an automation

Source doc: .ai/specs/2026-09-14-automations-redesign.md (amendment in design PR #1863)
Issue: #1818
Engine: om-auto-create-pr (steps: 5, --loop: no)

## Goal and scope

One scheduled automation holds up to 16 timed schedules and one task. Preserve old records,
legacy replacement writes, single-once deferred tasks, one receipt per instant and bounded catch-up.
Parent owns server.ts, api/client.ts and BACKWARD_COMPATIBILITY.md; their minimal boundary changes
are coordinated through the tree inbox. No changes to other issue scopes or shared configuration.

## Implementation Plan

1. Bounded optional list, mirror rules, union helpers, compatible store writes and due invalidation.
2. Union scheduling, newest bounded catch-up, receipt and lease integration evidence.
3. Parent-owned HTTP validator/projection/arming and compatibility note; old client boundary tests.
4. Editor add/edit/remove; union previews/calendar/rail/labels; templates/duplicate/CLI preservation.
5. Red/green proof, all five gates, code review/autofix, browser evidence and exact-head CI.

## Risks

Additive persisted/API scheduling change is risk-high. Old versions execute only the first mirrored
entry. No base merges or pushes. Local Windows full-suite/platform limits must remain visible.

## Progress

### Phase 1: compatible scheduling

- [x] 1.1 Bounded list, union helpers, compatible writes and due invalidation — 86945326
- [x] 1.2 Union runner and bounded catch-up with receipt/lease evidence — 86945326
- [x] 1.3 HTTP boundary and compatibility note (parent-owned) — 9caaf696

### Phase 2: editor and verification

- [x] 2.1 Editor groups and all union/copy/template consumers — b16b5926, 3ca31821
- [ ] 2.2 Full validation, review, browser QA and exact-head CI

