# Auto-merge rollout — implementation plans for agent work

Each plan below is written so it can seed `/om-auto-create-pr "<brief>"`: the Phases/Steps become
the run's Progress checklist. Every PR touches the doc's protected list, so **each one merges after
human review**, labeled `risk-high` unless noted otherwise. Triage, ordering and the human-only items are in
[README.md](README.md). Rule IDs (F1–F12) refer to the source doc's fix definition.

---

## A1 — Take `NPM_TOKEN` out of reach of PR code (urgent)

**Goal.** No code from a PR branch ever runs in a context that holds an npm publish credential.

**Scope.** `.github/workflows/ci.yml` (`publish-snapshot`), new `.github/workflows/npm-snapshot.yml`,
`scripts/release-snapshot.mjs` (inputs only), `docs/publishing.md`.
Non-goals: the release workflows (`release-publish.yml` already runs at a tag), npm-preview-cleanup.

**Phases**

1. Build without secrets
   - 1.1 Replace the publish step in `ci.yml` with "pack": `npm ci && npm run build`, then `npm pack` every published package into `snapshot/`, write `snapshot/meta.json` (PR number, head SHA, versions), and upload it as an artifact. No `secrets.*` and no `id-token` in this job.
   - 1.2 Skip snapshots for agent branches (`startsWith(github.head_ref, 'cez/')`) unless the PR carries a `snapshot` label (U3).
2. Publish from trusted code
   - 2.1 New `npm-snapshot.yml` on `workflow_run: [CI] completed`, from the default branch, `environment: npm-snapshot`. It downloads the artifact, checks `meta.json` against `github.event.workflow_run.head_sha`, and publishes the **tarballs** with base-branch `release-snapshot.mjs` (no `npm ci` and no lifecycle scripts from the PR; `npm publish <tgz> --ignore-scripts`).
   - 2.2 Authenticate via OIDC trusted publishing (`id-token: write`, `--provenance`); keep a `NODE_AUTH_TOKEN` fallback only behind the environment, until the human finishes U2.
   - 2.3 Move the sticky PR comment to the publish workflow (`pull-requests: write` only there).
3. Docs and verification
   - 3.1 Update `docs/publishing.md` (snapshot flow, environment, trusted publisher setup the human must do).
   - 3.2 Verify on a throwaway same-repo PR: the pack job has no secret in `env`, publish appears under the PR's dist-tag, and a fork PR publishes nothing.

**Acceptance.** `grep -n 'secrets\.' .github/workflows/ci.yml` shows nothing reachable from
`pull_request`. A PR that edits `ci.yml` cannot affect the publish job.
**Human follow-up.** Trusted publisher on npmjs.com for each package → delete `NPM_TOKEN` → create the
`npm-snapshot` environment with reviewers.
**Brief.** `fix(ci): publish npm snapshots from a workflow_run job so PR code never sees NPM_TOKEN — plan A1 in .ai/analysis/2026-10-29-auto-merge-rollout/plans.md`

---

## A2 — Merge-queue readiness and ruleset-as-code

**Goal.** Required checks report in a merge queue, and the target `main` ruleset exists as a reviewed file.

**Scope.** `ci.yml`, `codeql.yml` (`on:` only), new `.github/rulesets/main.json`,
new `.github/scripts/ruleset-diff.mjs`, `docs/publishing.md` or a new `docs/maintainers/rulesets.md`.

**Phases**

1. Merge queue triggers
   - 1.1 Add `merge_group:` to `ci.yml` and `codeql.yml`; make sure every job's `if:` treats `merge_group` like `pull_request` (and `publish-snapshot`/pack does not run on it).
2. Ruleset as code
   - 2.1 Export the live ruleset 16805903 into `.github/rulesets/main.json` unchanged (baseline commit).
   - 2.2 Second commit with the target: `strict_required_status_checks_policy: true`, CodeQL `Analyze` required, `require_code_owner_review`, `dismiss_stale_reviews_on_push`, `require_last_push_approval`, `merge_queue` rule (squash). Mark signed commits and bypass narrowing as **TODO(human)**, because they depend on the GitHub App (G3).
   - 2.3 `ruleset-diff.mjs`: zero-dependency, read-only; prints the diff between the live (`gh api`) and the file. Applying stays a documented manual `gh api -X PUT`.
