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

- [x] 1.1 Lazy-load skill preview dialogs at first interaction in both source pickers, preserving close/reopen behavior. — dc17e0b2
- [x] 1.2 Add focused regression coverage for preview opening and dismissal. — dc17e0b2

### Phase 2: Defer optional shell surfaces

- [x] 2.1 Split the command-palette body from its eager opener and shortcut/event registrations. — 9c1a5248
- [x] 2.2 Lazy-load Add Project and Clone Project dialogs without changing their opener behavior or close animations. — 9c1a5248
- [x] 2.3 Add/update palette E2E coverage for first open, reopen, Cmd/Ctrl+K, N/c, and catalog links. — 9c1a5248

### Phase 3: Verify and ship

- [x] 3.1 Measure before/after entry and deduplicated entry-plus-preload raw/gzip sizes for each change independently. — dc17e0b2
- [ ] 3.2 Run focused tests, red-green regression proof, browser evidence, full validation gate, review, and finalize the PR. (Focused suites pass; `npm run typecheck`, `npm run build`, `npm run test:unit`, and `npm run test:package` pass. Full `npm test` has 16 unrelated baseline failures; browser provider unavailable; review handoff remains.)

## Measurement notes

- Issue baseline on `main` @ `3eb8e3ff`: entry `441.51 kB / 123.35 kB gzip`; entry plus 44 modulepreloads `1548.2 kB / 470.0 kB gzip`.
- Same-base measurements (all built with the checked-in lockfile and the same measurement script):
  - `9d21d6f1` base: entry `421,608 B / 115,375 B gzip`; entry plus 34 modulepreloads, deduplicated `1,648,133 B / 488,971 B gzip`.
  - Primary-only preview boundary: entry `417,425 B / 114,370 B gzip`; entry plus 46 modulepreloads, deduplicated `1,193,703 B / 352,292 B gzip`.
  - Combined final: entry `460,383 B / 127,678 B gzip`; entry plus 55 modulepreloads, deduplicated `1,184,590 B / 347,703 B gzip`.
  The primary-only graph emits a deferred `skill-detail` chunk and both picker modules no longer statically import it. The combined graph also emits separate `command-palette-body`, `add-project-dialog`, and `clone-project-dialog` chunks.

## Risks

- Lazy boundaries can accidentally remove keyboard/event registration or unmount a closing dialog too early; keep controller code eager and retain wrappers long enough for Radix close animations.
- Build output is affected by unrelated chunking, so measurements must be taken against the same base and report primary and secondary deltas separately.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Remove the Markdown leak

- [x] 1.1 Lazy-load skill preview dialogs at first interaction in both source pickers, preserving close/reopen behavior. — dc17e0b2
- [x] 1.2 Add focused regression coverage for preview opening and dismissal. — dc17e0b2

### Phase 2: Defer optional shell surfaces

- [ ] 2.1 Split the command-palette body from its eager opener and shortcut/event registrations.
- [ ] 2.2 Lazy-load Add Project and Clone Project dialogs without changing their opener behavior or close animations.
- [ ] 2.3 Add/update palette E2E coverage for first open, reopen, Cmd/Ctrl+K, N/c, and catalog links.

### Phase 3: Verify and ship

- [x] 3.1 Measure before/after entry and deduplicated entry-plus-preload raw/gzip sizes for each change independently. — dc17e0b2
- [ ] 3.2 Run focused tests, red-green regression proof, browser evidence, full validation gate, review, and finalize the PR.
