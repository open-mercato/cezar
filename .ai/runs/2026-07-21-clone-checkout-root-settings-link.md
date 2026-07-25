# Execution plan — clone checkout-root settings link

Status: complete

Source doc: .ai/specs/2026-07-21-clone-checkout-root-settings-link.md
Issue: #561
PR: #571

## Goal

Add an accessible cog link beside the clone destination preview that opens Global
settings → Projects, without changing clone behavior or the workspace API.

## Scope

- Update only the clone dialog's target-preview affordance and its unit coverage.
- Use the existing plain global-settings route and shared icon-button primitives.
- Keep #567 cache refresh, APIs, settings persistence, and clone workflow behavior out
  of scope.

## Implementation Plan

### Phase 1: Clone-dialog shortcut

1.1 Add the accessible settings icon control and responsive target-preview layout.
1.2 Add unit coverage for its exact destination, accessible name, and pending state.

### Phase 2: Verification and delivery

2.1 Run targeted validation, remove scope creep, and commit the implementation.
2.2 Run the complete repository gate and both review passes; normalize the existing PR.

## Risks

- A scope-aware link could incorrectly prefix the global route. Mitigation: use React
  Router's plain `Link` and assert the exact href.
- An active link during checkout could abandon a pending operation. Mitigation: render a
  disabled button instead of a link while the mutation is pending and cover it in tests.
- Narrow target paths could displace the affordance. Mitigation: make the path flex and
  truncate while the icon remains fixed-size.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

PR: #571

### Phase 1: Clone-dialog shortcut

- [x] 1.1 Add the accessible settings icon control and responsive target-preview layout. — b4e9704
- [x] 1.2 Add unit coverage for its exact destination, accessible name, and pending state. — b4e9704

### Phase 2: Verification and delivery

- [x] 2.1 Run targeted validation, remove scope creep, and commit the implementation. — b4e9704
- [x] 2.2 Run the complete repository gate and both review passes; normalize the existing PR. — 2907cf4
