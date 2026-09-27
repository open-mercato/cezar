# Verify server-install instance identity (#1008)

Goal: make the server-install verification gate prove that the responding cezar is this install's instance, without breaking older state files or older service processes.

Scope: server-install state/service environment and Ubuntu verification; health contract/handler; focused regression tests and compatibility notes.

Non-goals: changing proxy authentication, macOS ngrok routing, workflow/dispatch/automation code, or live installations.

## Implementation Plan

### Phase 1: Identity plumbing

- [ ] 1.1 Add a persisted install identity and pass it to generated service environments.
- [ ] 1.2 Add the identity as an additive health response field.

### Phase 2: Verification and evidence

- [ ] 2.1 Compare the authenticated health payload during Ubuntu installation verification, degrading safely when unavailable.
- [ ] 2.2 Add regression and compatibility tests, run targeted validation, and update compatibility documentation if required.
- [ ] 2.3 Run the full configured validation gate and finalize the PR.

## Risks

- Existing installs and state files may not have an identity; verification must remain inconclusive rather than fail solely because the field is absent.
- The health endpoint is externally consumed, so the field must be additive and must not expose paths or credentials.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append — <commit sha> when a step lands. Do not rename step titles.

### Phase 1: Identity plumbing

- [ ] 1.1 Add a persisted install identity and pass it to generated service environments.
- [ ] 1.2 Add the identity as an additive health response field.

### Phase 2: Verification and evidence

- [ ] 2.1 Compare the authenticated health payload during Ubuntu installation verification, degrading safely when unavailable.
- [ ] 2.2 Add regression and compatibility tests, run targeted validation, and update compatibility documentation if required.
- [ ] 2.3 Run the full configured validation gate and finalize the PR.
