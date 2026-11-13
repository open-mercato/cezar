# Remove vulnerable KaTeX through its parent dependency

Goal: remove Dependabot alert 38's vulnerable KaTeX path from the cockpit dependency graph through a compatible Streamdown upgrade.

Security-Source: open-mercato/cezar:dependabot:38
Security-Fingerprint: GHSA-238p-pmpm-9mq7:katex:package-lock.json
Engine: om-auto-create-pr (steps: 4, --loop: no)

## Scope

Upgrade packages/web's Streamdown 2.5.0 to the first compatible 2.6.0 release that removes its Mermaid dependency. Keep the existing custom Mermaid renderer. Update the npm workspace manifest and root lock consistently. Verify installed dependency removal, Markdown/Mermaid consumers and the full configured gate. This uncovered alert is not remediated by PR1253: its immutable head still locks KaTeX0.16.47. Other source alerts retain their existing PR/block dispositions.

Non-goals: other dependency upgrades, Cargo changes, API/default/env changes, issues, merging, auto-merge, alert dismissal, advisories, settings or workflow changes.

## Ownership and authorization

The operator explicitly requested autonomous continuation after the missing-claim-operation blocker. Use the already-installed canonical GitHub template's get-lock/acquire-lock/release-lock functions in a temporary shell helper for this occurrence, keeping atomic ownership and all secondary checks. Do not edit the repository descriptor/settings/workflows. The continuation supersedes the earlier implementation stop for this run only; it does not change future automation defaults or waive review/QA. Reuse the invoking isolated task worktree. Claim the new PR immediately after the initial plan-only draft is created. Recheck source and foreign claims before publication.

## Implementation plan

### Phase 1: Parent dependency and focused proof

1.1 Install the original lock and capture the vulnerable parent path and before behavior.
1.2 Upgrade only Streamdown and required transitive graph changes; verify target removal and Markdown/Mermaid behavior.

### Phase 2: Verification and independent review

2.1 Run every configured validation command in order, plus relevant consumer/integration and dependency-resolution checks; record exact results and baseline limitations.
2.2 Push the finished change and obtain the final independent om-auto-review-pr verdict; update evidence, labels and draft readiness without bypassing QA.

## Risks

Independent review approves exact67ddebd1 with no findings. All implementation/automated-evidence work is complete. Per explicit task instruction the PR stays draft pending manual QA and eligible native approval; no ready promotion or gate bypass. Native self-approval was rejected and actual review is COMMENTED. Final main manager-only advance51bfc464 does not overlap; no post-review source changes.

Verification evidence: .ai/runs/2026-11-13-dependabot38-verification.md. The upgraded parent adds default scroll limits; compatibility props0 and a red/green guard preserve cezar's full-height layout. Browser baseline and fixed graph both have17passes/6identical pre-existing selector failures; all five configured gates pass.

Streamdown's renderer is bundled into the cockpit, so existing Markdown, streaming, hard-break and Mermaid rendering must remain covered. Parent upgrade may change required transitive dependencies; avoid unrelated lockfile refresh. A removed package is only removal proof if both the complete lock and physical installed graph agree. No assertion of exploitability in cezar is made. Keep draft on incomplete validation/review. The latest release line v0.19.x must receive a backport decision after comparing its dependency path. The npm age policy will be preserved if one is present; none was found in current npm configuration/manifests.

## Progress
PR: #2163

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Parent dependency and focused proof

- [x] 1.1 Install the original lock and capture the vulnerable parent path and before behavior. — 04a6189b
- [x] 1.2 Upgrade only Streamdown and required transitive graph changes; verify target removal and Markdown/Mermaid behavior. — 04a6189b

### Phase 2: Verification and independent review

- [x] 2.1 Run every configured validation command in order, plus relevant consumer/integration and dependency-resolution checks; record exact results and baseline limitations. — cb043ee5
- [ ] 2.2 Push the finished change and obtain the final independent om-auto-review-pr verdict; update evidence, labels and draft readiness without bypassing QA.
