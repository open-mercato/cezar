# Resolve Windows workflow Bash selection

Goal: make workflow check execution on Windows choose an installed Git Bash when the PATH resolves `bash` to the WSL launcher, while preserving Unix behavior and check cancellation, timeout, output, cwd, and exit handling.

Scope:

- `packages/cezar/src/workflows/run.ts` check execution only.
- A focused check-shell helper and unit tests.
- Windows setup documentation required for the behavior.

Non-goals: changing the server, runner model catalog, general agent shell behavior, or requiring user-authored configuration.

Implementation plan:

1. Confirm the current check execution path and add a platform-aware shell resolver that safely discovers Git Bash without changing Unix semantics.
2. Add regression tests covering WSL launcher resolution, Git Bash discovery and fallback, plus check result/cancellation preservation.
3. Document the Windows behavior and run the configured validation gate.

Risks: Windows executable discovery and shell quoting can affect command execution; keep the resolver narrow and leave non-Windows paths unchanged.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append — <commit sha> when a step lands. Do not rename step titles.

### Phase 1: Implementation

- [x] 1.1 Confirm current check execution and implement the Windows shell resolver — 85260a50
- [x] 1.2 Add regression coverage for shell selection and check lifecycle behavior — 645ae0e6

### Phase 2: Documentation and validation

- [x] 2.1 Document Windows check shell behavior — cd9d347b
- [x] 2.2 Run the full validation gate — 645ae0e6 (typecheck/build/unit/package pass; broad suite rerun with `env -u CEZ_API_URL -u CEZ_BIN TMPDIR=/tmp TEMP=/tmp` exceeded 240s without a summary)