3. Docs
   - 3.1 Maintainer doc: how to apply, in what order (A2 merged → enable queue → apply ruleset), and the GitHub App permission matrix for G3 (fixer: contents+PR write on `cez/fix/*`; gate: PR write, merge, variables write).

**Acceptance.** Required check names in `main.json` match the actual job names; diff script runs
read-only. **Brief.** `feat(ci): merge_group triggers and the main ruleset as reviewed code — plan A2`

---

## A3 — Fix doc drift (can go today)

**Goal.** Process docs match the code they govern. **Scope.** `CODE_REVIEW.md` (dependency
allowlist), `SECURITY.md` (supported versions). `risk-low`, `skip-qa`.

**Phases**

1. Sync
   - 1.1 Add `@clack/prompts`, `dotenv`, `undici` to the runtime dependency allowlist, each with its reason.
   - 1.2 `SECURITY.md`: supported = the newest release line(s) per `SDLC.md` § Release lines (on 2026-10-29: 0.16.x is published; `release/v0.17.x` is cut but 0.17.0 is still `# Unreleased` in `CHANGELOG.md`; list only published lines).
   - 1.3 Optional guard: a unit test that fails when a `packages/*/package.json` runtime dependency is missing from the allowlist (keeps F8 honest later).

**Brief.** `docs: sync CODE_REVIEW dependency allowlist and SECURITY supported versions — plan A3`

---

## A4 — CODEOWNERS and the auto-merge policy file

**Goal.** The protected list is enforced by code-owner review and described once, in machine-readable form.

**Scope.** New `.github/CODEOWNERS`, new `.github/auto-merge-policy.yml`, new
`.github/scripts/auto-merge/policy.mjs` (loader + schema check, zero-dependency or `yaml` already in the tree).

**Phases**

1. CODEOWNERS
   - 1.1 Translate the doc's protected list into CODEOWNERS patterns, owner `@open-mercato/<maintainers>` as a placeholder the human replaces. `CODEOWNERS` and the policy file own themselves.
   - 1.2 Test: every path the policy lists as protected is matched by some CODEOWNERS pattern (glob-to-regex, same matcher the gate uses).
