# Eval-gated model routing — analysis of the OM harness feedback and the incorporation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Phases 2–3 are cross-repo (open-mercato / skills) and gated on the Phase 0 decisions; Phase 1 is implementable in this repo today.

**Goal:** Replace the offline, human-mediated learning loop behind cezar's model routing with a recorded evaluation gate: a model binding becomes (or stays) a default for a role only when the OM harness case suite, replayed per role, says so.

**Architecture:** Cezar keeps conducting runs exactly as today; it gains a read-only *certification* layer that annotates every `agentHarness` binding with the latest role-mapped suite results, surfaces staleness, and (per policy) refuses to promote uncertified bindings. The suite itself — PR [open-mercato#4529](https://github.com/open-mercato/open-mercato/pull/4529)'s 203-case catalog with routing/AST/behavior oracles — stays owned by the open-mercato repo; a CI "certify" lane replays role-mapped subsets against candidate bindings and emits a versioned manifest cezar consumes.

**Tech Stack:** TypeScript + zod (cezar), the vendored `cez-harness` runtime, OM `harness:validate` / `harness:release` (Node, Linux + Bubblewrap for full lanes), GitHub Actions for certification runs.

## Global Constraints

- Everything here ships behind the `multiModel` config flag (off by default) — the flag added on this branch gates the whole multi-model surface.
- Cezar never writes `.ai/agentic.config.json`; only the setup skill (`cez-setup-harness` / `om-setup-agent-harness`) does. Certification data follows the same rule.
- Reviewer certification must measure the transport cezar actually uses: catalog reviewers run as ONE structured HTTP call, never an agent session (`reviewer-binding.ts:4-21`; mimo-v2.5-free: 62 s / 3 findings as a call vs 30–60 min timeouts as a session).
- The council quorum rule (≥2 completed reviewers spanning ≥2 families, `council-quorum.ts:30-31`) and the family table (`model-family.ts`) are runtime policy and stay code + regression tests; the eval gate scores models, it does not replace policy.
- All additions to `GET /api/v1/harness/status` and the config schema are additive (BACKWARD_COMPATIBILITY.md §2).
- Full-suite certification runs require Linux + root-owned Bubblewrap (`bwrap`); macOS is not a certification host (OM harness RELEASE.md containment policy). Certification is a CI concern, never a laptop concern — that is the point.

---

## Part 1 — What the feedback says (distilled)

Maciej Gren's message (2026-07-31), point by point:

1. **The learning loop is offline and human-mediated.** The routing rules in the code are distilled incidents: run `0fe16fb7` (two completed reviewers discarded because a third wrote prose → quorum instead of unanimity), `71edb02c` (a reviewer demanded a change, then blocked its reversal → round-history appendix in prompts; red validation gate short-circuits), `c54c2ed4` (run died on someone else's pre-existing red test → baseline validation gate), and the `reviewer-binding.ts` header (structured call vs agent session). The loop is: incident → author reads ledger → writes a rule or constant into the code. For production-readiness we either replay Piotr's harness cases properly, or take the author's environment on faith.
2. **Models change.** Routing should get *stronger* over time; on every new model release an unverified routing degrades.
3. Without a verifying loop over harness + routing, both drift.
4. **Strategically** this is the OM moat: not chasing top models blindly, but continuously searching for the configuration in which top models are unnecessary.
5. That "path-searching layer" currently lives in one person's session learnings.
6. **The practical version is small**: a router with an eval gate, and the gate already exists — [#4529](https://github.com/open-mercato/open-mercato/pull/4529)'s deterministic cases with routing, AST and behavior oracles, replayed per model (192/192 deterministic; 7/7 generative on Codex and Sonnet; [#4670](https://github.com/open-mercato/open-mercato/issues/4670) completes all-runner certification). What's missing is "the cable": today results end as numbers pasted into PR descriptions, and the #747 profile bindings are config constants. On a new model release, replay the suite on candidate bindings per role (analysis/spec → orchestrator, one-shot → worker, review & bugfix → council) and let only the result update the default profiles.

## Part 2 — Compatibility assessment

### What lines up (better than the feedback assumes)

| Their side (OM harness, #4529 @ develop) | Our side (cezar `feat/multi-modal`) | Fit |
| --- | --- | --- |
| `cases.json`: 203 cases, each with `mode: analysis (19) \| spec (4) \| one-shot (152) \| review (8) \| bugfix (20)` | Exactly three runtime roles: `orchestrator`, `implementer`, `reviewers[]` (`packages/contract/src/harness.ts:39-43`); phases map onto them in `driver.ts` (qualify/diagnose/spec/pre-implement → orchestrator; implement/fix → implementer; councils → reviewers) | **Direct.** Gren's role mapping is a subset selection over the existing `mode` field: analysis+spec (23 cases) certify orchestrator candidates, one-shot (152) implementer, review+bugfix (28) reviewers. No catalog change needed. |
| `release-matrix.json` pins runner → `modelSelector` per lane (`codex: default`, `claude: sonnet`) | Bindings are config constants: `agentHarness.models` / `profiles` in `.ai/agentic.config.json`, template in `cez-setup-harness/references/configuration-template.json` (codex/deepseek/kimi/glm/mimo) | **Direct.** Both sides already treat "which model runs" as versioned config. The gate is a precondition on changing ours. |
| Sanitized result JSON under `.ai/harness/results/` (hashes, rates, verdicts — no transcripts) | Per-run ledger with per-invocation `binding{runner,model,effort,family}`, `durationMs`, `status` (`harness/types.ts:113-152`) | **Complementary.** Their artifact scores a binding against oracles; ours records production behavior. Phase 4 joins them. |
| Live probe = fresh read-only process per case | `createModelProber` — injectable `ProbeTransport`, TTL cache, fail-closed preflight (`probe.ts:57`, `driver.ts:2019-2058`), explicitly "not a reasoning benchmark" (`probe-transports.ts:154`) | **Purpose-built seam.** Certification slots beside liveness without touching the driver: readiness stays a live measurement, certification is a recorded one. |
| Results pasted into PR text (their gap) | Learnings encoded as code comments citing run ids + regression tests (our gap — no institutional log) | **Same disease, both sides.** The manifest in Phase 1/2 is the shared cure. |

### Where it does not line up (and what that means for the plan)

1. **Domain scope.** The OMH cases evaluate Open Mercato standalone-app work (module implementations, UMES extension points, OM guides as owners). Cezar's harness is dual-profile: `skillProfile: generic | open-mercato`. A binding certified on OMH cases is *faithfully* certified for the open-mercato profile and only *proxy*-certified for generic repos. → The manifest must name its **eval pack** (`omh@<catalogVersion>`), and the design must permit future packs; we do not pretend OMH scores are universal.
2. **Runner coverage vs council reality.** `harness:validate --runner codex|claude` drives trusted runner *binaries*. Cezar's councils seat HTTP advisors (deepseek-api, opencode-zen: kimi/glm/mimo) invoked as one structured `chat/completions` call (`vendor/skills/cez-harness/scripts/harness.mjs:773-790`). Certifying reviewers therefore needs an **advisor-HTTP lane** in the OM harness (an `--runner advisor --endpoint … --model …` transport that answers the review/bugfix cases through one structured call and judges the JSON against the case oracles). [#4670](https://github.com/open-mercato/open-mercato/issues/4670) already plans Kimi and mini-high lanes, so this extends work in flight rather than forking it. Fallback if upstream declines: a cezar-side certify command that replays the 28 review/bugfix cases through our own council op against exported case fixtures — workable, but then two harnesses measure, which is exactly the drift Gren warns about. **Recommendation: upstream lane.**
3. **Environment.** Full lanes need Linux + bwrap; laptops (macOS) cannot host them. This is a feature: "wiara w czyjeś środowisko" (faith in someone's environment) is replaced by a CI run whose artifact records harness head, runner versions, model selectors and catalog size — precisely #4670's acceptance list.
4. **Freshness semantics.** OMH scores a model on *their* head; our bindings pin model ids that providers move underneath (e.g. `-free` gateway tiers). The manifest therefore records `catalogVersion` + `recordedAt` + the exact binding fingerprint, and cezar computes staleness locally, never live.

### Verdict

Highly compatible — the feedback's mapping (roles ↔ case modes, bindings ↔ config constants, gate ↔ existing suite) is implementable without changing either side's architecture. The one genuine build item on their side is the advisor-HTTP lane; the one genuine build item on our side is the certification layer + promotion gate. The strategic point (G4/G5) lands as: the certification manifest *is* the "path-searching layer", made durable and inspectable instead of living in session learnings.

---

## Part 3 — The plan

### Phase 0 — Decisions and coordination (no code)

- [ ] **Step 0.1:** Open an issue on `open-mercato/open-mercato` proposing the certify lane, linking [#4670](https://github.com/open-mercato/open-mercato/issues/4670): (a) an `advisor-http` runner transport for the review/bugfix cohort (one structured call, `response_format: json_object`, `temperature: 0` — mirroring `harness.mjs` advisor calls); (b) a `harness:certify` command that replays role-mapped subsets (`mode ∈ {analysis, spec}` / `{one-shot}` / `{review, bugfix}`) against one named binding and writes a `certification-manifest.json` (schema in Task 1) instead of prose numbers; (c) a scheduled Linux CI workflow running it for the current default bindings plus any candidate marked in the matrix.
- [ ] **Step 0.2:** Agree where manifests live. Recommendation: committed under `.ai/harness/certifications/` in the open-mercato repo (one file per binding fingerprint), mirrored into the skills repo release so `cez-setup-harness` ships with the latest set; a repo's `.ai/agentic.config.json` pins the manifest digest at promotion time.
- [ ] **Step 0.3:** Agree the enforcement ramp: `certificationPolicy: 'off' | 'advise' | 'require'`, defaulting to `advise` everywhere and `require` for OM core repos once the first full matrix exists.

### Phase 1 — Certification layer in cezar (implementable now, this repo)

> **Status 2026-08-06: implemented on `feat/eval-gated-routing`** (Tasks 1–3, each with tests).
> Design refinements settled during review, now binding:
> - **Pack-agnostic by construction.** The mechanism (schema, status, badges, staleness) is
>   generic cezar; the OMH suite is content and stays in the open-mercato repo. `pack` names
>   the source; a future generic/cezar pack or a per-repo "bring your own eval" command slots
>   in without schema changes.
> - **Scoped to the multi-model flow.** Certification rides the `multiModel` flag and touches
>   nothing in single-model cezar — roles and bindings only exist in the harness.
> - **Auto-assign is an explicit action.** The passive `defaultHarnessRoles` pre-fill never
>   seats advisors ("advisors are an explicit choice", pinned test); the recorded-score lineup
>   is applied via the "Use best certified" button (`bestCertifiedRoles`), which exists only
>   when receipts exist. Manual picks stay free everywhere; the advisory line
>   (`certificationAdvisory`) stays silent until the workspace's first receipt.

### Task 1: Certification schema + resolution (`certification.ts`)

**Files:**
- Create: `packages/cezar/src/harness/certification.ts`
- Test: `packages/cezar/src/harness/certification.test.ts`

**Interfaces:**
- Consumes: the loose `agentHarness` record from `loadAgenticConfig` (`runtime.ts:479-485`); binding family resolution via `familyByModelName` (`model-family.ts:49`).
- Produces: `certificationSchema` (zod), `type ModelCertification`, `type CertificationStatus = 'certified' | 'stale' | 'uncertified'`, and `certificationFor(modelId: string, agentHarness: Record<string, unknown> | undefined, now: Date): ResolvedCertification` where `ResolvedCertification = { status: CertificationStatus; roles?: Partial<Record<'orchestrator' | 'implementer' | 'reviewer', { cases: number; passed: number }>>; pack?: string; catalogVersion?: string; recordedAt?: string }`.

- [x] **Step 1.1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { certificationFor } from './certification.js';

const CERT = {
  pack: 'omh',
  catalogVersion: '203@4529-head',
  binding: { family: 'deepseek', model: 'deepseek-v4-pro', adapter: 'preset' },
  roles: { reviewer: { cases: 28, passed: 27 } },
  recordedAt: '2026-08-01T00:00:00.000Z',
  resultDigest: 'a'.repeat(64),
};

describe('certificationFor', () => {
  it('answers uncertified when the config carries nothing for the id', () => {
    expect(certificationFor('deepseek', { models: {} }, new Date('2026-08-06'))).toEqual({
      status: 'uncertified',
    });
  });

  it('resolves a valid certification with its role rates', () => {
    const agentHarness = { models: {}, certifications: { deepseek: CERT } };
    const resolved = certificationFor('deepseek', agentHarness, new Date('2026-08-06'));
    expect(resolved.status).toBe('certified');
    expect(resolved.roles?.reviewer).toEqual({ cases: 28, passed: 27 });
    expect(resolved.catalogVersion).toBe('203@4529-head');
  });

  it('degrades to stale past the freshness window, never to a lie', () => {
    const old = { ...CERT, recordedAt: '2026-01-01T00:00:00.000Z' };
    const resolved = certificationFor(
      'deepseek',
      { certifications: { deepseek: old } },
      new Date('2026-08-06'),
    );
    expect(resolved.status).toBe('stale');
    expect(resolved.recordedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('treats a malformed entry as uncertified rather than throwing (config is untrusted)', () => {
    const resolved = certificationFor(
      'deepseek',
      { certifications: { deepseek: { pack: 42 } } },
      new Date('2026-08-06'),
    );
    expect(resolved).toEqual({ status: 'uncertified' });
  });
});
```

- [x] **Step 1.2:** Run `npx vitest run packages/cezar/src/harness/certification.test.ts` — expect FAIL (module not found).
- [x] **Step 1.3: Implement**

```ts
import { z } from 'zod';

/**
 * A model binding's recorded eval-gate result (spec 2026-08-06-eval-gated-model-routing).
 * Written only by the certify lane / setup skill — cezar reads, never writes, exactly like
 * the rest of `agentHarness`. A missing or unparseable entry is 'uncertified', not an error:
 * the gate must never make an existing configuration stop loading.
 */
export const certificationRoleSchema = z.object({
  cases: z.number().int().min(0),
  passed: z.number().int().min(0),
});

export const certificationSchema = z.object({
  /** The eval pack that produced this — 'omh' is the OM standalone harness catalog. */
  pack: z.string().min(1),
  catalogVersion: z.string().min(1),
  binding: z.object({
    family: z.string().min(1),
    model: z.string().min(1),
    adapter: z.string().min(1),
  }),
  roles: z
    .object({
      orchestrator: certificationRoleSchema.optional(),
      implementer: certificationRoleSchema.optional(),
      reviewer: certificationRoleSchema.optional(),
    })
    .refine((r) => r.orchestrator || r.implementer || r.reviewer, {
      message: 'a certification must cover at least one role',
    }),
  recordedAt: z.string().datetime(),
  resultDigest: z.string().regex(/^[0-9a-f]{64}$/),
});

export type ModelCertification = z.infer<typeof certificationSchema>;
export type CertificationStatus = 'certified' | 'stale' | 'uncertified';

/** Past this, a recorded pass stops being evidence — models move underneath their ids. */
export const CERTIFICATION_FRESH_MS = 90 * 24 * 60 * 60_000;

export interface ResolvedCertification {
  status: CertificationStatus;
  roles?: ModelCertification['roles'];
  pack?: string;
  catalogVersion?: string;
  recordedAt?: string;
}

export function certificationFor(
  modelId: string,
  agentHarness: Record<string, unknown> | undefined,
  now: Date,
): ResolvedCertification {
  const table = agentHarness?.certifications;
  if (!table || typeof table !== 'object' || Array.isArray(table)) return { status: 'uncertified' };
  const parsed = certificationSchema.safeParse((table as Record<string, unknown>)[modelId]);
  if (!parsed.success) return { status: 'uncertified' };
  const cert = parsed.data;
  const fresh = now.getTime() - Date.parse(cert.recordedAt) <= CERTIFICATION_FRESH_MS;
  return {
    status: fresh ? 'certified' : 'stale',
    roles: cert.roles,
    pack: cert.pack,
    catalogVersion: cert.catalogVersion,
    recordedAt: cert.recordedAt,
  };
}
```

- [x] **Step 1.4:** Run the test file — expect PASS.
- [x] **Step 1.5:** Commit: `feat(harness): certification schema + resolution (eval-gated routing, phase 1)`.

### Task 2: Surface certification on `GET /api/v1/harness/status`

**Files:**
- Modify: `packages/cezar/src/server/server.ts` (the `/harness/status` handler — model roster assembly)
- Modify: `packages/contract/src/harness.ts` (`harnessModelSchema` gains optional `certification`)
- Test: `packages/cezar/src/server/harness-api.test.ts`

**Interfaces:**
- Consumes: `certificationFor` from Task 1.
- Produces: each roster row optionally carries `certification: { status, roles?, catalogVersion?, recordedAt? }` — additive; absent when the config has no table, so old consumers see no change.

- [x] **Step 2.1:** Failing test in `harness-api.test.ts`: write an `agentic.config.json` whose `agentHarness` has one model plus a `certifications` entry for it; `GET /api/v1/harness/status`; expect the row to carry `certification.status === 'certified'` and an uncertified sibling to carry `certification.status === 'uncertified'`.
- [x] **Step 2.2:** Extend the roster mapping in the status handler: `certification: certificationFor(id, agentic.agentHarness, new Date())` (include for the synthetic `claude` host row too — the host is implicitly seated and deserves an honest `uncertified` until a claude lane manifest exists).
- [x] **Step 2.3:** Add the optional `certification` object to `harnessModelSchema` in the contract; run `npm run typecheck`.
- [x] **Step 2.4:** Run `npx vitest run packages/cezar/src/server/harness-api.test.ts` — expect PASS. Commit.

### Task 3: Cockpit surfaces — roster chips and role-picker badges (advisory)

**Files:**
- Modify: `packages/web/src/routes/settings/harness-section.tsx` (roster rows show a certification chip: `certified · reviewer 27/28 · omh 203` / `stale` / `uncertified`)
- Modify: `packages/web/src/routes/new-task-form.ts` (`advisorHarnessOptions` passes `certification` through to `HarnessModelOption`)
- Modify: `packages/web/src/routes/new-task-harness.tsx` (the role picker badges options and, when a picked reviewer is uncertified for the reviewer role, shows the advisory line "not yet certified for review — runs are unaffected, results unverified")
- Test: `packages/web/src/routes/settings/harness-section.test.tsx`, `packages/web/src/routes/new-task-form.test.ts`

- [x] **Step 3.1:** Failing tests: harness-section renders the chip text for a certified row; `advisorHarnessOptions` carries `certification` through; the panel shows the advisory for an uncertified pick.
- [x] **Step 3.2:** Implement the pass-throughs and chips (no gating of Start here — Phase 3 owns enforcement).
- [x] **Step 3.3:** Run both web test files; commit.

### Phase 2 — The certify lane (open-mercato repo, coordinated with #4670)

Work items for the upstream issue (not cezar code; listed so the plan is complete and the cable has two ends):

- [ ] **Step 2a:** `advisor-http` runner transport in the harness evaluator: one structured `chat/completions` call per case with the case brief + oracle-checked JSON answer; credentials via the same isolated-auth policy as existing lanes; timeout per the review lane defaults. Measures the *call transport*, which is what cezar seats.
- [ ] **Step 2b:** `yarn harness:certify --binding <family/model@adapter> --roles reviewer[,implementer,orchestrator]` — replays `mode`-mapped subsets (analysis+spec 23 / one-shot 152 / review+bugfix 28), emits `certification-manifest.json` matching Task 1's schema, with `resultDigest` = sha256 of the sanitized result set.
- [ ] **Step 2c:** Scheduled Linux CI workflow (weekly + on catalog change + manual dispatch with a binding parameter) committing manifests under `.ai/harness/certifications/` — replacing pasted PR numbers as the record.

### Phase 3 — The promotion gate (skills repo: `cez-setup-harness` / `om-setup-agent-harness`)

- [ ] **Step 3a:** The setup skill reads `certificationPolicy` (default `advise`). Under `advise` it prints the certification table and marks uncertified defaults; under `require` it refuses to write a **default profile** binding whose role lacks a fresh certification (custom experiments stay writable — the gate protects defaults, not exploration).
- [ ] **Step 3b:** Promotion flow documented in the skill: add candidate binding → dispatch certify CI → manifest lands → re-run setup, which now promotes. "Coraz mocniejszy routing" then comes from the growing catalog: a new case tightens every later certification automatically.

### Phase 4 — Close the local loop (cezar, after Phase 1 ships)

- [ ] **Step 4a:** `cezar harness export-incidents` (CLI + `GET /api/v1/harness/incidents` later if wanted): walks run ledgers and emits sanitized incident records — reviewer failures with `reason` + binding, council degradations, salvage events (`driver.ts:1055-1067`), per-invocation durations. No prompts or diffs — the same sanitization discipline as OM results.
- [ ] **Step 4b:** Contribution runbook: an incident that reveals a new *model* failure mode becomes a new catalog case upstream (the `0fe16fb7` prose-instead-of-JSON incident is the template: today it is a comment + a constant; under the loop it is also case coverage every future binding must pass). Incidents that reveal *policy* gaps stay code + regression tests here.

### Phase 5 — Staleness triggers (cheap, config-only)

- [ ] **Step 5a:** `CERTIFICATION_FRESH_MS` (Task 1) already ages recorded passes into `stale`; the cockpit chip and setup-skill table surface it. Re-certification is then: CI dispatch → new manifest → chip flips back. No live calls from cezar, ever.

---

## Open questions (recommendations inline)

1. **Manifest home** — recommend: committed in open-mercato repo + shipped with the skills release; a repo pins digests at promotion. Alternative (published feed) adds infrastructure without adding trust.
2. **Advisor lane upstream vs cezar-side replay** — recommend upstream (one measurement authority); cezar-side replay is the documented fallback.
3. **First enforced role** — recommend reviewers: cheapest cohort (28 cases × one call), most family diversity, and the role where a silent model regression does the most damage (a bad reviewer *approves*).
4. **Generic-profile packs** — out of scope here; the `pack` field keeps the door open for a cezar-generic case pack later.

## Sources

- Feedback: Maciej Gren, 2026-07-31 (Discord, quoted in task).
- OM harness: PR #4529 (merged), README.md / RELEASE.md / `release-matrix.json` / `cases.json` @ `develop` (203 cases: analysis 19, spec 4, one-shot 152, review 8, bugfix 20; kinds: routing 157, implementation 39, regression 7); follow-up issue #4670 (open).
- Cezar: `packages/cezar/src/harness/` — `reviewer-binding.ts`, `council-quorum.ts`, `probe.ts`/`probe-transports.ts`, `profile-plan.ts`, `model-family.ts`, `driver.ts`; specs `2026-07-23-harness-orchestration.md`, `2026-07-24-advisor-reviewers.md`, `2026-07-26-harness-production-stabilization.md`.
