<!--
  Template for SDLC.md, consumed by the cez-setup-pipeline skill.
  When generating the repo-local SDLC.md:
  - Replace {{baseBranch}}, {{tracker}}, and {{validationCommands}} with values
    resolved from .ai/agentic.config.json. Render {{validationCommands}} as a
    bullet list of the configured commands, in order.
  - Resolve every conditional block marked "IF <condition>" ... "END IF": keep
    the content when the config condition is true, delete it entirely when
    false, and strip the marker comments either way.
  - Delete this instruction comment from the generated file.
-->

# Software delivery process

## Purpose

This file documents how work flows from ticket to merged PR in this repository. The agent skills configured in `.ai/agentic.config.json` enforce the process; humans read it here. PRs target `{{baseBranch}}`; issues and PRs live in {{tracker}}, with every tracker operation the skills run defined in `.ai/trackers/{{tracker}}.md` (edit that file to extend or override tracker behavior).

Work enters through two paths: a free-form task brief handed to an agent, or a filed ticket. Both converge on the same review loop, the same validation gate, and the same merge gates.

## Roles

- **Author** — the human or agent who writes the change. Owns the ticket from claim to a merge-ready PR.
- **Reviewer** — reads the diff and approves or requests changes. May be a human or the `om-auto-review-pr` skill; the `cez-code-review` checklist applies either way.
<!-- IF qaGate -->
- **QA reviewer** — manually exercises user-facing changes before they merge. Always referenced by role, never by name or handle: assignments change.
<!-- END IF -->
- **Maintainer** — owns branch protection, the label taxonomy, the config, and this document; arbitrates when gates conflict.

## Ticket lifecycle

| Stage | What happens | Driven by | Done when |
|---|---|---|---|
| Intake | A ticket or task brief is filed in {{tracker}} with enough detail to act on. | Anyone | Ticket exists |
| Triage | Confirm the issue is real, still unfixed on `{{baseBranch}}`, and not already claimed or covered by an open PR. Read-only; stops the chain cleanly when there is nothing to do. | `cez-verify-in-repo` or a human | Confirmed actionable, or closed as no-action |
| Claim | The author claims the ticket so concurrent agents back off. See the claim protocol below. | `cez-fix` / `om-auto-create-pr`, or a human | Claim visible on the ticket |
| Implement | Locate the minimal change surface (`cez-root-cause`, read-only), then implement the change with regression tests and run the validation gate. Task briefs without a ticket go through `om-auto-create-pr`, which plans, implements phase by phase in an isolated worktree, and runs the same gate. | `cez-root-cause` + `cez-fix`, `om-auto-create-pr`, or a human author | Change complete, validation gate green |
| PR | Commit, push, and open a PR against `{{baseBranch}}` with normalized labels. On a hand-worked branch, `om-check-and-commit` runs the gate, fixes obvious drift, and pushes when green. | `om-open-pr`, `om-auto-create-pr`, or `om-check-and-commit` | Open, labeled PR |
| Review loop | The reviewer reads the diff against the `cez-code-review` checklist and approves or requests changes. Requested changes are addressed (`om-auto-continue-pr` resumes agent PRs from the tracking plan) and the PR is re-reviewed until approved. | `om-auto-review-pr` (single PR), `om-review-prs` (sweep), or a human | Approving review submitted |
<!-- IF qaGate -->
| QA | A PR carrying `needs-qa` waits for manual QA. A QA reviewer tests it and records the outcome. See the QA gate below. | QA reviewer (manual) | `qa-approved` applied, or `qa-failed` routes it back |
<!-- END IF -->
| Merge | `om-merge-buddy` reports, read-only, which PRs can merge now and which are close but blocked. `om-approve-merge-pr` re-checks every gate, approves, and squash-merges. | `om-merge-buddy` + `om-approve-merge-pr`, or a human | PR squash-merged into `{{baseBranch}}` |
| Post-merge housekeeping | Close issues the merged PR fixes; comment on issues whose PRs were closed without merging; turn leftover asks or review comments into tracked follow-up issues. | `om-close-fixed-issues`, `om-followup-issue-from-pr` | Tracker reconciled, follow-ups filed |

<!-- IF labels.enabled -->
## Label state machine

Pipeline labels are mutually exclusive: a PR carries at most one, and it names where the PR sits in the flow.

- A ready, non-draft PR carries `review`.
- The reviewer moves it: request changes → `changes-requested`; after fixes it returns to `review`; approval → `merge-queue`.
- `merge-queue` is routing, not proof of QA: a `needs-qa` PR legitimately sits there until QA signs off.
- Only a QA reviewer sets the `qa` pipeline label. They move a queued `needs-qa` PR from `merge-queue` to `qa` while testing, then back to `merge-queue` with `qa-approved` on pass, or to `qa-failed` on failure. Automated skills request QA with `needs-qa`; they never set `qa`.
- `blocked` and `do-not-merge` are set and cleared by humans and stop the flow wherever it is.

