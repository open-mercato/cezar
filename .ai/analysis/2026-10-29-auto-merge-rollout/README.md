# Auto-merge rollout — who does what

Source: "Cezar: reguły automatycznego merge'owania PR-ów agentowych" (2026-10-27). This note splits its
"Zmiany do zrobienia w repo" checklist and rollout phases into **human-only** and **agent-deliverable**
work, and orders them. The implementation plans for the agent work are in [plans.md](plans.md).

## Verified state (2026-10-29, `main` @ `2c5cf2a57`)

| Claim in the doc | Checked | Result |
| --- | --- | --- |
| `publish-snapshot` runs PR code with `NPM_TOKEN` | `.github/workflows/ci.yml:148-190` | **Confirmed.** Same-repo PRs run `npm ci`, `npm run build` and the PR's own `scripts/release-snapshot.mjs` with `NODE_AUTH_TOKEN: secrets.NPM_TOKEN`. |
| No CODEOWNERS | `.github/` | Confirmed: no `CODEOWNERS` file. |
| No `merge_group` trigger | `ci.yml`, `codeql.yml` | Confirmed: `pull_request` + `push` only. |
| Allowlist drift in `CODE_REVIEW.md` | `packages/cezar/package.json` | Confirmed: `@clack/prompts`, `dotenv`, `undici` are runtime deps. |
| `SECURITY.md` supports 0.15.x | `SECURITY.md:10` | Confirmed stale; newest lines are `release/v0.16.x` and `release/v0.17.x`. |
| Open question: ruleset on `main` | `gh api repos/open-mercato/cezar/rulesets/16805903` | **Answered**, see below. |

The `main` ruleset as it stands now:

- **Has:** PR required, 1 approval, squash only, extra approval for unattributed changes, no deletion or force-push, and 4 required checks pinned to GitHub Actions (`integration_id` 15368): typecheck/build/E2E/package and the 3 vitest shards.
- **Missing compared with the doc:** strict status checks (`strict_required_status_checks_policy: false`, so a PR doesn't have to be up to date with `main`; that is how #1576 + #1689 landed green one by one and broke `main`), merge queue, code-owner review, dismissing stale approvals, last-push approval, CodeQL as a required check, signed commits.
- **Bypass:** the admin role can always bypass.
- **Repo setting:** `allow_auto_merge` is `false`. Classic branch protection on `main` is not set; the ruleset is the only guard.

## A correction the plans rely on

Splitting `publish-snapshot` into two jobs **inside `ci.yml`** does not close the hole. On a
`pull_request` event from a same-repo branch, the workflow file itself comes from the PR head, so a
PR can rewrite the "trusted" publish job to print the token. Only three things actually close it:
publish from a workflow the PR cannot edit (`workflow_run` on the default branch, consuming the
tarball as an artifact), a protected `environment` with required reviewers, or npm trusted
publishing (OIDC), which leaves no long-lived token to steal. The same reasoning applies to the
gate: a check computed by a workflow the PR can edit is not a trustworthy required check. The gate
must run as a **ruleset-required workflow pinned to `main`** or via `workflow_run`. Both are folded
into the plans (A1, A8).

## Triage

**H** = human only (needs org/repo admin, npmjs.com, secrets or a policy decision).
**A** = an agent delivers it as a PR. **A→H** = an agent prepares it, a human applies or approves
it. Under the doc's own rule (F7), every agent PR here touches the protected list, so **all of them
merge with human review**. None of them may go through auto-merge.

### Urgent (CI security)

| # | Item | Owner | Notes / workstream |
| --- | --- | --- | --- |
| U1 | Split `publish-snapshot`: build without secrets, publish separately from base-branch code | **A→H** | **A1.** Move publishing to a `workflow_run` workflow. Merged by a human. |
| U2 | Switch to npm trusted publishing (OIDC), delete `NPM_TOKEN` | **H** + A | Human: configure a trusted publisher on npmjs.com for each package (scoped, aliases, api-client) bound to the new workflow file, then delete the secret. Agent: the workflow side, in A1. |
| U3 | Disable snapshots for `cez/**`, or gate them behind an `environment` | **A** + H | Agent: the branch condition, in A1. Human: create the `npm-snapshot` environment with required reviewers. |

### GitHub settings and the `main` ruleset

| # | Item | Owner | Notes / workstream |
| --- | --- | --- | --- |
| G1a | `merge_group` trigger in `ci.yml` and `codeql.yml` | **A** | **A2.** Safe before the queue exists. Must land *before* G1b. |
| G1b | Turn on the merge queue | **H** | Repo admin, after A2 is on `main`. |
| G2 | Ruleset: strict checks, CodeQL required, code owners, stale dismissal, last-push approval, signed commits, review the admin bypass | **A→H** | **A2** writes the target ruleset as reviewed JSON (`.github/rulesets/main.json`) and an apply/diff script; a human runs `gh api … -X PUT`. Signed commits only after A11/G3, or human pushes will be blocked. |
| G3 | GitHub App for the agent (push to `cez/fix/*` only), plus a separate App/token for the gate's merge | **H** | Org admin: create both Apps, install them, store the keys as secrets. A2 documents the exact permissions. |
| G4 | Turn on "Allow auto-merge" and add the repo variable `AUTO_MERGE_ENABLED=false` | **H** | Repo admin. |
| G5 | Labels `auto-merge-pending`, `auto-merge-disagree`, `auto-merge-eligible` | **A→H** | Created by `gh label create` in A9, after a human approves the names. |

### Files in the repo

| # | Item | Owner | Notes / workstream |
| --- | --- | --- | --- |
| P1 | `.github/CODEOWNERS` covering the protected list | **A→H** | **A4.** Agent maps the paths; a human picks the owners (team vs people). |
| P2 | `.github/auto-merge-policy.yml` (thresholds, phase allowlist, protected list, labels) | **A→H** | **A4.** Thresholds are a maintainer decision; the agent seeds them from the doc (phase 2: 60 lines / 3 files). |
| P3 | Gate script: F1–F3, F5–F9, F12 | **A** | **A5.** Lives in `.github/scripts/auto-merge/` (covered by `.github/**`), not root `scripts/` (AGENTS.md keeps root `scripts/` for cross-workspace tooling). |
| P4 | `regression-proof` job (F4) | **A** | **A6.** |
| P5 | `auto-merge.yml` workflow (gate → reviewer → veto window → `--match-head-commit`) | **A** | **A8.** Shadow mode first: no merge permission until phase 2. |
| P6 | PR-title lint `type(scope): …` | **A** | Inside A5 as a zero-dependency regex rule rather than adding `commitlint` (a new dependency needs the review in CODE_REVIEW.md). |
| P7 | `SDLC.md` addendum (auto-merge path, labels, kill switch) | **A→H** | **A9.** Process change, so a human approves it. |
| P8 | Sync the `CODE_REVIEW.md` dependency allowlist and `SECURITY.md` versions | **A** | **A3.** Small and independent; can go today. |

### Reviewer (F11)

| # | Item | Owner | Notes / workstream |
| --- | --- | --- | --- |
| R1 | Reviewer prompt from `CODE_REVIEW.md` + `BACKWARD_COMPATIBILITY.md`, JSON verdict | **A** | **A7.** |
| R2 | Reviewer on a different model, no tools, no secrets other than the model key | **A** + H | Agent: the wiring (A7). Human: pick the model and vendor, add the API key secret scoped to the gate environment. |
| R3 | Adversarial suite that must be rejected 100% of the time | **A** | Deterministic cases in A5, LLM cases in A7. |

### Rollout and operations

| # | Item | Owner | Notes / workstream |
| --- | --- | --- | --- |
| O1 | Phase 1 shadow mode (≥30 candidate PRs, ≥90% agreement, 0 "gate merge / human blocker") | **H** | Humans keep merging and label disagreements. Agent: weekly metrics report, **A10**. |
| O2 | Phase 0 → 1 → 2 → 3 transitions, threshold changes | **H** | Always a maintainer decision (doc § Wdrożenie etapami). |
| O3 | Trust metrics + automatic kill switch (`AUTO_MERGE_ENABLED=false` on a stop threshold) | **A** + H | Agent: metrics script + stop workflow (**A10**). Human: a token allowed to write repo variables; re-enabling is always manual. |
| O4 | Pipeline issues only from trusted authors; strip HTML comments and hidden Unicode from issue text | **A** | Part of **A11** (cezar side) and A7 (reviewer input sanitizer, shared code). |
| O5 | Agent runtime isolation ("Rule of Two"): no secrets, network allowlist, narrow token | **H** + A | Human: where the fixer runs and with which credentials. Agent: document the runtime contract in A11's spec. |
| D1 | Cezar fix workflow ends with a run manifest + attestation | **A** (spec first) | **A11.** A product feature, so `om-auto-write-spec` comes first, then `om-auto-implement-spec`. |

## Order and dependencies

```
now ─┬─ A1 publish-snapshot (+H: npm trusted publisher, environment, delete NPM_TOKEN)
     ├─ A3 docs drift
     └─ A2 merge_group + ruleset-as-code ──► H: enable queue, apply ruleset
phase 0 ─┬─ A4 CODEOWNERS + policy (H picks owners/thresholds)
         ├─ H: GitHub Apps, allow auto-merge, AUTO_MERGE_ENABLED=false
         └─ A5 gate ──► A6 regression-proof ──► A7 reviewer ──► A8 workflow (shadow) + A9 SDLC/labels
phase 1 (shadow) ── A10 metrics; H labels disagreements, decides exit
phase 2 ── H flips AUTO_MERGE_ENABLED; A8's merge step activates (allowlist: web, workflows)
later ── A11 cezar run manifest + attestation (spec first)
```

Parallel-safe groups (disjoint files): {A1, A3, A4} first; A2 touches `ci.yml` like A1, so run it
after A1 merges or rebase it. A5 → A8 is one chain: dispatch them one after another, not in
parallel.
