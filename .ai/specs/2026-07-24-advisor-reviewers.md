# Harness Advisor Reviewers in Role-Based Runs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Configured `agentHarness` advisor bindings (kimi-subscription k3, deepseek-api, …) become pickable reviewers in the Multi-model tab and execute through the vendored `harness.mjs` review council, merged into the driver's existing findings/fix-loop flow.

**Architecture:** A reviewer ref gains a second kind — `{runner: 'harness', model: <advisorId>, family}` — offered in the picker from `GET /harness/status` models. The driver partitions reviewers: runner refs keep the fresh-session path; advisor refs run as ONE packet-less `harness.mjs review` invocation against a **synthesized profile** (`cez-role-council`, exactly the selected advisors, all-required) written into a copy of the trusted config snapshot. No `--review-packet`/`--host-review` pair (that contract stays with the wrapper-skill flow); subject defaults to the op's own worktree diff — the same diff the runner sessions review. Orchestrator/implementer stay runner-only.

**Key upstream facts (verified):** `commandReview` without `--review-packet` runs providers only (`harness.mjs:1789-1800`); output contract = `review-result.json` + `review-summary.md` in `--output-dir`, stdout JSON `{status, verdict, jsonPath…}`, exit 2 on failed policy; `loadSubject` with no subject args = worktree diff; `resolveProfile` reads `config.agentHarness.profiles[name]`; `ensureIgnoredRunDir(outputDir, worktree)` wants the artifact dir ignored inside the worktree (default `<worktree>/.ai/qa/…` — pre-exclude ours via the existing `excludeFromGit`).

## Global Constraints

- Never commit or push; stage only (`git add`), on top of the existing staged tree.
- Never modify `vendor/` by hand; the runtime is used verbatim.
- Additive wire changes only; `BACKWARD_COMPATIBILITY.md` notes the reviewer-ref variant and any status additions.
- Validation gate at the end: `npm run typecheck` → `npm test` → `npm run test:unit` → `npm run build` → `npm run test:package`.

---

### Task 1: Reviewer-ref variant on the wire (server + web types)

**Files:** `src/server/server.ts` (roles schemas ~:315-362), `web/app/src/api/types.ts` (HarnessModelRef area), `src/server/harness-api.test.ts`.

- `harnessModelRefSchema` stays the runner ref (orchestrator/implementer unchanged). New `harnessAdvisorRefSchema = z.object({ runner: z.literal('harness'), model: z.string().min(1).max(200), family: z.string().min(1).max(80) })`; `reviewers: z.array(z.union([harnessModelRefSchema, harnessAdvisorRefSchema]))` with the same min/max/unique rules. `harnessFamilyOf` returns `ref.family` when `runner === 'harness'`.
- Web `HarnessModelRef` mirrors: `runner: Runner | 'harness'`, optional `family`; `HarnessStatusResponse` unchanged.
- Tests: advisor reviewer accepted (family counts toward diversity); advisor as orchestrator/implementer rejected 400; duplicate advisor rejected.

### Task 2: Picker options from harness status (web)

**Files:** `web/app/src/routes/new-task-form.ts` (+test), `web/app/src/routes/new-task.tsx`, `web/app/src/routes/new-task-harness.tsx` (+test if picker filters live there).

- Pure `advisorHarnessOptions(status?: HarnessStatusResponse): HarnessModelOption[]` — status models with `adapter !== 'host'` and `roles` including `reviewer` → `{ runner: 'harness', model: id, label: `${id} · ${model ?? adapter}`, family: family ?? 'harness' }`.
- new-task.tsx: `const status = useHarnessStatus()`; append `advisorHarnessOptions(status.data)` to `harnessOptions`; `modelFamilyOf` handles `'harness'` refs via `ref.family`.
- Orchestrator/implementer pickers and `defaultHarnessRoles` filter to `o.runner !== 'harness'`; reviewer picker shows advisors grouped (extend `groupHarnessOptions` group label: `council advisors`).
- Tests: options built from a status fixture (kimi/moonshot/k3 present); defaults never pick an advisor; grouping.

### Task 3: Driver — advisor council via the review op

**Files:** `src/harness/driver.ts`, `src/harness/driver.test.ts`.

- Preflight: when roles contain advisor refs — require the trusted/working `agentHarness` to define every advisor id with a `reviewer` role; else fail with `advisor reviewer "<id>" is not bound in .ai/agentic.config.json — run cez-setup-harness`.
- Council helper `runAdvisorCouncil(round)`: write `council-config.json` (config JSON + injected `profiles['cez-role-council'] = { workers: [], reviewers: ids, reviewPolicy: { mode: 'all-required', requiredReviewers: ids } }`) into `artifactDir`; `excludeFromGit(worktree, '.ai/qa/')`; outputDir `<worktree>/.ai/qa/cez-council-r<round>`; criteria file (task + validation-gate summary, same content vars as the session prompt); `runtime.run('review', ['--config', …, '--profile', 'cez-role-council', '--worktree', …, '--criteria-file', …, '--output-dir', …], { timeoutMs: max(configured advisor timeouts) + 120s })`; parse `review-result.json` (loose zod: `{ verdict, reviewers: [{id, family, status, review?: {verdict, findings?}, error?}], findings: [{severity, title, evidence?, raisedBy?}] }`).
- Roles branch: run runner reviewers as today; then (or before) advisor council; map advisor rows into `councilReviewers` (`id: 'harness:'+id`, status/verdict/findings, `freshContext: true`); on op failure/exit 2 → the existing partial-council error path with the op's stderr tail; merge advisor findings through the same `byKey` union (`by` = advisor id); `mergedVerdict` also `request_changes` when the council result says so.
- Tests (FakeRuntime): review op receives synthesized profile + writes a canned `review-result.json` → ledger council holds both runner and `harness:` rows, verdict merges; op exit-2 → run fails with the council message; preflight unbound-advisor error.

### Task 4: Docs + gate

- `BACKWARD_COMPATIBILITY.md`: reviewer-ref union (additive); `.ai/specs/2026-07-23-harness-orchestration.md` gets a one-line pointer to this spec.
- Full validation gate; `npm run build:web`; live check in the preview (picker shows `kimi · kimi-code/k3`).
- Optional live proof (cheap, one call): run the packet-less council once with a kimi-only synthesized profile against a toy diff via `node vendor/skills/cez-harness/scripts/harness.mjs review …` and confirm a structured k3 review lands.

## Self-Review
Wire variant (1) is consumed by picker (2) and executed by driver (3); family diversity handled at both ends; no packet/host-review in v1 (documented as the wrapper-flow contract); failure modes mapped to existing council-failure semantics.
