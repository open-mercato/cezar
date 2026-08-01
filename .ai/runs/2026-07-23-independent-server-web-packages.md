# Execution plan — headless cezar: independent server package + typed client

Source doc: `.ai/specs/2026-07-23-independent-server-web-packages.md`
Tracking issue: #557 (the headless/API half of the follow-up comment)
Branch: `split-server-web-packages`
Base: `main`

The Progress phases mirror the spec's Implementation Plan, plus Phase R (the repo
restructure), which the spec did not originally call for — see its amended
decision 5. Every phase leaves the suite green.

## Goal

Turn the server into a standalone headless service with its own package, make the
cockpit one client of it, and let the two meet through a single package
(`@open-mercato/cezar-api-client`) instead of a hand-copied mirror. That package
is internal for now — installable by others once its surface settles.

## Progress

### Phase 0 — Scaffold api-client — **done**
- [x] 1. `packages/api-client` (`@open-mercato/cezar-api-client`): ESM-only manifest (`exports` only, no `main`/`types`), NodeNext build to `dist`, `types: []` so a `node:*` import cannot slip in. Own vitest config + `test` script.
- [x] 2. Moved the Node-free shared modules in: `protocol/{ui-events,tool-display}.ts`, `utils/project-scope.ts`. Imports name the real `.ts` file (`rewriteRelativeImportExtensions` emits `.js` into `dist`) — verified an external NodeNext consumer resolves both the types and the runtime.
- [x] 3. Root gained `workspaces`; no re-export shims — all 26 web import sites were rewritten to the package name (owner's call, cleaner diff over smaller diff).

### Phase 1 — `AppType` + first families + `hc` — **done (exceeded: 3 families, not 1)**
- [x] 1. `packages/cezar/src/server/app-type.ts` → `AppType = ReturnType<typeof createApp>`; `createApp`'s return annotation dropped so the chained type survives. `./app-type` added to the package `exports`.
- [x] 2. Chained **health** (1 route), **agent-config** (3), **workflows** (4) into sub-app builders. Mounted into the legacy `api` table *and* a chained `v1` — `/api/v1` + `/api/v1/p/:projectId` (amended decision 6).
- [x] 3. `createCezarClient<T>()` in the api-client — generic over the app type, so the package installs and runs with no dependency on the server package.
- [x] 4. Proven end to end: `typed-client.test.ts` drives real handlers through the client with `fetch` wired into the app, asserts the response type is not `any`, and has two `@ts-expect-error` cases (unknown path; legacy path deliberately not offered).
- [x] 5. Guards: new `v1-parity.test.ts` (5 spellings byte-identical, CORS twin, unknown-project 404 parity, and that an *unchained* family is correctly absent from v1). `bc-route-inventory.test.ts` rewritten to read a built app's route table instead of regexing source — the regex would not have failed on chained registration, it would have quietly stopped seeing those routes.

### Phase 2 — Web package — **done**
- [x] 1. `packages/web` (`@open-mercato/cezar-web`, private) owns every React/Vite/Tailwind/Radix dep; root keeps only the toolchain that spans all three (`typescript`, `vitest`, `tsx`).
- [x] 2. Root `build:web`/`dev:web`/`typecheck:web` delegate via `npm run … -w`; `vite` left the root manifest entirely.
- [x] 3. Vite/tsconfig resolve the api-client to **source** (HMR, no build ordering); the server and external consumers resolve `dist`, which is the artifact npm ships.

### Phase R — Repo restructure (amended decision 5) — **done**
- [x] 1. `packages/{cezar,api-client,web}` + `alias-cezar`; root `private: true`, publishes nothing.
- [x] 2. Path-coupled assets repointed: `bc-route-inventory` REPO_ROOT, the web tests' fixture reaches, `.ai/scripts/{e2e,test-env-up}.sh`, the CI/release workflows, `scripts/dev.mjs`.
- [x] 3. Two couplings the move forced out into the open: the **logo** now has one home (`packages/web/public/` → built into `web/dist`, served at `/open-mercato.svg`) instead of a bundled hash *and* a static file; the **README** stays the repo front page and is copied into the package at `prebuild` (gitignored) so the npm page cannot drift.
- [x] 4. Release pipeline reworked for a three-package set: `manifests.ts` holds the shared stamper, `pinDependency` rewrites a range in whichever section declares it (so the api-client's `devDependencies` → `dependencies` move in Phase 3 needs no release change), publish order is api-client → cezar → alias. Unit + e2e tests cover the order and the pins.
- [x] 5. Docs swept for the new paths (AGENTS.md gained a Repository layout section; `.ai/specs` and `.ai/runs` left alone as historical records).
- [x] 6. api-client marked `private` (amended decision 7): stamped in lockstep, never published, publication gated on npm's own flag. CI's pack step verifies only what actually ships.

### Phase 3 — Chain the rest; single-source DTOs; delete the mirror — **DONE**
- [x] 1. DTOs relocated to `packages/api-client/src/dto/types.ts` and exported from the barrel. Forced by the restructure: once the mirror lived in `packages/web`, the server's drift guard reached across a package boundary and broke `rootDir` — which is exactly the coupling this spec removes.
- [x] 2. All 138 web files import DTOs from `@open-mercato/cezar-api-client`; `api-types.test.ts` imports the package too, not a relative path.
- [x] 3. **Chain the remaining route families — done.** All 77 registrations converted into 23 family builders; zero loose `api.get(…)`/`app.get('/api/…')` statements remain. `/api/v1` now mirrors the legacy surface completely, so `AppType` covers the whole API. The legacy side mounts through un-chained holders (`api`, `workspaceLegacy`) so `/api/*` stays untyped by design. `v1-parity.test.ts` gained the guard that replaces per-family spot checks: every `/api` route must have a `/api/v1` twin, with a vacuous-pass check beneath it.
- [x] 4. **Server handlers type their own responses.** Surveyed every DTO'd GET route by generating an inference probe from `client.ts`'s own route→DTO map: 14 of 17 already inferred exactly. The three gaps were two different problems, and only one was the server's:
  - `/health` genuinely returned `Record<string, unknown>`. The whole cache chain now names `HealthResponse`, imported `import type` from the api-client — **erased at build, so the published CLI gains no runtime dependency and the api-client can stay private**. (The plan assumed this step forced publication; it does not, because DTOs are types.)
  - `/models` and `/repo/changes` were not server problems at all: `hc` types a call as the union of everything the handler can answer, error branches included. `Ok<R>` in the api-client selects the 200 member, which is what makes an inferred type a drop-in for the DTO it retires.
  - **Typing the handler immediately caught real drift the mirror could not**: `ForgeInfo.available` was declared required, but the handler spreads `detectCached() ?? {}` and emits `{kind}` alone until the probe warms. `Exact<>` compared two *declarations* and saw no problem; naming the handler's return type compared it to reality. DTO and guard corrected (`available?`, `Partial<ForgeAvailability>`); the cockpit already read it defensively.
- [x] 4b. **Request bodies are typed too — every mutating handler validates through Hono's `validator('json')`.** Responses being typed only got half the surface: all 28 mutating handlers parsed their body *inside* the handler, which Hono cannot see, so `cez.api.v1.runs.$post({ json: { totalNonsense: 12345 } })` compiled happily. Now it does not, and the same holds for all 28.
  - The wrapper is `jsonBody(schema, { absent, message })`, not bare `validator`, because Hono's validator differs from the inline parse in two ways that reach the wire: a **plain-text** 400 for malformed JSON (BACKWARD_COMPATIBILITY §2 pins the `{error}` JSON shape, which the cockpit shows verbatim in a toast) and it ignores a body sent without a JSON content-type. `jsonBody` settles both cases itself and publishes through `addValidatedData`, so **no route changed its wire behaviour** — verified case-by-case against the old `await c.req.json().catch(() => …)`. `absent` carries each route's own former fallback; `message` its fixed 400 text where it had one.
  - Both ui-state routes fold their key cap into the schema (`capUiStateKeys` as a refinement), which retired `parseUiStateBody` and let them use `jsonBody` like the rest.
  - **The failure mode here is silence, and it bit once.** Deriving those two schemas through a generic helper left the type unresolved where `jsonBody` needed it, and Hono answered by dropping both PUTs from `AppType` entirely — no error, server still serving, cockpit still calling, every runtime test still green. Concrete schema consts fixed it, and `typed-bodies.test.ts` now asserts at compile time that all 28 routes reach `AppType` with a body type (proven non-vacuous by reintroducing the bug).
- [x] 4c. **The validators are their own module, and `param`/`query` are covered too.** `packages/cezar/src/server/validators.ts` exports `jsonZodValidator` / `paramZodValidator` / `queryZodValidator`; `server.ts` defines no validation helper of its own (28 json + 5 param + 13 query call sites). `@hono/zod-validator` was evaluated and declined: it wraps the same `hono/validator`, so it inherits both wire problems above — verified against `0.9.0`, where a body sent without a JSON content-type is silently discarded and the handler runs on `{}`, answering **200 on an empty update**. The guard stays underneath regardless of the helper's shape.
  - Path params and the query string now reach the route type as well, so `providers[':provider'].enabled.$put({ param: { provider: 'nope' } })` is a compile error. `typed-bodies.test.ts` asserts all 18 param/query routes alongside the 28 bodies.
  - Known Hono limit, left honest rather than contorted: a **single-member** required query union widens to `string | string[]` (`/models`'s `z.literal('codex')`). Two-or-more members and `.optional()` both narrow correctly. Runtime still rejects.
- [x] 4d. **zod 3.25 → 4.4** (owner call, to unblock `prettifyError`). Three source edits across the 13 zod-using files, all in `packages/cezar`: `z.ZodTypeDef` is gone (`parseStructured` → `z.ZodType<T, unknown>`, which cascaded into 7 of the 11 errors), `z.record` needs both key and value, and `resourcesSchema.default(() => ({}))` → **`.prefault()`** — v4 split the two meanings, `.default()` now takes a parsed *output* while `.prefault()` feeds its value through the schema as v3 did. `.passthrough()` (13 sites) and `z.ZodIssueCode` still work.
  - **Wire note:** v4 rewrote every default message (`Required` → `Invalid input: expected string, received undefined`). The suite stayed green only because all 67 error-text assertions happen to hit the 10 schemas carrying custom messages; the other 108 use defaults. BACKWARD_COMPATIBILITY.md pins `400 {error}` — status and shape — never the text, so this is within contract, but it is user-visible in cockpit toasts.
  - `prettifyError` itself was NOT adopted: it is multi-line and glyph-prefixed (`✖ …\n  → at task`), and the cockpit renders the string verbatim in a toast. **Adopted instead (owner, 2026-07-28): single-line path-prefixed.** `reject()` now emits `task: must be at most 100000 characters` — the same information `prettifyError` adds, on one line. The 9 schema messages that hand-wrote their own field name were trimmed so they no longer read `task: task must be…`; the field name now comes from the path for all 137 validated fields, not just those 9.
- [x] 5. **Resolved — two-thirds of this item was stale, and the third is blocked on packaging.** Surveyed all three named areas:
  - *Skills ordering* was never duplicated. The whole ruleset lives in `packages/web/src/lib/skills.ts`; the server only does `sort((a,b) => a.name.localeCompare(b.name))` in `skills.ts:104` and otherwise just persists `skillUsage`. Nothing to de-duplicate.
  - *Skills banner* lost its web half in #603 (`skills-banner.tsx` deleted, replaced by the opt-in `skills-import-panel.tsx`). The server banner is now the only surface, and it is Node-bound (`process.env`, fs) so it could not move anyway.
  - *Model presets* ARE duplicated (`cezar/src/core/model-presets.ts` vs `web/src/routes/new-task-form.ts`), and the two tables disagree on codex ids — but **it is not a live bug**: the web guard is only reachable through `modelsForRunner`, which returns early for every non-codex runner, and on the codex path both implementations agree. Consolidating it is **blocked by sequencing note 3**: `packages/cezar` has the api-client as a *devDependency* only, so moving runtime code there would give the published CLI an unresolvable import. Do it when the api-client is published.
  - Done here instead: retargeted six comments still pointing at the pre-monorepo `web/app/src/...` layout, and corrected the banner's claim that a cockpit twin keeps it in step.
- [x] 6a. **Broke the `HealthResponse` cycle** — the precondition for retiring the DTOs. `server.ts` imported `HealthResponse` *from the api-client* and annotated `readHealth` with it, so `/health`'s route type was the hand-written DTO reported back as if the server had proven it. `healthSnapshot` is now unannotated (its literal defines the shape) and the other four sites derive `HealthPayload` from it. `server.ts` no longer imports the api-client at all; the `Exact<>` drift guard still passes, so the inferred shape matches the DTO exactly.
- [x] 6b. **Deleted.** `dto/types.ts` is gone; `api-types.test.ts` shrank from 58 assertions to the two SSE shapes that have no route to derive from.
  - **Where the derived aliases go: `packages/web/src/api/types.ts`, not the api-client.** The api-client builds BEFORE `packages/cezar`, so importing `AppType` there inverts the build order. (`packages/cezar/src` no longer imports the api-client at all as of 6a — only its tests do, and the build config excludes tests — so the order *could* be flipped instead, keeping all 164 web import sites untouched. Rejected for now: it makes the browser package's types depend on the server package and touches the release/CI pipeline. Worth revisiting if the 164-site rewrite proves noisy.) The api-client keeps `client.ts`, `protocol/*`, `utils/*` and the two SSE frame types — the things that genuinely are not HTTP-typed.
  - **Order matters, and the obvious check is vacuous.** `client.ts`'s 74 functions still DECLARE their DTO return type, so `Awaited<ReturnType<typeof getRun>>` is that DTO by construction and proves nothing. The annotations must come off FIRST, then each alias derives from the route. Compare against the server directly — `Ok<Awaited<ReturnType<typeof client.api.v1….$get>>>` — and assert MUTUAL assignability, not one-way.
  - **First measurement, 4 types:** `WorkflowsResponse` and `ConfigResponse` are exact. `ApiRun` and `ProjectsResponse` are **wider than the server's actual return** — safe for readers, but anything CONSTRUCTING one (test fixtures, mocks) may stop compiling when the narrower inferred type replaces it. Expect that to be the bulk of the work, not the aliasing itself. Surveyed: **105 are response-derivable** from `AppType`, 11 request-derivable, 7 are dead exports nothing imports, and **2 cannot be derived** — `RunEvent` and `CheckoutProgressEvent` are SSE frame payloads, which Hono types as `text/event-stream`, so they stay hand-mirrored next to `protocol/`. Remaining blocker: `GroupResponse`/`GroupVariant`/`PickVariantResponse` are declared in `server.ts` and re-mirrored, so they need to become inferred-from-handler first. Note the derived aliases cannot live in the api-client — it builds *before* `packages/cezar`, so importing `AppType` there would invert the build order.

### Phase 4 — Base URL + one-command build/run — **DONE (83 of 83 calls)**
- [x] 1. Workspace-aware `dev`/`build`: `scripts/dev.mjs` delegates to workspace scripts, keeps the free-port probe, `CEZ_API_PORT` and either-dies-kills-both. Root build order is api-client → server → web → `check:pack`.
- [x] 2. `createCezarClient({ baseUrl })` exists and defaults to `''` (same-origin).
- [x] 3. **The cockpit moved to `/api/v1`** (amended decision 8). Call sites pass ROUTES (`/runs`), and `apiPath` owns the version + project scope — so the version is one fact, not sixty literals. A second helper, `resolveApiUrl`, upgrades server-minted URLs stored in old transcripts. Both EventSources, `runFileRawUrl` and the WebSocket path moved too.
- [~] 4. **The cockpit now uses `createCezarClient` — for one route so far** (`getProjects`). The claim that this was blocked on the pre-computed client type was WRONG, and measuring it settled the question: with `skipLibCheck` (which the web tsconfig has) the browser program imports `AppType` fine, typechecks in ~1.9 s, rejects an unknown path, and bundles. `client.ts` stays the boundary — the typed client builds and sends, `unwrap` applies the same `ApiError` contract — so a migrated call is indistinguishable to callers, which the existing client tests confirm unchanged.
  - **What actually gates the rest is step 5 below, not the type graph.** Inference is only as good as the handler's return type. Measured: `/runs`, `/projects`, `/workflows`, `/config` infer types that satisfy their DTOs exactly; `/health` infers `{[x: string]: JSONValue}` because its handler returns `Record<string, unknown>`, which is *weaker* than `HealthResponse`. Migrating such a route would lose type precision, so those wait until the server tightens its own `c.json()` types.
  - Cost accepted: `typecheck:web` now needs `packages/cezar/dist` (the `./app-type` export resolves there), so root `pretypecheck` builds the client and the server first — about +1.3 s.
  - Open decision for the project-scoped routes: `hc` paths are static, so a scoped call is either `cez.api.v1.p[':projectId'].runs` with `queryScope()` (one code path, but unscoped calls move to `/api/v1/p/default/…` on the wire) or a branch per call. Workspace routes have no such question, which is why the first migrated route is one.
  - **2026-07-28 — 65 of 83 functions migrated** (from 4). Three `hc` behaviours differ from `apiPath()` and had to be reconciled at the single `withApiBase`/`unscoped` choke point, all pinned by `client.test.ts`: (1) `hc` paths are static, so `queryScope()` writes `/api/v1/p/default/runs` where `apiPath` writes `/api/v1/runs` — `unscoped()` strips a whole `/p/default` segment when no scope is active, so the open decision above is settled WITHOUT moving the wire; (2) `hc` appends a bare `?` for an all-absent query object; (3) **`hc` never percent-encodes path params** — `replaceUrlParam` substitutes raw, so `cancelRun('a b/../c')` would have sent a path-traversing URL instead of `%20`/`%2F`. Every param the old code encoded is now passed pre-encoded.
  - **18 remain, with reasons.** 10 pass a query string the route does not yet validate (`/fs/browse?path`, `/skills?wait=1`, the five GitHub `?refresh` reads, `/runs/:id/files?path`, `/repo/commit/:sha?structured=1`) — each needs a `queryZodValidator` on the server before `hc` will accept a `query` argument. 3 answer `text/plain` or only build a URL. 5 are structural: `getRepoCommit` also infers a `'text'` branch that `unwrap` rejects, `registerProject` treats 409 as success, `checkoutProject`'s 200 branch is widened by a variable status, and `startTodo` parses its body in the handler on purpose (see 4c note).
  - **2026-07-28 (later) — the 10 query routes are validated, and 8 of them migrated: 73 of 83.** `queryZodValidator` now covers `/fs/browse`, `/skills`, `/skills/importable`, `/runs/:id/files`, `/github`, `/github/checks`, `/github/comments/:kind/:number`, `/github/prs/:number/{merge-state,changes}` and `/repo/commit/:sha` (13 query call sites, up from 3), each asserted into `AppType` by `typed-bodies.test.ts`.
    - **The schemas are permissive on purpose**, which is the whole design constraint here: these handlers compare `=== '1'` and treat everything else as false, so `?refresh=0` is a *successful* request today and `z.literal('1')` would silently make it a 400. `z.string().optional()` makes the key visible to the route type without moving acceptance an inch; the `=== '1'` and `Number.parseInt` comparisons stayed in the handlers untouched. Two routes are genuinely strict and stayed strict: `/github/checks` (`prs` required, `.min(1)` so `?prs=` keeps answering `missing prs query` rather than falling through to `invalid prs query`) and `/github/prs/:number/changes`, whose `?refresh=true` 400 is pinned by a test — its combined `safeParse` split into `paramZodValidator(number)` + `queryZodValidator(refresh)` with the same 400 sentence on both.
    - **One wire delta, uniform with the three routes validated earlier.** Hono's query validator hands a REPEATED key as an ARRAY (`?wait=1&wait=1` → `['1','1']`), where `c.req.query('wait')` took the first value — so a duplicated key is now a 400 instead of a 200. It costs one union per key to preserve (`z.union([z.string(), z.array(z.string()).transform((v) => v[0])]).optional()`, verified) if that is ever wanted; left alone so all 13 query routes behave the same way.
    - Validator arguments are evaluated at route REGISTRATION, so `prChangesParams`/`prChangesQuery` moved above `githubRoutes` — a schema declared below the route it validates is in its temporal dead zone (the family's other schemas survive only because they are read inside a handler or passed as a thunk).
    - **2 of the 10 stayed behind, both for the same structural reason** — the route answers a non-JSON body on *another* branch, so `hc` infers a member `unwrap`'s all-`'json'` constraint rejects: `getRepoCommit` (`c.text` legacy blob without `?structured=1`) and `getRunFile` (`c.body(ArrayBuffer)` for `?raw=1`). Relaxing the constraint to `ResponseFormat` would let a genuinely text-only route through inferring `never`, which is assignable to any declared return type — a runtime bug for a compile-time convenience, so it was not done. **10 remain overall.**
    - Adding a validator makes `query` a REQUIRED argument to `$get` even when every key in it is optional, so the two already-migrated skills reads gained `query: {}` (`hc` drops the empty search string, so the URL is unchanged).
  - **Two latent type bugs the migration exposed, both now fixed.** `Ok<R>` selected `S extends 200`, so every 201 route (`POST /runs`, `/workflows`, `/runs/:id/pr`, `/todos/:id/start`) inferred `never` — invisible while a DTO still annotated the call site, and it would have surfaced as broken callers at the exact moment 6b deleted them. And `jsonZodValidator` typed the REQUEST with zod's output, making `.optional().transform(…)`/`.default(…)` fields mandatory on the wire (`POST /runs` demanded `systemPrompt`); Hono's first validator parameter is a conditional type and therefore not an inference site, so both sides are now declared explicitly, as `@hono/zod-validator` does.
  - **2026-07-28 (2) — 73 of 83 migrated.** 10 routes gained a `queryZodValidator` so `hc` will accept a `query` argument; `typed-bodies.test.ts` now pins 18 param/query routes, so one reverting to `c.req.query('x')` fails to typecheck instead of failing nowhere.
  - **A wire regression the validators introduced, now fixed and guarded.** Hono hands a REPEATED query key to a validator as an array (`?wait=1&wait=1` → `['1','1']`), where the `c.req.query('k')` these routes used took the first value — so a plain `z.string()` turned a 200 into a 400. All 13 query schemas now share `queryValue`, which collapses the array back to its first element; `query-repeat-parity.test.ts` pins it. Note this bit the three routes validated in the FIRST pass too, not just the ten added here. `/models` needed `.pipe(z.literal('codex'))` rather than `.refine()` — in zod 4 only `pipe` narrows the output type.
  - **10 still untyped, all with a named reason.** 8 are the GitHub/skills/fs reads that now have query validators but were left for the next pass; 2 are structural — `getRepoCommit` and `getRunFile` each infer a NON-JSON branch (`'text'` for the legacy commit blob, `'body'`/ArrayBuffer for `?raw=1` image bytes) that `unwrap`'s all-`'json'` constraint rejects. Relaxing `unwrap` to `ResponseFormat` would fix both and simultaneously make a genuinely text-only route (`getRunDiff`) infer `never` — assignable to any declared type, i.e. a compile-time guard traded for a runtime bug. Left alone deliberately.
  - **For 6b:** `/skills/importable` infers `description: string | undefined` while `ImportableSkill` declares `description?: string`. The handler always writes the key (`{ name, description: skill.description }`), so the DTO describes the WIRE (JSON.stringify omits it) and the inferred type describes the object. One-line fix at the source before deriving: spread the key conditionally.
- [x] 5. **Configurable base URL — done.** `setApiBaseUrl`/`getApiBaseUrl` in the api-client; `apiPath`, `apiBase` and `resolveApiUrl` all compose it, and the typed client resolves it per request (the module is imported before boot configures it, and a `<meta>`-configured deployment must still take effect). The web resolves it in `main.tsx` from `<meta name="cez-api-base">` — run time, wins — falling back to `VITE_CEZ_API_BASE` at build time, defaulting to same-origin. `.env.example` documents it. Covers a full origin, a reverse-proxy path prefix, and re-basing URLs stored in old transcripts without double-prefixing.

### Phase 3z — zod-first contract (owner decision, 2026-07-28) — **DONE**

Supersedes 6b's "derive the aliases" plan. Every DTO becomes a **zod definition**, its TypeScript
type inferred from it, and the same definitions are usable by the server (validation), the web
(client-side validation) and the typed client.

**Packaging — settled: `packages/contract` (`@open-mercato/cezar-contract`), a real workspace
package.** An earlier pass copied the directory into the api-client at prebuild; review rejected
that ("copying like this is not nice", "needs a separate shared package"), and the objection was
right — a build-time copy hides a dependency the package graph should state. Both the service and
the api-client now depend on it normally. It publishes FIRST, because the SERVICE depends on it at
runtime and the service is public; the api-client staying private does not change that.

Superseded reasoning, kept because the alternatives are non-obvious: Canonical source is
`packages/cezar/src/contract/*.ts` (Node-free). A `sync-contract` prebuild copies those files into
`packages/api-client/src/contract/` (gitignored, `GENERATED` header) so tsc compiles them into the
api-client's own `dist`. Copying needs only the `.ts` source, so this has **no runtime dependency
in either direction, no build-order flip, and no publishing prerequisite** — the three costs that
sank the alternatives:
  - *Schemas in cezar, re-exported by api-client*: a zod schema is a VALUE, not a type, so
    re-exporting emits a real import — api-client would runtime-depend on the server package, and
    anyone installing the client would pull the CLI. (Types are free precisely because
    `import type` is erased; verified — api-client's `dist/*.js` names cezar only in comments.)
  - *Schemas in api-client, imported by cezar*: cleaner, but `packages/cezar` is published and
    would runtime-import a PRIVATE package, breaking the published CLI until api-client ships
    (sequencing note 3, an owner action).

Free structural guard: api-client's tsconfig sets `types: []`, so a `node:` import in a contract
file **fails api-client's build**. The Node-free invariant stops being a comment.

**Progress 2026-07-28.** Pipeline is BUILT and proven end to end on the health family:
`sync-contract.mjs` copies `src/contract/` into the api-client at prebuild, tsc compiles it into
that package's dist, the barrel re-exports it, and `packages/web/src/api/contract-pipeline.test.ts`
proves the cockpit receives the zod SCHEMA (runtime value) and not merely the inferred type.
`packages/cezar/tsconfig.json` gained `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`
(owner call), and all 673 relative specifiers across 198 files moved from `.js` to `.ts`; emitted JS
still rewrites to `.js`, so `dist` stays plain resolvable ESM.

The guard paid for itself on the first family — it rejected the hand-written health schema as WIDER
than the route, exposing two real defects: `latestVersion: update?.latest` typed a key as always
present that `JSON.stringify` drops, and `projects`/`bootProject` were optional in the DTO although
`workspaceSummary()` always returns them. Same `key: maybeUndefined` pattern then found and fixed at
`/skills/importable` and `/groups/:groupId/pick`. **This is the dominant defect class — expect it in
every remaining family.**

Schema drafts exist for runs, github, repo, projects, workspace, workflows, skills and agent-config
(written by a parallel pass that hit an API session limit before finishing). runs and github parity
assertions PASS. Two in `contract-parity.workflows.test.ts` are removed and named under KNOWN GAPS
rather than weakened: `pickVariantResponse` and `startTodoResponse` both embed `runRecordSchema`,
which is still narrower than the routes in a field type. **Finish `contract/runs.ts` first — it
unblocks those two and is the only thing standing between the drafts and being merged.**

Still to do centrally (deliberately not delegated — `server.ts`, `contract/index.ts` and
`dto/types.ts` are shared files that concurrent agents would corrupt): export each family from
`contract/index.ts`, delete its hand-written declarations from `dto/types.ts` (only the 6 health
types are gone so far, of 118), and apply the remaining handler fixes.

- [x] 1. Request schemas live in `packages/contract` (its own workspace package, private).
- [x] 2. Response schemas written — 9 families. (Was: the bulk of the work; none existed, every response
       shape is currently inferred from the handler's object literal.
- [x] 3. **Handlers are typed by their schemas**, not merely accompanied by them — otherwise, as noted,
       it. A schema sitting next to a handler that builds its payload inline is two definitions
       again — the same drift, relocated.
- [x] 4. Per-route mutual-assignability guard — 80 assertions across 5 files, so
       "the schema is the contract" is tested rather than asserted. This is the existing `Exact<>`
       check repointed from the hand-written interface to the schema.
- [x] 5. Done; api-client re-exports schemas + inferred
       types. **DTOs must be EXACTLY what the server returns** (owner, 2026-07-28) — `ApiRun` and
       `ProjectsResponse` are measurably WIDER today and are defects to fix, not shapes to keep.
       Success (2xx) branches only; the `{error}` 4xx/5xx arms stay out, since the client throws.
       In-payload 200 unions (`GithubChecksData`, `GithubPrMergeStateResponse`,
       `RegisterProjectResponse`, `ForgeInfo.available?`, `PlanResponse.name?`) ARE part of the
       success shape and stay.

**Phases 3 and 4 closed, 2026-07-28.**

`packages/api-client/src/dto/types.ts` is DELETED — zero hand-written API types remain. Every
shape is a zod definition in `packages/contract` with its type inferred; the SSE frames that have
no route to derive from (`RunEvent`, `CheckoutProgressEvent`) are zod too, in `contract/events.ts`.
70 mutual-assignability assertions across 5 parity files cover all 9 families, and non-vacuity was
verified empirically — five deliberately-wrong assertions were injected and all five failed to
compile.

Defects the guards found, every one fixed AT THE SOURCE rather than absorbed by a schema:
  - `registerFolder` returned an undiscriminated `{status, body}` pair, so the 200 of
    `POST /projects` and `/projects/checkout` also carried the error bodies. Now discriminated.
  - `workflowDef` was `Record<string, unknown>`, which hono maps to a `JSONValue` no zod schema
    can name. `WorkflowDef` became a real schema, which also deleted two `as unknown as` casts in
    `workflows/run.ts` and let `runRecordSchema` come under the strict check on every key.
  - The `key: maybeUndefined` pattern (a key always present in the TYPE that `JSON.stringify`
    drops from the WIRE) at `latestVersion`, `/skills/importable`, `/groups/:groupId/pick`.
  - `type: 'dir'` widening to `string` and erasing a discriminant consumers narrow on.

Two KNOWN GAPS remain, measured rather than assumed: `uiState`/`workspaceUiState` cannot be
asserted because both GET routes answer `Record<string, unknown>` verbatim, so the route type
names no key and every schema key is optional — the comparison is `true` for ANY key set. It was
documented instead of asserted, because a green vacuous check is worse than none.

**Phase 4 — 81 of 83 calls on the typed client.** `unwrap` now accepts a route that answers more
than one FORMAT on one path (owner's call: one endpoint, format chosen by the request), which
migrated `getRepoCommit` and `getRunFile`. It did NOT become permissive: `OkJson<R>` substitutes a
branded error type when a route has no JSON branch at all, because `Ok<R>` would otherwise be
`never` — assignable to every declared return type, i.e. a compile-time guard silently traded for
a runtime bug. Two calls stay hand-written, both named in the source: `startTodo` (its contract is
404-before-body-validation, which route middleware cannot express) and `checkoutProject`.

**Closed out, 2026-07-28 (owner follow-ups).** Three things I had recorded as done-or-impossible
turned out to be neither:

- **Content negotiation is real now.** `Accept` selects the representation on the two mixed-format
  routes and `Content-Type` confirms it, with `Vary: Accept`. Precedence: an explicitly PRESENT
  query flag wins (so `?raw=0` is an opt-out a header cannot re-decide), else the best `Accept`
  match, else the route's OWN established default — deliberately not "JSON by default", because
  `/repo/commit/:sha`'s no-flag answer has always been the text blob and §2 protects it. `*/*`
  matches nothing on purpose, so every existing caller is byte-identical. It does NOT simplify the
  client types: hono's response type is a union of what a handler CAN return and does not vary
  with the request, so `unwrap`/`OkJson` stay.
- **ui-state IS typeable — the earlier "unassertable" note was wrong.** The cause was that
  `readUiState`/`readWorkspaceUiState` were DECLARED `Promise<Record<string, unknown>>`, exactly
  the `/health` bug. Typing them by the contract made all four routes assertable. One genuine
  limit remains and is now precise rather than hand-waved: for the two OPEN bags the comparison
  runs as `Mutual<JSONParsed<Schema>, Route>`, because `c.json` bakes `JSONParsed<T>` into the
  route and `JSONParsed<unknown>` is hono's `JSONValue`, which zod cannot spell (and `z.json()`
  hits TS2589 under it). Non-vacuity is PINNED: a drifting named key and a required key the route
  never sends both fail.
- **Both remaining hand-written calls migrated.** `checkoutProject` needed no server change at all
  — `Ok<>` already resolved exactly, and the "variable status" I blamed has no 2xx member so it
  never entered the union. `startTodo`'s 404-before-body-validation contract was solved by
  middleware ORDER (`todoMustExist` before `jsonZodValidator`), not by giving up on middleware.
  That exposed a real bug in `jsonZodValidator`: `{ absent = null }` as a destructuring default
  silently overwrote an explicitly passed `absent: undefined` — the exact value that route needs.
  Options are now read by KEY PRESENCE. Caught by tests, not by review.

`mutate`/`get`/`request` are deleted from the cockpit client: with 83 of 83 calls on the typed
client they had no callers left.

### Phase 5 — Opt-in remote-access auth — **not started**
- [ ] 1. `auth.ts` (jwt verify middleware, `POST /api/auth/login`, scrypt verify) + `~/.cezar/` account and secret storage.
- [ ] 2. `remote-setup` CLI step; verify middleware wired after the origin guard, active only when config exists, skipping `/api/health` + login.
- [ ] 3. Resolve the SSE auth mechanism (httpOnly cookie vs short-TTL query token — the spec recommends the cookie for cross-origin).
- [ ] 4. Web login screen on `401`, token storage, auth on API + SSE.
- [ ] 5. Tests: 401/valid/expired, **local mode registers no auth middleware**, secret file `0600`.

### Phase 6 — Explicit OpenAPI spec — **not started**
- [ ] 1. `GET /api/openapi.json` emitted from the chained routes; drift-tested against the route manifest.

## Blockers and sequencing notes

1. **`AppType` drags the server's whole `.d.ts` graph** (`node:http`, `NodeJS`, `@hono/node-server`) into any consumer's program. It typechecks because every real tsconfig sets `skipLibCheck` (verified with an external consumer using `types: []`), but pointing the *browser* at it would re-import the Node types the mirror existed to keep out. **Emit a self-contained, pre-computed client type before migrating the web app.**
   - **Measured after chaining all 77 routes (2026-07-27): the cost is not the problem.** `server.d.ts` is 218 KB, the server typechecks in ~1.5 s, and an external consumer resolves the full 125-entry client type in ~0.2 s while still rejecting an unknown path. So the spec's "Hono RPC inference blow-up" edge case did not materialise, and the pre-computed type is wanted for *isolation* (keeping Node types out of the browser program), not for speed.
2. Order that follows: pre-computed type → web migrates onto `createCezarClient` (Phase 4.3–4.4) → chain the remaining 67 registrations (3.3) → delete the mirror (3.6).
3. **Publish the api-client before Phase 3 makes it a runtime dependency.** While it is `private`, the service may only import it in tests. The moment `packages/cezar` imports the DTOs from it at runtime, the published CLI gains a dependency npm cannot resolve — `npm i -g @open-mercato/cezar` and `install-as-command --mode global` both break. Publishing also needs the release token scoped to `@open-mercato/*` (a package-list token cannot create a new package; npm reports `E404 … PUT`).
4. **pnpm migration** was considered and deliberately deferred (owner, 2026-07-25): it touches the same five `npm_execpath` scripts and three workflows this branch just rewrote, and `check:pack`'s contract is npm's `pack --dry-run --json` output, which needs a redesign rather than a port. Do it as its own PR after this lands and **before** the Phase 3 chaining grind, so that work happens once on the final toolchain.

## Validation state (2026-07-25)

`npm run typecheck` green (3 packages) · `npm run build` green · `check:pack` ok (345 files, 68 under `web/dist`) · `npm run test:package` 8/8 including the tarball install + cold CLI run · cold-booted `packages/cezar/dist/index.js` serves the SPA, the logo, hashed assets and both API spellings · an external typed consumer drove that server through `createCezarClient<AppType>`.

`npm test` shows ~30 failing files on a loaded macOS dev machine — the real-`git`/CLI-spawning suites timing out at 5 s. The same set fails on a clean `HEAD`, and each passes in isolation; two genuine finds along the way were fixed (the e2e launcher unit test resolving `.ai/scripts` to the package instead of the repo, and the two new `/api/health`-based suites needing a real timeout, since a cold health read shells out to probe agent CLIs).
