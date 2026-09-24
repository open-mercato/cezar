# Execution plan — `CEZ_AUTOMATIONS` feature flag (issue #801)

**Issue:** [#801](https://github.com/open-mercato/cezar/issues/801) — Implement: `CEZ_AUTOMATIONS` feature flag — gate GitHub Automations off by default and hide its sidebar item
**Source doc:** `.ai/specs/2026-07-25-github-automations.md` (the feature being gated; its "No new `CEZ_*` variable is proposed" line is amended by this run)
**Engine:** `om-auto-create-pr` (plain)

## Goal

Put the shipped GitHub Automations feature behind a strict opt-in capability flag — `CEZ_AUTOMATIONS=1`, surfaced as `capabilities.automations` on `GET /api/v1/health` — that is **off by default**, so that without it the `Automations` sidebar item is absent everywhere it is rendered, the `/api/v1/…/automations*` family answers `409`, and the workspace automation scheduler never polls GitHub.

## Scope

Three layers of one gate, mirroring the proven follow-up-inbox pattern (`CEZ_FOLLOWUPS=1`, #471):

1. **Capability** — a new required `automations` boolean on the health `capabilities` object, resolved strictly (`env.CEZ_AUTOMATIONS === '1'`; `true`/`yes`/empty/unset all keep it off).
2. **Server** — a 409 guard in front of every automations route (project-scoped family plus the workspace-level manual-check read), and no background scheduling work while the flag is off.
3. **Cockpit** — the nav gate (`NavItem.automations` + `visibleNavItems`) applied at all three nav call sites, a disabled fallback on the four `/automations*` routes, and the two cross-links into the feature (GitHub tab's "Set up automations", the run header's automation-log link) degraded when the capability is off.

Plus the documentation the repo's own rules require: `.env.example` and the README env table (AGENTS.md: "an undocumented env var is a bug"), a `BACKWARD_COMPATIBILITY.md` §2 note and a dedicated opt-in-gating section, and the spec amendment.

### Non-goals

- The per-automation `enabled` toggle, the no-backfill baseline, receipts, polling bounds — the flag wraps the feature, it does not reshape it.
- A persisted workspace setting or a Settings-page toggle. The issue's stated assumption stands: an env var read per request, like `CEZ_FOLLOWUPS` and `CEZ_SINGLE_PROJECT`.
- Gating any other nav item, or generalizing the three ad-hoc nav gates (`forge`, `inbox`, `automations`) into one capability-driven mechanism.
- Webhooks, a daemon, or any change to how automations run once the flag is on.

## Implementation Plan

### Phase 1 — Server: capability, API gate, no background work

The capability is resolved in one place and consumed everywhere else, so the UI and the API can never disagree about whether the feature exists.

- **1.1** `packages/contract/src/health.ts`: add a required `automations: z.boolean()` to `capabilitiesSchema`, documented alongside `singleProject` and with the same "this contract describes THIS server's wire" reasoning the `tokenMetrics` comment gives.
- **1.2** `packages/cezar/src/server/capabilities.ts`: `resolveCapabilities` returns `automations: env.CEZ_AUTOMATIONS === '1'`, with a file-header paragraph next to `followups`/`singleProject`. Extend `capabilities.test.ts` with the strict-activation matrix (unset / `'1'` / `'true'` / `'yes'` / `''`).
- **1.3** `packages/cezar/src/server/server.ts`: add `AUTOMATIONS_OFF` beside `FOLLOWUPS_OFF` and a `requireAutomations` middleware answering `409 {error: AUTOMATIONS_OFF}`. Register it **path-scoped** (`/automations`, `/automations/*`, `/automation-log`, `/automation-log/*` on the project family; `/automation-checks/*` on the workspace family) rather than as a bare `use('*')`, because these sub-apps are mounted at `/` and a `*` middleware would gate the entire `/api/v1` surface.
- **1.4** `packages/cezar/src/server/server.ts` (`startServer`): skip `automationScheduler.start()` and make `rescheduleAutomations()` a no-op while the capability is off, so `WorkspaceAutomationScheduler` never polls GitHub and the coordinator never launches runs.
- **1.5** Tests: new `packages/cezar/src/server/automations-gate.test.ts` modeled on `inbox-gate.test.ts` (every route 409s off, behaves normally under `CEZ_AUTOMATIONS=1`, definitions are hidden but never destroyed) plus a scheduler assertion that nothing starts while off; opt the existing suites in (`automations-api.test.ts`, `contract-parity.automations.test.ts`, `route-parity.test.ts`) with save/restore so their coverage keeps exercising the real routes.

### Phase 2 — Cockpit: nav gate, route fallback, cross-links

- **2.1** `packages/web/src/components/nav-items.ts`: `automations?: boolean` on `NavItem` and `NavAvailability`; mark the `/automations` entry `automations: true` while keeping `forge: true` (it still needs a forge); extend `visibleNavItems({ forge, inbox, automations })` with a `false` default, preserving the shell's honesty rule. Extend `nav-items.test.ts`.
- **2.2** Nav call sites — `app-shell.tsx` (+ `app-shell-container.tsx` passing `health.data?.capabilities.automations === true`), `command-palette.tsx`, `project-groups.tsx` — so the sidebar, the ⌘K Views group and the per-project group can never disagree. Cover both states in each component test.
- **2.3** `packages/web/src/routes/automations/automations.tsx`: all four route modes render a short "Automations are off — set `CEZ_AUTOMATIONS=1` and restart" state while the capability is off, so a bookmarked deep link does not render a page whose every API call 409s. `routes.tsx` and its `{ pattern: '/automations/*', pageLabel: 'Automations' }` entry stay intact.
- **2.4** Cross-links: hide the GitHub tab's "Set up automations" link (`routes/github/github.tsx`) and degrade the run header's automation link to plain text (`routes/task-thread/run-header.tsx`) when the capability is off — a historical `RunRecord` can still carry `run.automation` after the flag goes off, and that link would land on a disabled route.

### Phase 3 — Documentation, e2e, and the gate

- **3.1** `.env.example` + the README env table: document `CEZ_AUTOMATIONS=1` (AGENTS.md requires the env contract to be updated in the same change).
- **3.2** `BACKWARD_COMPATIBILITY.md`: annotate the §2 Automations route bullet the way the Inbox bullet is annotated, and add a `## GitHub automations — opt-in gating` section in the shape of the "Single-project workspace mode" entry (what is narrowed, what is untouched, non-destructive rollback, why no deprecation alias).
- **3.3** `.ai/specs/2026-07-25-github-automations.md`: amend the "No new `CEZ_*` variable is proposed" line so the spec and the code agree.
- **3.4** `packages/web/e2e/automations.e2e.ts`: skip the existing cases when the shared test env reports the capability off (the `inbox.e2e.ts` pattern), and add one case asserting the sidebar carries no Automations item by default.
- **3.5** Full validation gate: `npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build`, `npm run test:package`.

## Risks

- **Middleware blast radius (highest).** `automationsRoutes` is mounted with `.route('/', …)` next to a dozen other sub-apps, so a `use('*')` guard inside it would gate every `/api/v1` route. Mitigated by path-scoped middleware registration and by `route-parity.test.ts` / the rest of the server suite, which would fail loudly on a 409 leak.
- **Protected-surface default flip.** The `/api/v1/…/automations*` family's default answers become `409`. This is deliberate and is exactly the shape of the documented "Follow-up inbox default flip (#471)" precedent; it is recorded in `BACKWARD_COMPATIBILITY.md` and the PR carries `risk-high`.
- **Contract required-vs-optional.** `capabilities.automations` is required, matching how `tokenMetrics`/`singleProject` are declared. Older cockpits reading a newer server are unaffected (additive key); a newer cockpit against an older server is out of the contract's remit by that file's own stated reasoning.
- **Stale scheduler state.** Flipping the flag on at runtime is only half a switch (the scheduler is started once at `listening`), the same caveat `followups` carries — the docs say "set `CEZ_AUTOMATIONS=1` and restart".
- **Non-destructive rollback.** Automation definitions, receipts and frozen high-watermarks are never deleted, rewritten or migrated by the gate; asserted in `automations-gate.test.ts`.

## Progress

PR: #802

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Server — capability, API gate, no background work

- [x] 1.1 Contract: required `capabilities.automations` on the health schema — 09438e2e
- [x] 1.2 `resolveCapabilities` resolves `CEZ_AUTOMATIONS` strictly, with tests — 09438e2e
- [x] 1.3 `AUTOMATIONS_OFF` 409 guard over both automations route families — 09438e2e
- [x] 1.4 Workspace automation scheduler does no work while the flag is off — 09438e2e
- [x] 1.5 `automations-gate.test.ts` plus opting the existing suites into `CEZ_AUTOMATIONS=1` — 09438e2e

### Phase 2: Cockpit — nav gate, route fallback, cross-links

- [x] 2.1 `NavItem.automations` gate and `visibleNavItems` filtering, with tests — 1b78af98
- [x] 2.2 Nav call sites pass the capability (shell, ⌘K palette, project groups) — 1b78af98
- [x] 2.3 The four `/automations*` routes render a disabled state — 1b78af98
- [x] Post-review fix: hold every `/automations` mode until health answers, so a cold deep link into `/automations/new` cannot paint a submittable editor on a gated server — e137ff2b
- [x] Post-review fix: align the `capabilities.automations` read spelling with each file's neighbouring capability reads — e137ff2b
- [x] 2.4 Cross-links into the feature degrade when the capability is off — 1b78af98

### Phase 3: Documentation, e2e, and the gate

- [x] 3.1 `.env.example` and the README env table document `CEZ_AUTOMATIONS` — 29c4e223
- [x] 3.2 `BACKWARD_COMPATIBILITY.md` §2 note and the opt-in gating section — 29c4e223
- [x] 3.3 Amend the automations spec's "no new `CEZ_*` variable" line — 29c4e223
- [x] 3.4 e2e: skip when off, and assert the sidebar has no Automations item — 29c4e223
- [x] 3.5 Full validation gate green — `npm run typecheck` ✅, `npm test` ✅ 5528 passed / 306 files, `npm run test:unit` ✅ 36 passed, `npm run build` ✅ check:pack ok, `npm run test:package` ✅ 12 passed
