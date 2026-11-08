---
name: cez-spec-writing
description: Write and review feature specifications to staff-engineer standards. Skeleton-first drafting with a hard Open Questions gate, research against market leaders, an implementation breakdown into phases and steps that feeds the implementation workflow, and a severity-ranked architectural review format. Use when starting a new spec or reviewing one.
---

## Cezar external-conductor mode

When the caller supplies a Cezar wrapper/phase contract, it is authoritative:
Cezar owns sequencing, issue claims and tracker state, the final validation
gate, review reconciliation, staging, and delivery. Skip setup/claim/delivery
steps owned by that conductor. Execute the complete technical judgment and
implementation workflow below within the phase boundary; do not commit, push,
publish, or open/merge a pull request.


# Spec Writing & Review

Design and review feature specifications against the project's architecture, naming, and quality rules. Adopt a **staff-engineer reviewer persona** — rigorous about architectural purity, but open to innovation. The project's own rules always come first: this skill supplies the process and the generic lens; the repository's agent instructions supply the laws.

## Modes

- **Interactive (default)** — the Open Questions gate is a hard stop: present the skeleton and wait for the user's answers.
- **`--autonomous`** — for unattended runs driven by an `an autonomous workflow` skill (`the autonomous spec workflow`, `the issue-fix workflow`). The gate does not stop: resolve each Open Question yourself per **Autonomous defaults** below and continue. The caller owns posting the applied defaults for human override.

## Arguments

- `--autonomous` (optional) — unattended mode; see **Modes**.
- `--data-model-graph` / `--no-data-model-graph` (optional, default on) — turn the step-6 data-model graph on or off. Off skips it entirely: no Mermaid diagram, no HTML view. The last flag passed wins.

## Workflow

**ALWAYS check first:** Apply `.ai/skills/cez-spec-writing/SKILL.md` when present; safety rules still win.

0. **Project setup** — follow `references/agentic-setup.md`; use the repository and phase context supplied by the caller. Missing optional config degrades to discovery and never triggers another setup workflow.
1. **Load context** — the repository's agent instruction files (their architecture rules, canonical primitives, and naming conventions are mandatory review criteria, not suggestions), plus the code, docs, and existing specs covering the affected area. When `${SPECS_DIR}/product-brief.md` exists (when the project keeps one), read its Problems, Goals, Business rules, Domain glossary, Key flows, Riskiest assumptions, and Open questions: they seed the Problem Statement and the Edge Cases, and every blocking open question or `[ASSUMPTION]`-only problem there becomes an Open Question here rather than a default. Walkthrough reports under `${SPECS_DIR}/research/walkthroughs/` (including nested session directories and older flat reports) (when the project keeps them) feed the Edge Cases the same way — as `[SYNTHETIC]` hypotheses to design for or to ask about, never as requirements. Stop reading as soon as you can name the modules and contracts involved. Follow canonical ids and source links in a product brief; the added Decision summary is optional for older files. A recorded choice or accepted risk does not turn its factual premise into evidence. Keep unsupported problem or user claims as Open Questions regardless of aggregate Coverage counts.
2. **Initialize** — create the empty spec file at `${SPECS_DIR}/{YYYY-MM-DD}-{kebab-case-title}.md` — the filename shape `the follow-up workflow` recognizes; directory resolution and fallback rules in `references/agentic-setup.md`.
3. **Start minimal** — write a **skeleton spec** first (TLDR + 2–3 relevant sections): who needs the change, what happens today, what is proposed, and any decision needed before design. Do NOT write the full spec in one pass.
   - Before writing the skeleton, scan the brief for **critical unknowns** — decisions that block architecture, data model, or scope; questions where a wrong assumption would force rewriting large parts of the spec. When the brief names a handoff file (a `— brief: <path>` suffix), read it first: its Resolved-unknowns table pre-answers gate questions — ask (or default) only what it leaves open, and commit the brief beside the spec.
   - One unknown is always checked: if the brief bundles more than one independently deployable capability (test: would each function without the other?), splitting into separate specs MUST be raised as an Open Question.
   - If critical unknowns exist, add a numbered **Open Questions** block (`Q1`, `Q2`, …) directly in the skeleton, immediately after the TLDR. One question per line; keep each short and answerable (binary or multiple-choice where possible).
   - **STOP after presenting the skeleton.** Do not proceed to research or design until the user has answered all questions. This is a hard gate. (**`--autonomous` runs only:** do not stop — resolve each question per **Autonomous defaults** below and continue.)
