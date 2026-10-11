# Defer optional UI downloads until first use

## Goal

Resolve #1219 by removing the eager Markdown/Streamdown dependency from skill previews and deferring optional command-palette body and project-dialog code while preserving keyboard shortcuts, navigation, catalog links, and close animations.

## Scope

- `packages/web/src/components/source-pill.tsx` and `agent-task-pickers.tsx`: first-interaction-gate `SkillPreviewDialog` with a lazy import while retaining the mounted preview wrapper for close behavior.
- `packages/web/src/components/command-palette.tsx` plus a body module: keep the eager opener/controller and shortcut/event seam, lazy-load the palette body.
- `packages/web/src/components/app-shell.tsx` and `app-shell-container.tsx`: lazy-load project dialogs and preserve the permanent palette controller.
- Focused component tests and palette E2E coverage; build-size measurements separately attribute the primary and secondary reductions.

## Non-goals

- No route, server, dependency, workflow, broad chunk-graph, Lucide, or cmdk changes.
- Do not edit `packages/web/src/routes.test.tsx`.

## Implementation Plan

### Phase 1: Remove the Markdown leak

- [x] 1.1 Lazy-load skill preview dialogs at first interaction in both source pickers, preserving close/reopen behavior. — 4e014ed7
- [x] 1.2 Add focused regression coverage for preview opening and dismissal. — 4e014ed7

### Phase 2: Defer optional shell surfaces

- [x] 2.1 Split the command-palette body from its eager opener and shortcut/event registrations. — 9c1a5248
- [x] 2.2 Lazy-load Add Project and Clone Project dialogs without changing their opener behavior or close animations. — 9c1a5248
- [x] 2.3 Add/update palette E2E coverage for first open, reopen, Cmd/Ctrl+K, N/c, and catalog links. — 9c1a5248

### Phase 3: Verify and ship

- [x] 3.1 Measure before/after entry and deduplicated entry-plus-preload raw/gzip sizes for each change independently. — 9bc16731
- [ ] 3.2 Run focused tests, red-green regression proof, browser evidence, full validation gate, review, and finalize the PR. (Focused suites and most gate commands pass; full npm test has 16 unrelated baseline failures and browser provider was unavailable.)

## Measurement notes

- Issue baseline on `main` @ `3eb8e3ff`: entry `441.51 kB / 123.35 kB gzip`; entry plus 44 modulepreloads `1548.2 kB / 470.0 kB gzip`.
- Final build on this branch: entry `460,174 B / 127,574 B gzip`; deduplicated entry plus 54 modulepreloads `1,184,067 B / 362,212 B gzip`.
- The repository's base moved substantially between those builds, so these are reported as raw artifacts rather than an attributed delta. The final graph contains separate `command-palette-body`, `add-project-dialog`, `clone-project-dialog`, and `skill-detail` chunks; Markdown is no longer statically imported by `skill-detail`.

## Risks

- Lazy boundaries can accidentally remove keyboard/event registration or unmount a closing dialog too early; keep controller code eager and retain wrappers long enough for Radix close animations.
- Build output is affected by unrelated chunking, so measurements must be taken against the same base and report primary and secondary deltas separately.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Remove the Markdown leak

- [ ] 1.1 Lazy-load skill preview dialogs at first interaction in both source pickers, preserving close/reopen behavior.
- [ ] 1.2 Add focused regression coverage for preview opening and dismissal.

### Phase 2: Defer optional shell surfaces

- [ ] 2.1 Split the command-palette body from its eager opener and shortcut/event registrations.
- [ ] 2.2 Lazy-load Add Project and Clone Project dialogs without changing their opener behavior or close animations.
- [ ] 2.3 Add/update palette E2E coverage for first open, reopen, Cmd/Ctrl+K, N/c, and catalog links.

### Phase 3: Verify and ship

- [ ] 3.1 Measure before/after entry and deduplicated entry-plus-preload raw/gzip sizes for each change independently.
- [ ] 3.2 Run focused tests, red-green regression proof, browser evidence, full validation gate, review, and finalize the PR.
