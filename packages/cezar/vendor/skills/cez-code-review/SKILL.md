---
name: cez-code-review
description: Reviews a diff or branch for correctness, security, compatibility, test coverage, and maintainability using a complete severity-ranked checklist and an approve/request-changes verdict.
---

## Cezar external-conductor mode

When the caller supplies a Cezar wrapper/phase contract, it is authoritative:
Cezar owns sequencing, issue claims and tracker state, the final validation
gate, review reconciliation, staging, and delivery. Skip setup/claim/delivery
steps owned by that conductor. Execute the complete technical judgment and
implementation workflow below within the phase boundary; do not commit, push,
publish, or open/merge a pull request.


# Code Review

Review code changes against the repository's architecture, security, convention, and quality standards. Produce actionable, categorized findings and a clear merge verdict.

## Contract

**Input** — exactly one unit of review:

- a pull-request diff and metadata made available by the caller,
- a branch name (review its diff against the merge-base with `$BASE_BRANCH`),
- an explicit commit range or diff,
- nothing — default to the current branch's diff against the merge-base with `$BASE_BRANCH`, including uncommitted changes.

**Output** — a review report in the format below, containing:

- a validation-gate table with the real pass/fail result of every configured command,
- findings grouped by severity (**blocker / major / minor / nit**), each with file, line, rationale, and a concrete fix suggestion,
- a breaking-change checklist,
- a verdict: **approve** or **request changes** (see Severity and Verdict).

Callers (`the automated review stage`, `the batch review workflow`, the self-review step of `the implementation workflow` and `the continuation workflow`) consume the verdict and the blocker/major findings; keep both unambiguous.

## Review Workflow

0. **Project setup** — follow `references/agentic-setup.md`; use the repository and phase context supplied by the caller. Missing optional config degrades to discovery and never triggers another setup workflow.

1. **Scope**: Identify changed files. Classify each by layer (HTTP handler or route, data model or schema, migration, validation, UI component or page, background job or consumer, CLI, config, build/codegen, test).
2. **Gather context**: Read the repository's agent instructions and contributing docs for each touched area. Read design docs or architecture notes when the repo keeps them, plus any known-pitfalls notes the team maintains.
3. **Validation evidence**: Use the caller/conductor's real validation results when supplied. Otherwise run the repository's configured commands. Never duplicate an expensive immutable gate that the conductor owns.
4. **Breaking-change gate**: Check every changed file against the breaking-change checklist: exported APIs, HTTP routes and response shapes, event names, CLI flags, DB schema, config formats. Flag violations as **blocker**. If the project documents its own compatibility policy, apply it on top. See **Breaking Changes** in the Quick Rule Reference.
5. **Run the checklists**: Apply all applicable sections of `references/review-checklist.md`. When `reviewChecklist` is set in the config, read that repo-local file and apply it IN ADDITION to the built-in checklist; do the same with `CODE_REVIEW.md` from the repo root when it exists — repo-local rules extend the built-in ones, never replace them. When `BACKWARD_COMPATIBILITY.md` exists at the repo root, check every touched surface against it: a change that breaks a protected surface without following the documented deprecation/migration path is a Critical finding, and the report must explicitly WARN the user about it. Flag violations with severity, file, line, and fix suggestion.
6. **Test coverage**: Verify changed behavior is covered by unit tests and/or integration tests. If coverage is missing, flag it with severity, file references, and the exact test cases to add.
7. **Cross-boundary impact**: If the change touches events, messages, shared contracts, or extension points, verify the consuming side still handles the contract correctly.
8. **Output**: Produce the review report in the format below and state the verdict.

## Validation Gate (MANDATORY)

**Never claim code is ready without real validation evidence.** In externally conducted runs, the conductor's recorded gate is authoritative; in standalone reviews, run the repository's configured validation commands.

### Rules

- Run commands in the configured order. Commands that are independent of each other's outputs (typically typecheck and unit tests) may run in parallel to save time.
- If a configured command regenerates files (codegen, formatting, lockfile maintenance), include the regenerated files in the review scope and rerun the downstream gates.
- **Every failure is a finding**: if a gate command fails, it is a **blocker** finding — even if the failure appears unrelated to the current changes. If it fails on this branch, it will fail in CI regardless of whose fault it is.
- **No excuses**: "pre-existing on the base branch", "flaky test", "not our code" are not valid reasons to skip. Fix it or flag it as a blocker.
- **Evidence required**: the review output MUST include the actual pass/fail result of each gate command. Do not assume — run the commands and report what happened.