4. **Iterate** — apply the answers, fill in the skeleton, remove the Open Questions block once all are resolved. If new unknowns surface later, repeat the gate for those questions only.
5. **Research** — challenge the requirements against open-source market leaders in the domain. What do they get right that this spec ignores? What complexity do they carry that this spec can skip?
6. **Design** — the architecture: components, data model, contracts, failure modes.
   When the Data Model section adds or changes entities and
   `--no-data-model-graph` was not passed, generate the data-model graph →
   `references/data-model-graph.md`.
   Reuse the exact accepted design version and scope when supplied. Keep a pending
   design linked as a proposal; do not replace an accepted `Prototype:` reference
   until the owner accepts the new version and authorizes that update. Detailed
   screens can be requested as an optional separate design task;
   do not invoke it automatically or make it a prerequisite for writing this spec.
7. **Implementation breakdown** — split delivery into **Phases** (stories) and **Steps** (testable tasks). Each step must leave the application working. This structure maps directly onto `the implementation workflow`'s execution plan: a well-broken-down spec can be handed to it phase by phase, with the spec referenced as `Source doc:`.
8. **Review** — apply the review checklist below. Delegate the scope-cohesion item to a fresh-context subagent that receives only the spec file path — an author cannot adversarially re-read their own spec.
9. **Output** — finalize the file and report in 3–6 short lines: proposed outcome, the file link, open decisions or review blockers, and next action. Keep the design detail in the file. When the spec ships as a PR, `the follow-up workflow` can file the `Implement:` tracking issue once it merges.

## Output formats

### 1. New specification

Use the relevant sections below; omit empty sections and standard framework behavior. The opening should let a reader decide whether to pursue the proposal before reading implementation detail. Preserve the named sections that callers locate (`Implementation Plan`, `Phasing`, `UI/UX`, `Open Questions`, and `Resolved assumptions (autonomous defaults)`) when applicable; omit unrelated sections.

```markdown
# {Title}

## 📝 TLDR
{2–3 sentences: who needs this, current behavior, proposed behavior, and the reason. Label the proposal as future behavior.}

## 📝 Problem Statement
{What are we solving? Evidence it matters.}

## 📝 Proposed Solution
{High-level approach; alternatives considered and why they lost}

## 📝 Architecture
{Primary module, reused components and cross-system effects; current consumers and dependencies on future work. Use a small Mermaid flow only if it clarifies these effects, label existing/new/planned components and add a prose takeaway.}

## 📝 Data Model
{Entities, fields, relations, migrations; sensitive-data handling}

## 📝 API Contracts
{Endpoints/commands with request/response shapes and validation}

## 📝 UI/UX
{Flows, states, accessibility; only what is unique — not standard CRUD}
Prototype: {repo-relative path to the exact accepted design version, when one exists — accepted mockups under assets or an interactive design with its launch record. Record the acceptance evidence and accepted scope nearby. Omit the line when no version is accepted; link pending proposals separately.}

## 📝 Edge Cases & Failure Scenarios
{What breaks, and what the user sees when it does}

## 📝 Risks & Impact Review
{Hard-to-reverse contracts, schema, defaults or dependencies; who bears the impact, migration and rollback limits. Separate product direction calls from evidenced violations of repository rules.}

## 📝 Decisions in play
{Only when product-brief.md exists: the Non-goal, Business rule, and Decision ids this spec relies on, and any it proposes to supersede — with the owner who must approve}

## 📋 Phasing
{Phase 1: … / Phase 2: … — each independently shippable}

## 📋 Implementation Plan
{Phases → numbered Steps; each step testable and leaves the app working}
```

### 2. Architectural review

When reviewing a spec, lead with the direction decision and distinguish it from code/design defects. Support claims with the spec, a code reference or a named repository rule; label inferences and missing evidence. Omit empty severity buckets and passing checklist inventories. Keep every actionable finding with its impact and fix:

```markdown
# 🔍 Architectural Review: {Spec Title}

{Verdict and reason in 1–2 sentences: proceed, revise, or resolve a direction call first.}

## ⚠️ Decision needed
{Only for an unresolved product/scope choice: the question, recommended answer,
tradeoff, and evidence still needed. Do not present a preference as a defect.}

## 🔍 Findings
- **{Critical|High|Medium|Low}: {specific problem}.** {Source/rule and trigger →
  consequence → recommended correction. One entry per actionable finding.}

## 🧪 Review limits
{What was examined, evidence unavailable, and anything not checked that limits
this verdict. Link detailed evidence; do not imply a spec review tested the implementation.}
```

## Autonomous defaults (`--autonomous` runs only)

The interactive rule "never answer your own gate questions" is inverted here **only** because a stalled unattended run is worse than a documented, reversible assumption a human can override before merge. It is not licence to invent scope:

- For each numbered Open Question, pick the **most reversible, lowest-blast-radius** answer, biased toward the smallest scope that still ships something working: least new surface (no new public contract, dependency, or schema change), reuse of the project's existing primitives over inventions, and "no / defer X" for any "should this also do X?" question.
- Never default in a way that weakens security, data scoping, a documented compatibility contract (`BACKWARD_COMPATIBILITY.md` surfaces), or an active product decision, business rule, or non-goal in `product-brief.md`. When a question cannot be defaulted without that risk or a likely large rewrite, still pick the most reversible option but mark it `⚠ NEEDS HUMAN CONFIRMATION`.
- Replace the spec's `Open Questions` block with a `## Resolved assumptions (autonomous defaults)` section listing, per question: the chosen answer, a one-line rationale, and the `⚠ NEEDS HUMAN CONFIRMATION` marker where it applies. The spec must read as a coherent design under those assumptions — no dangling references to unanswered questions.
- Report the resolved table to the caller — the calling skill posts it as an issue/PR comment for override and applies the high-stakes guard (draft PR / `needs-qa`, never `qa-approved`) when any `⚠` marker exists.

## Review heuristics (the staff-engineer lens)

1. **The architectural diff** — is the spec wasting space documenting standard CRUD and boilerplate? Cut the noise; a spec earns its length only with what is unique to this feature.
2. **Scope cohesion** — one independently deployable capability per spec. Bundles get split.
3. **Canonical mechanisms** — does the spec reach for the project's established primitives (its CRUD factories, form/table components, HTTP clients, cache, event bus — whatever the agent instructions name) or invent parallel substitutes? Inventions need a stated reason.
4. **Contracts and compatibility** — which public surfaces change (APIs, events, schemas, config formats)? Is every breaking change flagged with a migration or deprecation path? When `BACKWARD_COMPATIBILITY.md` exists at the repo root, its protected-surface list is the authority. When `product-brief.md` exists, its Non-goals, Business rules, and Decisions are the second authority: a spec that contradicts an active entry without proposing a superseding one, named and owner-approved, fails this item.
5. **Reversibility** — how is each state change undone? The rollback/undo logic deserves the same detail as the execute path.
6. **Boundaries and coupling** — are cross-module effects routed through the project's decoupling mechanism (events, interfaces) or through direct imports? Are optional integrations degraded gracefully when the peer is absent?
7. **Sensitive data** — for every PII / credential / free-text-about-people field the spec proposes: does it follow the project's data-protection conventions (encryption, scoping, access rules)? No hand-rolled crypto, no "TODO encrypt later".
8. **Failure scenarios** — every external call, migration, and long-running job needs a documented failure mode and user-visible behavior.
9. **Testability** — can each implementation Step be verified by a test? Steps that cannot be tested are not steps; they are hope.

## Rules

- Shared rules: `references/rules.md` — autonomous-run contract (only under `--autonomous`), secrets hygiene, marker contract, emoji glossary. They always apply.
- The project's agent instructions are the source of architectural law; these heuristics are the floor, not the ceiling.
- Skeleton first, always. The Open Questions gate is a hard stop in interactive runs — never answer your own gate questions to keep moving. Only an explicit `--autonomous` run resolves them itself, under the Autonomous defaults rules, with every default surfaced for override.
- Specs describe the unique; they do not re-document the framework.
- Every spec ends with a phased, step-level implementation plan where each step leaves the app working.
- Reviews rank actionable findings by severity (Critical/High/Medium/Low), cite evidence and give a correction. Keep coverage and unchecked areas explicit; omit empty buckets and passing checklists.
- Never edit code while writing or reviewing a spec — the deliverable is the document.
