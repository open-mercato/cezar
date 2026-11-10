# Execution plan — CEZ_DRY_RUN=1 never spawns a real Codex/OpenCode CLI (#1898)

## Goal

Under `CEZ_DRY_RUN=1`, every runner in `runner-factory.ts` runs on a bundled mock. Before this fix, Codex and OpenCode ran on the real signed-in CLI. Their health checks and model catalogs stay off the real CLI too.

## Scope

- `resolveCodexExecutable` and `resolveOpencodeExecutable` fall back to new shipped mocks under dry-run (`scripts/mock-codex-app-server.mjs`, `scripts/mock-opencode-serve.mjs`). `OpencodeServerRunner` resolves through the latter.
- `probeCodex` / `probeOpencode` report `mock (CEZ_DRY_RUN=1)` like the other probes.
- A regression test runs every `RUNNER_IDS` entry under dry-run with stub agent binaries on `PATH`.
- Docs: `.env.example`, `docs/reference.md`, the mock-mode docs page.

## Non-goals

- The Cursor and Antigravity model catalogs and Cursor's account identity, which still call their real binaries under dry-run by design (`resolveCursorBin` comment). Reported as a follow-up.

## Risks

- `CEZ_CODEX_BIN` / `CEZ_OPENCODE_BIN` still win over the mock, so a QA stub keeps working.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Fix and regression test

- [ ] 1.1 Ship Codex/OpenCode mocks and route dry-run runs, probes and catalogs to them
- [ ] 1.2 Per-runner dry-run regression test, proven red without the fix
- [ ] 1.3 Update .env.example and docs