## UI Performance Gate

For changes touching web routes, shared providers, the application shell, or heavy interactive widgets, the reviewer has blocking power for performance regressions. Request changes when any of these are true:

- a server-rendered route or component became client-rendered without a documented reason,
- a route entry point became one large client-side blob instead of a server-rendered shell with small interactive islands,
- global providers or app bootstrap now import route-specific dashboards, editors, calendars, graphs, or third-party SDKs that only one route needs,
- bundle or runtime footprint grows without measurement, explanation, and explicit acceptance,
- changed interactions lack tests or documented manual verification for loading state, error state, and accessibility.

Add any bundle/runtime evidence the author provided (or note its absence) to the review summary. Skip this section for repositories without a web frontend.

## Output Format

Produce the review report using the exact structure in
`references/output-format.md` — the `# Code Review` heading with Summary,
Verdict, the Validation Gate table, Findings grouped by severity, the
Breaking-Changes checklist, and Test Coverage. Omit empty severity sections; mark
passing checklist items with `[x]` and failing with `[ ]` plus an explanation.

## Severity and Verdict

| Severity | Criteria | Action |
|----------|----------|--------|
| **blocker** | Security vulnerability, data corruption or loss risk, cross-scope data leak, missing permission check, breaking contract change without a deprecation path, failing validation gate | MUST fix before merge |
| **major** | Correctness bug on a realistic path, missing regression test for a bug fix, weakened assertions, unbounded query on growing data, unresolved race on shared state, architecture violation | MUST fix before merge unless the maintainer explicitly accepts and documents the risk |
| **minor** | Convention violation, suboptimal pattern, missing best practice, readability problem | Should fix; does not block on its own |
| **nit** | Style suggestion, optional polish | Author's call |

Verdict rule:

- Any **blocker** → **request changes**. No exceptions.
- Any **major** without an explicit, documented waiver → **request changes**.
- Only minors and nits → **approve**, listing them so the author can pick them up.

## Quick Rule Reference

These are the highest-impact rules. For the full checklist, see `references/review-checklist.md` (plus the repo-local checklist when `reviewChecklist` is configured).

### Breaking Changes (blocker)

- **MUST NOT remove or rename** any public contract surface silently: exported APIs, HTTP routes and response shapes, event names, CLI flags, DB schema, config formats.
- **Deprecate first**: mark the old surface deprecated → keep a working bridge (re-export, alias, dual-emit, redirect) for a documented window → remove later.
- **Additive-only data changes**: new columns and fields with defaults are safe; rename, remove, or narrow is breaking.
- **Payloads and responses**: may add optional fields; MUST NOT remove or retype existing fields.
- When the project documents its own compatibility policy, a violation of that policy is a blocker too.

### Security (blocker)

- **Validate all inputs at the trust boundary** with a schema — never trust raw input.
- **Every endpoint and handler enforces authentication and permission checks server-side** — UI-only checks are not checks.
- **Authorization covers the specific record**, not just the role: can this caller act on THIS object?
- **Data scoping**: every query on scoped data filters by the owning scope (user, account, workspace); list endpoints, exports, and search must not leak across scopes.
- **Secrets never committed, logged, or echoed** in error messages or client responses.
- **Passwords hashed with a slow, salted hash**; auth errors reveal nothing about account existence.
- **Untrusted input never concatenated** into queries, shell commands, or file paths.

### Data Integrity (blocker/major)

- **Migrations must match the intent of the change** — inspect the SQL/DDL content, not just the filename. Autogenerated does not mean valid.
- **Multi-step writes are atomic** — a transaction or compensating cleanup; a crash mid-operation must not leave half-written state.
- **Retried work is idempotent** — queue consumers, webhook handlers, and setup hooks may run twice.
- **Schema changes ship with their migration** — when a model or schema definition changed, the diff must contain the corresponding migration (or a documented no-op explanation), plus any schema snapshot the tooling maintains.

