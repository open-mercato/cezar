# Execution Plan — Guard nightly workflow against running on forks

**Goal:** Prevent the scheduled nightly workflow (`nightly.yml`) from executing and failing on forks by checking that the repository is the canonical upstream (`open-mercato/cezar`).

## Scope

- **Primary area:** `.github/workflows/nightly.yml`
- **Effects:** Forks of `open-mercato/cezar` with GitHub Actions enabled will skip the nightly publish job instead of failing on missing upstream secrets (`CEZ_TELEMETRY_SERVICE`, `NPM_TOKEN`). Upstream builds on `open-mercato/cezar:main` remain unaffected.
- **Non-goals:** Modify release scripts, alter npm publish logic, or disable workflows globally.

## Implementation Plan

### Phase 1: Workflow Guard and Validation

- [x] 1.1 Add `github.repository == 'open-mercato/cezar'` guard to job `nightly` in `.github/workflows/nightly.yml`
- [x] 1.2 Validate workflow YAML syntax and run repository verification checks

## Risks

- **Low risk:** A typo in the repository name would prevent nightly publishes on upstream. Mitigated by verifying against canonical `open-mercato/cezar`.

## Progress

PR: #1628

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Workflow Guard and Validation

- [x] 1.1 Add repository guard to nightly workflow — a219caba
- [x] 1.2 Validate workflow syntax and verification gate — 635cb44c