| Group | Labels | Exclusivity | Meaning |
|---|---|---|---|
| Pipeline | `review`, `changes-requested`, `qa`, `qa-failed`, `merge-queue`, `blocked`, `do-not-merge` | one at a time | Workflow state |
| Category | `bug`, `feature`, `refactor`, `security`, `dependencies`, `documentation` | additive | Kind of change |
| Meta | `needs-qa`, `skip-qa`, `qa-approved`, `qa-self-verified`, `in-progress` | additive | Process signals |
| Priority | `priority-low`, `priority-medium`, `priority-high`, `priority-extreme` | one at a time; unset = medium | Urgency of the work |
| Risk | `risk-low`, `risk-medium`, `risk-high` | one at a time; unset = medium | Blast radius of the change |

Priority is how urgent the work is; risk is how dangerous the change is to ship. A one-line fix for an outage can be `priority-extreme` and `risk-low`; a large auth refactor that can wait can be `priority-low` and `risk-high`. A PR inherits both from its source issue unless the scope clearly changed. When an automated skill adds or changes a pipeline or meta label, it leaves a short comment explaining why.

When no priority label is set, infer one:

- `priority-extreme` — production outage, data loss, or an active security incident.
- `priority-high` — security hardening or a release-blocking regression.
- `priority-medium` — ordinary bug fixes and net-new features (also the default reading of unset).
- `priority-low` — cosmetic, docs-only, dependency bumps, follow-up cleanup.

When no risk label is set, infer one:

- `risk-high` — auth, sessions, data scoping, money, schema migrations, shared contract surfaces, or broad cross-cutting edits.
- `risk-medium` — an ordinary single-area change that ships with tests (also the default reading of unset).
- `risk-low` — docs-only, test-only, typo, or isolated cosmetic changes.

When signals conflict, pick the higher label and say why in the label comment. A `risk-high` PR strengthens the case for `needs-qa` and deeper review even when it would otherwise look routine.

One label lives outside this taxonomy: `do-not-close`, applied by humans to issues that housekeeping skills must never auto-close. Skills only ever read it.
<!-- END IF -->

<!-- IF qaGate -->
## The QA gate

The one hard rule of this process: **a PR carrying `needs-qa` must not merge until it also carries `qa-approved`, even when every other check is green.** `om-merge-buddy` classifies such a PR as blocked; `om-approve-merge-pr` refuses to merge it.

- Apply `needs-qa` to UI changes, new features, and other user-facing behavior that needs manual exercise.
- `skip-qa` is the explicit opt-out for docs-only, dependency-only, CI-only, test-only, and similarly low-risk non-user-facing changes. Never combine it with `needs-qa`.
- `qa-failed`, `do-not-merge`, and `blocked` are hard blocks regardless of every other signal. An active `qa` pipeline label means a tester is on the PR right now — never merge under an active tester.
- The gate is satisfied when a QA reviewer tests the PR and applies `qa-approved`.
- **Self-QA exception**: when no QA reviewer has capacity in time, any engineer may sign off instead — but only by (1) checking the PR out and running it locally, (2) exercising the affected flow, and (3) attaching evidence to the PR: a screenshot of it working, or a written account of what was exercised and the observed result. Then apply both `qa-approved` (so the gate passes) and `qa-self-verified` (so the exception is auditable). No evidence, no `qa-approved`.
<!-- END IF -->

## The claim protocol

Before mutating an issue or PR, an agent claims it with all three signals: it assigns itself, adds the `in-progress` label, and posts a claim comment saying what it is doing. Any agent that finds an existing claim backs off instead of colliding. A PR carrying `in-progress` is also skipped by the merge tooling.

The claim is released when the work finishes — on success and on failure alike. A stale `in-progress` with no recent activity may be cleared by the maintainer.

## The automation contract

The `om-auto-*` skills run this process unattended and are chainable: each accepts the artifact the previous one produced (an issue id, a spec path, or a PR number from the `PR: #<number> (link: <url>)` reference line every PR-producing skill emits), and each detects work already started — an open PR referencing the issue or plan — and continues on it rather than opening a duplicate. A completed autonomous run leaves a **ready** (non-draft), fully labeled PR — one pipeline label, category, QA meta, one priority, one risk — with a run-summary comment and, for user-facing changes, screenshots from the working app attached as PR evidence. Draft PRs are reserved for explicitly incomplete states: spec-only design PRs, interrupted hand-offs, or autonomous defaults flagged for human confirmation. Automation never applies `qa-approved`.

## Validation gate

Every PR passes the full validation gate before review sign-off, in this order:

{{validationCommands}}

Any non-zero exit fails the gate and blocks the PR. The implementing skills run the gate before opening a PR, and `om-check-and-commit` runs it before pushing a hand-worked branch. The command list lives in `.ai/agentic.config.json`; when it changes, update it there and in this section together.

## Amending this process

This document and `.ai/agentic.config.json` describe the same process: change them together, and re-run the `cez-setup-pipeline` skill when the toolchain or label taxonomy changes. Per-skill deviations — extra review rules, a different PR body template, an added gate step — belong in a repo-local skill of the same name at `.ai/skills/<skill-name>/SKILL.md`, which takes precedence over the installed skill (and can `@`-import or reference it to extend rather than replace it); local rules win, but a repo-local skill cannot grant what the installed skill's safety rules forbid.