#### Migration Sanity Gate (blocker)

For every migration in the diff:

1. Compare the migration statements against the stated intent of the change and the models it touches.
2. Flag as **blocker** any unrelated schema churn — especially mass constraint drops, table drops, or broad alters across areas the change does not touch.
3. Require regeneration or removal when the scope is wrong, even if the file was autogenerated.
4. Block merge until the migration contains only the expected schema changes.

Suspicious patterns that MUST be flagged:

- The migration touches many tables outside the change's area for a focused feature.
- The migration is mostly destructive statements (drops, bulk constraint removals) without matching model changes.
- Migration or snapshot files appear from local drift and are not required for the feature's behavior.

### Conventions & Structure (major/minor)

- Follow the naming, layout, and layering conventions the codebase already uses; consistency beats personal preference.
- Use the project's established helpers for forms, tables, HTTP calls, user feedback, and error states instead of hand-rolling parallel ones.
- Respect the project's design system and style conventions when they are documented; do not hard-code values the system provides tokens or variables for.
- User-facing strings go through the project's localization mechanism when it has one.

### Code Quality (minor)

- No untyped escape hatches where the language offers types; narrow with runtime checks at boundaries.
- No empty catch blocks — handle, log, rethrow, or document the intentional ignore.
- No one-letter variable names; self-documenting code over inline comments.
- Don't add docstrings, comments, or annotations to code the change didn't touch.

### Testing (major)

- **Behavior changes MUST include test coverage** — unit tests, integration tests, or both.
- **Bug fixes MUST include a regression test** that fails without the fix.
- **Risk-heavy paths get integration coverage**: permissions, data scoping, money, migrations, concurrency, external contracts.
- **Missing tests are findings**: name the exact files and cases to add.
- Intentionally skipped tests need a documented rationale and a residual-risk note.

## Review Heuristics

When reviewing, pay special attention to:

0. **Breaking changes**: for EVERY changed file, ask "does this touch a contract surface?" — an exported symbol, route, response shape, event name, CLI flag, schema, config format. If yes, verify a deprecation path or flag a blocker.
1. **New files**: does the project's codegen or registration step need to run? Are generated artifacts in sync with their sources, and never hand-edited?
2. **Schema changes**: is the corresponding migration in the diff (or a documented no-op)? Does the migration content match the intent? Are scoping and audit columns consistent with the rest of the schema?
3. **New endpoints**: auth guard, input validation, data scoping, pagination limits, and API documentation when the repo generates it.
4. **Event and message emitters**: is the event declared or registered where the repo requires it? Do existing consumers survive the payload change?
5. **Cache usage**: scoped keys, invalidation on every write path, no stale cross-scope reads possible.
6. **Background jobs and consumers**: idempotent, bounded concurrency, safe on retry and redelivery.
7. **UI changes**: loading, error, and empty states; established primitives; keyboard access; localization; no client-side-only permission checks.
8. **Behavior changes**: tests that fail without the change, covering edge and failure cases, not just the happy path.
9. **Permission-gated logic**: enforcement lives server-side; the UI merely reflects it.
10. **Dependency changes**: necessity, health, license, lockfile consistency, no major upgrades silently bundled with feature work.

## Rules

- Shared rules: `references/rules.md` — label discipline, claim etiquette, secrets hygiene, marker contract, emoji glossary. They always apply.
- Never conclude a review without running the full validation gate and reporting per-command results.
- A failing gate command is always a blocker finding, regardless of whose change broke it.
- Apply the built-in checklist on every review; apply the repo-local `reviewChecklist` file and the repo-root `CODE_REVIEW.md` in addition whenever they exist.
- When `BACKWARD_COMPATIBILITY.md` exists, verify every touched contract surface against it and flag violations as Critical with an explicit warning to the user.
- Findings must carry severity, file, line, and a concrete fix suggestion — vague findings are not actionable.
- The verdict is mechanical: any blocker, or any major without a documented waiver, means request changes.
- Review the diff you were given; do not expand scope by refactoring or restyling unrelated code as part of the review.
- Never paste secrets, tokens, or credentials into the review report, even when quoting offending lines — redact the values.