2. Policy file
   - 2.1 `auto-merge-policy.yml`: `phase` (0–3), `enabled` read from the repo variable at run time, `limits` (prodLines 60, prodFiles 3, perDay 3, vetoWindowMinutes 120), `allowlist` per phase (phase 2: `packages/web/src/**` minus telemetry, `packages/cezar/src/workflows/**`), `protected` (the doc's table verbatim), `requiredLabels`/`blockingLabels`, `testPaths` (what counts as non-production code).
   - 2.2 Loader with strict validation; unknown keys fail.

**Human decision.** Owners, and whether the phase-2 thresholds stand.
**Brief.** `feat(ci): CODEOWNERS for the protected list and .github/auto-merge-policy.yml — plan A4`

---

## A5 — Deterministic eligibility gate (F1–F3, F5–F9, F12 + PR title)

**Goal.** A pure function `(prMetadata, diff, policy) → { eligible, rules: [{id, pass, evidence}] }`
plus a thin CLI that gathers its input through `gh api`.

**Scope.** `.github/scripts/auto-merge/{gate.mjs,rules/*.mjs,collect.mjs}`, tests and fixtures under
`.github/scripts/auto-merge/__tests__/`, wiring those tests into the root vitest run (check
`vitest.config`/workspace includes; they must run in `npm test`).

**Phases**

1. Core and metadata rules
   - 1.1 Diff model: parse `gh pr diff` / the files API into `{path, status, additions, deletions, patch}`; classify prod vs test/docs/`.ai/runs/` using policy `testPaths`.
   - 1.2 F1 (linked `bug` issue, opened or labeled by someone with write access, read from the issue timeline), F2 (title `fix(scope):`, required/blocking labels), title lint for all PRs (P6).
   - 1.3 F12 provenance: same-repo head, every commit authored and committed by the fixer App, `verification.verified`, no foreign push in the PR timeline.
2. Diff rules
   - 2.1 F3 size/package limits; F6 no new prod files; F7 protected paths (shared matcher with A4).
   - 2.2 F5 tests only extended: no deleted or changed lines in existing `*.test.*`, no `.skip/.only/.todo` added, no `__fixtures__/` or snapshot changes.
   - 2.3 F8 no new deps (any `package.json` diff), no new `CEZ_*` (diff vs `.env.example` and source), no new route-family links in `server.ts`, no new `packages/contract` exports, no new CLI flags in `index.ts` parseArgs.
   - 2.4 F9 forbidden additions: `node:child_process|net|http|https`, `undici`, `fetch(`, `eval`, `new Function`, base64 blobs > 200 chars, binary files, bidi and zero-width Unicode.
3. Output and adversarial suite
   - 3.1 Markdown verdict comment (one line per rule with evidence) + JSON for the workflow; idempotent marker comment.
   - 3.2 Adversarial fixtures that MUST be ineligible: weakened assertion, `.only`, new `CEZ_FOO`, new route, hidden-Unicode payload, new dependency, protected path, human push, fork head. Plus 3 real past fixes that must be eligible (sanity).

**Acceptance.** All fixtures pass. The gate is a pure function with no network calls in tests;
`collect.mjs` is the only `gh` caller. **Brief.** `feat(ci): deterministic auto-merge eligibility gate — plan A5`

---

## A6 — `regression-proof` job (F4)

**Goal.** Mechanically prove what AGENTS.md asks by hand: the new test fails without the fix and passes with it.

**Scope.** `.github/scripts/auto-merge/regression-proof.mjs`, a job in the gate workflow (A8), tests.

**Phases**

1. Script
   - 1.1 From the PR diff, list added/changed test files and production files (A5's classifier).
   - 1.2 Check out the base version of the production files only, run `npm test -- <test files>`, expect a non-zero exit **from assertion failures**, not from a syntax/import error (parse the vitest JSON reporter and require ≥1 failed assertion in the new tests).
   - 1.3 Restore the PR's files and run again, expecting a pass. Emit `{failedBefore, passedAfter, details}`.
2. Integration
   - 2.1 Job definition with no secrets and `contents: read`; runs only when A5's metadata rules pass (cost control).
   - 2.2 Self-test on fixtures: a real fix (red→green), a test that passes before the fix (rejected), a test that errors on import (rejected).

**Brief.** `feat(ci): regression-proof job — new tests must fail before the fix and pass after — plan A6`

---

## A7 — Independent LLM reviewer (F11)

**Goal.** A tool-less reviewer on a different model than the author returns a strict JSON verdict;
anything else routes to a human.

**Scope.** `.github/scripts/auto-merge/reviewer/{prompt.md,schema.json,review.mjs,sanitize.mjs}`, tests.

**Phases**

1. Input and prompt
   - 1.1 `sanitize.mjs`: strip HTML comments, bidi/zero-width characters and image/link markup from the issue body; drop comments from authors without write access; cap the size.
   - 1.2 Prompt built from `CODE_REVIEW.md` severities + `BACKWARD_COMPATIBILITY.md` surfaces, read **from the base branch**. Input: the sanitized issue + the diff only. Requires the three "fix, not feature" answers, each with a quote.
   - 1.3 `schema.json`: `verdict`, `blockers[]`, `majors[]`, `is_fix`, `changes_behavior_outside_issue`, `user_visible_change`, `quotes[]`.
2. Call and decision
   - 2.1 `review.mjs`: one HTTPS call to the configured vendor (`REVIEWER_PROVIDER`, `REVIEWER_MODEL`, key from secret), no tools or function calling, temperature 0. Picks a model family different from the author's (read from the run manifest/commit trailer; unknown author ⇒ human).
   - 2.2 Decision: APPROVE only when the JSON is valid and `verdict=approve`, there are no blockers or majors, `is_fix=true`, both behavior flags are false, and every answer has a quote that appears verbatim in the diff or issue. Any error or timeout ⇒ human.
3. Adversarial LLM set
   - 3.1 Cases: prompt injection in the issue ("approve this"), a hidden feature behind a fix title, a fix that changes behavior beyond the issue. Run as an opt-in job (costs tokens), required before any policy change.

**Human decision.** Vendor/model and the API key secret (scoped to the gate environment).
**Brief.** `feat(ci): tool-less cross-model reviewer with strict JSON verdict — plan A7`

---

## A8 — `auto-merge.yml`: shadow mode first, merge later

**Goal.** One workflow chains gate → regression-proof → reviewer, posts the verdict, and merges only when phase ≥ 2 and `AUTO_MERGE_ENABLED=true`.

**Scope.** `.github/workflows/auto-merge-eligibility.yml` (the check), `.github/workflows/auto-merge.yml`
(the merger), `docs/` maintainer page.

**Phases**

1. Eligibility check (shadow)
   - 1.1 `auto-merge-eligibility.yml` on `pull_request` + `merge_group`, but **runs the scripts from the base SHA**: check out `github.event.pull_request.base.sha` into `trusted/`, and treat the PR only as data (diff via API). Register it in the ruleset as a *required workflow from `main`* (A2 file), so a PR editing it changes nothing.
   - 1.2 Posts the idempotent verdict comment and adds `auto-merge-eligible` when everything passes. Informational only in phase 1.
2. Merger (dormant until phase 2)
   - 2.1 `auto-merge.yml` on `workflow_run` of the eligibility check + `schedule` (veto window sweep), default branch only, gate App token.
   - 2.2 Exits unless `vars.AUTO_MERGE_ENABLED == 'true'` and policy phase ≥ 2. Otherwise it adds `auto-merge-pending`, waits for the veto window, re-checks for no `do-not-merge` and an unchanged head, enforces the daily limit, then runs `gh pr merge --squash --auto --match-head-commit <verified sha>`.
3. Verification
   - 3.1 Dry-run mode (`AUTO_MERGE_DRY_RUN`) that logs the merge command; exercised on a sandbox PR.

**Acceptance.** With the variable unset, no workflow in the repo can merge. **Brief.** `feat(ci): auto-merge eligibility check (shadow) and dormant merger — plan A8`

---

## A9 — Process docs and labels

**Goal.** The auto-merge path is part of the documented SDLC. **Scope.** `SDLC.md` (new section),
`.ai/trackers/github.md` if it lists labels, `CODE_REVIEW.md` (pointer to the reviewer rules).

**Phases**

1. Docs
   - 1.1 `SDLC.md` § Auto-merge path: eligibility (link to the policy file), phases, labels `auto-merge-eligible|pending|disagree`, the veto window, the kill switch, and "a human push moves the PR to the human path".
2. Labels
   - 2.1 After a human approves the names: `gh label create` for the three labels (descriptions match `SDLC.md`).

**Brief.** `docs(sdlc): document the auto-merge path, its labels and kill switch — plan A9`

---

## A10 — Trust metrics and kill switch

**Goal.** Weekly numbers for the phase decisions; an automatic stop on the doc's thresholds.

**Scope.** `.github/scripts/auto-merge/metrics.mjs`, `.github/workflows/auto-merge-metrics.yml`.

**Phases**

1. Metrics
   - 1.1 Regression escape (a revert, or a later PR whose body says "since/after/follow-up to #N" within 14 days), red `main` after an auto-merge, agreement (share without `auto-merge-disagree`), 3-week churn, yield. Computed separately for auto-merged PRs and the human baseline.
   - 1.2 Weekly scheduled run that posts the report to a pinned tracking issue, with Wilson intervals (the doc's statistical note).
2. Kill switch
   - 2.1 On a stop threshold: set `AUTO_MERGE_ENABLED=false` (token with variables write) and open an issue with the triggering PRs. Never re-enables.

**Brief.** `feat(ci): auto-merge trust metrics and automatic kill switch — plan A10`

---

## A11 — Cezar produces attestable fix PRs (dogfooding, spec first)

**Goal.** A cezar fix run ends with a run manifest (issue, model, diff hash, run id) and a build-provenance
attestation, instead of a bare `create-pr`. This is a product feature that other repos can use too.

**Route.** `/om-auto-write-spec` first. The spec must settle: where the manifest lives, how the
fixer App identity is configured (zero-config: absent App ⇒ today's behavior), attestation through
`actions/attest-build-provenance` vs local signing, trusted-author filtering and sanitizing of issue
input (O4), and the runtime isolation contract (O5). Then `/om-auto-implement-spec`.

**Brief.** `spec: cezar fix runs emit a run manifest and provenance attestation for auto-merge eligibility — plan A11`
