# Headless cezar: independent server as a standalone API service + typed client, opt-in remote auth

> Addresses the headless/API half of the #557 follow-up
> ([comment 5056868318](https://github.com/open-mercato/cezar/issues/557#issuecomment-5056868318)):
> *"refactor cezar so it can operate fully in headless mode … a clean, well-defined API that
> can be used independently of the main application"* so cezar can power other products (Sandbox).
> The reusable-React-components half of that comment is a **separate** effort and is out of scope here.

## TLDR
`cezar` ships as one npm package whose server+CLI (`src/`) and React SPA (`web/app/`) share a single `package.json`, dependency tree, and build. This spec turns the server into a **standalone headless service** with its own `package.json`, and makes the frontend one client of it, joined **only** by a new `@open-mercato/cezar-api-client` package that exports the server's `AppType` wrapped in Hono's RPC client (`hc<AppType>`), plus DTO types and pure helpers. The current hand-mirror (`web/app/src/api/types.ts`) and its cross-boundary drift test (`src/server/api-types.test.ts`) are **deleted** — the typed client becomes the single source of the contract. To make "used independently of the main application" real and safe, the service gains an **opt-in remote-access mode**: local use stays zero-config (loopback + same-origin guard, no auth), but exposing cezar beyond loopback (e.g. reaching it from your phone over an exposed port/tunnel) is gated behind a "remote access setup" that creates an account and enables **built-in JWT auth** (`hono/jwt`) + CORS for configured origins. A committed later phase publishes an **explicit OpenAPI specification** as the language-neutral public contract, with `hc` as the convenience client on top.

## Resolved decisions (confirmed with owner 2026-07-23)
1. ~~**In-place layout, least churn.** Root stays the server+CLI package (`@open-mercato/cezar`) — same name, `bin`, `files`, no source moves. `web/app/` gains its own `package.json`; a new `web/api-client/` package is added; root gains `workspaces`.~~ **Superseded 2026-07-25 — see decision 5.**
2. **Two access modes, auth opt-in.** *Local* (default, zero-config) keeps today's posture: loopback bind + same-origin origin-guard (`src/server/server.ts:836`), **no auth to configure**. *Remote access* is **opt-in** — a "remote access setup" creates an account and enables **built-in JWT auth** (Hono's `jwt` middleware) + CORS for the configured origin(s). This is the safety layer for the "expose a port, reach cezar from your phone / from a workflow" case, and an alternative to the existing "reverse proxy must provide auth" hosted mode.
3. **Contract now = Hono RPC; OpenAPI is a committed later goal.** The api-client exports `hc<AppType>` + DTO types + helper utils (near-term). A dedicated later phase adds an **explicit OpenAPI spec** served by the service, for language-neutral/independent consumers.
4. **Reusable React components are out of scope** here (the other half of the #557 comment) — tracked separately; the shared session renderer already has `.ai/specs/2026-07-21-shared-session-renderer.md` / PR #580.

## Amended decisions (confirmed with owner 2026-07-25, during Phase 0–2)

These three reverse or extend the original ones. Each was taken with the code in front of us; the reasoning is recorded because the original decision documented the opposite.

5. **Full `packages/*` layout; the root publishes nothing.** Reverses decision 1 and the "Full monorepo reshuffle" rejection below. The forcing argument was not tidiness: with the root doubling as the published package, (a) `api-client` had no way to resolve `@open-mercato/cezar` in-repo, so the `import type { AppType }` edge the whole design rests on could not exist as a real dependency, and (b) the root's `dependencies` (the server's runtime deps) and `devDependencies` (the toolchain of three packages) were the same field doing two jobs. The layout is now `packages/{cezar,api-client,web}` + `alias-cezar`, root `private: true`. The churn the original decision feared was real but one-off and mechanical; it is done.
   - **The CLI stays with the server.** It is not a layer over the service but the same program: `packages/cezar/src/index.ts` boots `startServer` *and* `RunManager`/`RunStore`/the workspace registry, and `cezar run` executes a workflow with no server at all. Splitting it would require extracting a `core` package first, and the seam is not obvious. The tarball must also ship `web/dist`, so service + CLI + cockpit assets are one artifact by construction. Revisit only when a second consumer of `core` exists.
6. **The API is versioned from the start: `/api/v1/*`.** Narrows the "no change to the HTTP wire surface" non-goal — additively. A family that has been chained is mounted a second time under `/api/v1` (and `/api/v1/p/:projectId`); the unversioned paths stay frozen for the bookmarklets and scripts that already call them. This exists so the *public, typed* surface has a spelling that is allowed to evolve, while BC §2 stays frozen. `v1-parity.test.ts` asserts the twins answer byte-identically until one deliberately diverges.
7. **`@open-mercato/cezar-api-client` is `private` for now — internal to the workspace.** (Amended again 2026-07-27; the first form of this decision was "published from the start".) The package is in the release set and stamped in lockstep, but never handed to npm. Two reasons: nothing published depends on it yet (it is a devDependency of the service, used by tests; the cockpit bundles it from source), and its surface is *designed to shrink* — it still carries the hand-written DTOs, which are deleted family by family as routes are chained, so publishing now would advertise a contract that changes materially every release. The release pipeline gates publication on npm's own `private` flag, so opening it up is one line in its manifest and no change to the release code.
   - **The trigger to publish is Phase 3**: the moment the service imports the DTOs at runtime, the api-client becomes a real `dependency` of the published CLI, and an unpublished dependency would make `@open-mercato/cezar` uninstallable. Publish it *before* making that move, not after.
   - Publishing also needs the release token to be scoped to `@open-mercato/*` rather than a package list — a token restricted to selected packages cannot create a new one, and npm reports that as a misleading `E404 … PUT`. See `docs/publishing.md`.

## Problem Statement
Cezar cannot today be operated as an independent headless service, for three reasons:

- **Server and web are one package.** All React/Vite/Tailwind/Radix deps live in root `devDependencies` (bundled by Vite, never runtime deps of the CLI); the six server runtime deps live in `dependencies`. There is no manifest describing "the server" or "the web app" alone, and no way to build/run/consume one without the other. `scripts/dev.mjs` couples the two processes (shared `CEZ_API_PORT`, Vite `/api` proxy), and the client is hardwired same-origin and root-relative (`web/app/src/api/client.ts`: every path is `/api/...`, no base URL).
- **The contract is maintained by duplication.** The frontend can't import the server's module graph (it would drag `node:*` and NodeNext `.js` resolution into the bundle — see the header of `web/app/src/api/types.ts`). So response types are hand-copied into `web/app/src/api/types.ts` (~42 KB) and the event/tool-display protocol into `web/app/src/protocol/*`, kept honest only by a server-side drift test `src/server/api-types.test.ts` that reaches across the boundary. Every contract change is a two-file edit plus a guard. There is no client another product could just install and consume.
- **No safety for remote exposure.** The only perimeter is "loopback bind + same-origin + Host allowlist" (`server.ts:802-900`). The existing hosted mode (`CEZ_REMOTE`, `server-install`, `--external-proxy`) explicitly **delegates TLS+auth to a reverse proxy** — "that proxy must provide TLS + auth." So the moment you want to reach cezar from your phone by exposing a port or opening a tunnel, you either stand up a proxy with auth or run **unauthenticated**, and every mutating route can start a shell-capable agent (`server.ts:802-833`). There is no built-in, opt-in way to require a login.

What is **not** broken and must be preserved: the runtime boundary is already clean (no runtime cross-imports, no shared DB — "zero database"), and the HTTP surface is a documented protected surface (`BACKWARD_COMPATIBILITY.md §2`) guarded by `route-parity.test.ts` (three-way alias parity), `bc-route-inventory.test.ts` (inventory), and a frozen SSE event vocabulary.

## Goals and Non-goals
### Goals
- Server runs as a **standalone headless service** with its own `package.json`; the web app is one client of it.
- A single installable package is the only boundary crossing: a **typed API client** (`hc<AppType>`) + DTO types + pure helpers, so other products can consume cezar's API cleanly.
- **Opt-in remote-access auth**: local stays zero-config; remote exposure requires a login (built-in JWT), so exposing a port is safe by default.
- Delete the hand-mirror and its drift test — the client is the single source of the contract.
- One command (`cezar` / `npm run dev` / `npm run build`) still runs and builds both; the published CLI still bundles `web/dist`.
- **Committed later phase:** an explicit **OpenAPI specification** as the language-neutral public contract.

### Non-goals
- **Reusable React components / embedding cezar UI in another app's layout** (the other half of #557) — separate effort.
- ~~No move of `src/`~~ (superseded by amended decision 5 — `src/` moved to `packages/cezar/src/`), no rename of the published `@open-mercato/cezar` package (still holds: same name, same `bin`).
- No **breaking** change to the HTTP wire surface: every existing path, status code, the `/api` + `/api/p/:projectId` double-mount and the SSE event names answer exactly as before. Narrowed by amended decision 6 — chained families gain an *additive* `/api/v1` twin. This is packaging + type-plumbing + additive layers, not an API redesign.
- Multi-user / RBAC / SSO. The account model is single-owner (a personal cockpit); richer identity is future work.

## Proposed Solution
Three moves, largely independent:

**1. Extract the boundary into `@open-mercato/cezar-api-client`** — a Node-free leaf package that owns DTO types, pure utils, SSE/protocol types, and the `hc<AppType>` client (+ the rich wrapper: `ApiError`, project-scope prefixing, SSE subscribe helpers, base-URL). web depends on it (Vite bundles it); server depends on it for the shared DTOs/utils it should stop duplicating. The only server tie is `import type { AppType }` — erased at build, so no runtime cycle and no Node code leaks into the web bundle.

**2. Make the API a first-class contract via Hono RPC.** Hono infers endpoint types from the app's *type*, which accumulates only through **method chaining**. cezar registers routes as imperative statements (`const app = new Hono(); app.get(...)`, and the project-scoped `const api = new Hono<ProjectApiEnv>(); api.get(...)` double-mounted at `server.ts:3209-3210`), so `typeof app` captures **zero** routes. The core work is refactoring registration into a chained builder and `export type AppType = typeof app`, done **route-family by family** behind the unchanged parity tests. An explicit **OpenAPI** document (Phase 6) is layered on the same routes later.

**3. Add opt-in remote-access auth.** Introduce a `cezar remote-setup` step (or extend `server-install`) that creates a single owner account (username + `crypto.scrypt` password hash) and a JWT signing secret, stored in `~/.cezar/` (0600, a §9 protected surface). When that config is present, an `hono/jwt` verify middleware guards `/api/*` (except `/api/health` and the login route), a `POST /api/auth/login` issues a JWT, and CORS is enabled for the configured origin(s). When the config is **absent** (the default), nothing changes — local mode is exactly as today. This makes "expose cezar and reach it from your phone" safe without requiring a reverse-proxy auth stack, while `--external-proxy` (proxy provides auth) remains valid for those who prefer it.

**Alternatives considered and rejected:**
- *OpenAPI as the near-term contract mechanism.* Viable and now a committed later goal, but it requires authoring response zod schemas for a surface whose responses are hand-typed today, and its generated client would fight the bespoke `client.ts`. `hc` reuses the server's own types with zero schema authoring and keeps the rich client as a thin wrapper; OpenAPI lands in Phase 6 as the public, language-neutral surface once the routes are chained (chaining also makes zod-response adoption incremental).
- ~~*Full monorepo reshuffle into `packages/*`.* Rejected: every path-coupled asset (`resolveWebDir` at `server.ts:3283`, `check-pack.mjs`, `bc-route-inventory` `REPO_ROOT=../..`, `tsconfig rootDir:src`, `files`) resolves relative to the package root; moving the server multiplies churn for no benefit when it can stay put and declare `workspaces`.~~ **Adopted instead — see amended decision 5.** The path-coupled assets were exactly the churn predicted, and each was a one-line fix; what the rejection missed is that root-as-package leaves the client→server type edge unrepresentable in-repo.
- *Keep the hand-mirror, just split packages.* Rejected — the mirror + drift test is exactly the maintenance coupling we remove.
- *Auth always-on, or reverse-proxy-only.* Rejected: always-on breaks the zero-config local cockpit that is cezar's whole pitch; reverse-proxy-only (today's model) leaves the common "expose a port from a workflow / phone" case unauthenticated. Opt-in built-in JWT serves both.
- *Session cookies / OAuth / multi-user.* Rejected for v1 — overkill for a single-owner personal cockpit. JWT bearer (+ a cookie fallback only where SSE forces it, see Edge Cases) is the minimal safe surface.

## Architecture
Three packages under one npm workspace root; the server package is unmoved.

```
/ (root = @open-mercato/cezar — server + CLI, PUBLISHED)
  package.json          # + "workspaces": ["web/app","web/api-client"]; keeps name/bin/files;
                        #   + "@open-mercato/cezar-api-client" in dependencies
  src/                  # UNCHANGED locations; intra-src ".js" specifiers untouched
    server/server.ts    # routes → chained; exports the app; origin-guard + double-mount intact
    server/app-type.ts  # NEW: export type AppType = typeof app  (type-only boundary surface)
    server/auth.ts      # NEW: jwt verify middleware, login handler, scrypt verify (remote mode)
    workspace/…         # NEW: account + jwt-secret read/write under ~/.cezar/ (§9 files)
  scripts/dev.mjs       # one-command dev — delegates to workspace scripts
  scripts/check-pack.mjs# UNCHANGED — still asserts web/dist ships in the CLI tarball
  web/
    api-client/         # NEW @open-mercato/cezar-api-client — Node-free LEAF, PUBLISHED
      src/index.ts      # hc<AppType> factory + DTO/helper re-exports; attaches Authorization
      src/dto/*         # DTO types — single source; server imports these for c.json() typing
      src/utils/*       # scopeApiPath, validators (moved from web/app/src/api + lib)
      src/protocol/*    # SSE / ui-event / tool-display types (moved from web/app/src/protocol)
      src/client.ts     # rich wrapper: ApiError, scope prefixing, base URL, token, SSE helpers
    app/                # NOW @open-mercato/cezar-web — private SPA, own package.json
      package.json      # relocated react/vite/tailwind/radix/etc. + dependency on api-client
      vite.config.ts    # outDir stays ../dist (web/dist); base URL configurable
      src/…             # imports "@open-mercato/cezar-api-client"; adds a login screen (remote mode)
    dist/               # Vite output — UNCHANGED (server's resolveWebDir serves it)
```

**Dependency direction (no runtime cycle).** api-client is a runtime leaf (DTOs, utils, protocol types, `hc` client); its only server tie is `import type { AppType }` (erased). web → api-client (bundled). server → api-client (for shared DTOs/utils). Because the server is published and imports these, **api-client is published and added to the server's `dependencies`** (additive, safe under §6).

**Why the server stays put.** `resolveWebDir()` (`server.ts:3283`), `files`/`check-pack.mjs`, and `bc-route-inventory`'s `REPO_ROOT=../..` all resolve to the package root; `tsconfig.json` has `rootDir:src`. Leaving `src/`, `scripts/`, `web/`, `BACKWARD_COMPATIBILITY.md` in place keeps them byte-identical.

**Auth wiring (remote mode only).** The existing `/api/*` middleware chain (`server.ts:836`) gains a JWT verify step ordered **after** the host/origin guard and **before** handlers, active only when remote-auth config exists and skipped for `/api/health` (still CORS-open) and `POST /api/auth/login`. `isHostedMode()`/`resolveCapabilities` already distinguish local vs hosted; remote-auth is a new capability flag alongside them. Local mode adds **zero** middleware — the byte-for-byte same behavior as today.

## Data Model
No change to existing on-disk formats (`.ai/cezar/*`, workflow YAML, skills MD). One **new, optional** config group under `~/.cezar/` (§9 per-user files, mode 0600), written only by `remote-setup`:
- account: `{ username, passwordHash (scrypt), createdAt }`
- `jwtSecret`: random bytes for signing/verifying tokens
- optional `cors: { origins: string[] }` for cross-origin consumers (e.g. Sandbox)

Absent ⇒ local mode, no auth (default). Present ⇒ remote-auth enforced. No `schemaVersion` bump for existing files; the new group is additive and its absence is the pre-existing behavior.

Contract types move (not a persisted change): response/domain types from `web/app/src/api/types.ts` + the server's exported interfaces → api-client `src/dto/*` (single source, imported by both); SSE/ui-event/tool-display → api-client `src/protocol/*`.

## API Contracts
**Wire surface unchanged** for every existing route: paths, methods, status codes, the `/api` ↔ `/api/p/:projectId` three-way alias parity, `default` alias, `/api/health` CORS-openness, and SSE event names (`run`, `run-event`, `run-deleted`, `todos`, `usage`, `ping`, `project-added`, `project-removed`, `checkout-progress`).

**Additive:**
- `POST /api/auth/login` `{ username, password }` → `{ token }` (JWT). Present/active only in remote-auth mode; CORS-enabled for configured origins.
- In remote-auth mode, `/api/*` (except `/api/health` and the login route) requires `Authorization: Bearer <jwt>`; missing/invalid → `401`. In local mode these routes carry no auth (unchanged).
- Optional `GET /api/auth/me` → the current identity (for the web login state).

**Type contract:**
- New type-only export `@open-mercato/cezar/app-type` → `AppType`.
- New package `@open-mercato/cezar-api-client` exporting `createCezClient({ baseUrl?, token? })`, DTO types, protocol types, helpers. The client attaches `Authorization` when a token is set.
- `web/app/src/api/types.ts` and `src/server/api-types.test.ts` **deleted** once the shared source + `AppType` inference cover the surface.
- Phase 6: `GET /api/openapi.json` (language-neutral public contract), drift-tested against the route manifest.

## UI/UX
No change for local users — the cockpit looks and behaves identically. In **remote-auth mode**, the web app shows a **login screen** on `401`, stores the JWT, and attaches it to API + SSE requests; a "remote access setup" flow (CLI wizard, mirroring `server-install`) creates the account and prints the URL/credentials. Developer-facing: web app code imports from `@open-mercato/cezar-api-client` and gets compile-time errors for wrong paths/bodies/response shapes.

## Edge Cases & Failure Scenarios
- **SSE can't send `Authorization` headers.** Native `EventSource` forbids custom headers, so in remote-auth mode the three SSE streams (`/api/events`, `/api/runs/:id/events`, `/api/workspace/events`) need either a **short-lived token query param** (`?access_token=`, accepting URL/log exposure of a short-TTL token) or an **httpOnly JWT cookie** (cleaner, but cross-origin then needs `SameSite=None; Secure` + credentialed CORS). **Recommend the cookie path** for cross-origin and query-param only as a same-origin fallback — resolve during the auth phase.
- **Untyped-until-chained families.** A route family not yet chained isn't RPC-typed; the wrapper accepts a loose fallback so web compiles throughout, tightening per family.
- **Hono RPC inference blow-up** on ~78 routes → export a **pre-computed client type** from one compiled `.d.ts`; keep any intractable family hand-typed in the wrapper.
- **Node code leaking into the web bundle** → `AppType` import is `import type` only; a CI check forbids `node:*` imports in api-client/web (the invariant the mirror exists to protect, now structural).
- **Dev proxy origin-guard interaction** (`server.ts:865-878`, the `isDevProxy` exemption) → base-URL default stays `''` (same-origin) so it's unchanged.
- **Published-package resolution** — server now runtime-depends on api-client; guard with `npm pack --dry-run` + cold `node dist/index.js` boot + existing `check:pack`.
- **Auth-secret handling** — scrypt for passwords, constant-time compare, JWT secret 0600 in `~/.cezar/`; never logged; `remote-setup` refuses to enable remote binding without an account.

## Risks & Impact Review
- **Chained-registration refactor touches the 3329-line `server.ts`.** De-risk: family-by-family, runtime-invariant, `route-parity`/`bc-route-inventory`/e2e green after each family; the diff is mechanical (statements → chain).
- **Auth is security-critical.** De-risk: opt-in (local unaffected), minimal surface (single owner, scrypt, `hono/jwt` — no new deps), explicit tests for 401/valid-token/expired-token and that local mode adds no middleware. The default posture (loopback + same-origin) is unchanged and remains the safe default.
- **Contract regression while deleting the mirror.** De-risk: keep `api-types.test.ts` (repointed to the shared/generated types) until `AppType` + shared DTOs demonstrably cover the surface, then delete.
- **Packaging regression** (CLI stops bundling UI / can't resolve api-client) → `check:pack` + `npm pack --dry-run --json` (asserts `web/dist/index.html` + assets) + cold CLI boot in CI.
- **Backward compatibility:** additive npm dep + additive auth routes (§6/§2 safe); wire surface frozen. No user migration; auth config absent = today's behavior.

## Phasing

Live status is tracked in `.ai/runs/2026-07-23-independent-server-web-packages.md` — that file, not this one, is where "what is done" lives.

- **Phase 0 — Scaffold api-client (additive).** ✅ done
- **Phase 1 — Export `AppType`, chain first family, stand up `hc`.** ✅ done — three families chained (health, agent-config, workflows), not one
- **Phase 2 — Web gets its own `package.json`, points at api-client.** ✅ done
- **Phase R — Repo restructure into `packages/*`; root private (amended decision 5).** ✅ done — not in the original plan
- **Phase 3 — Chain remaining families, single-source the DTOs, delete the mirror + drift test.** ⚠️ partial — DTOs relocated and consumed through the package, but 67 route registrations are still unchained, so the mirror and its drift test remain
- **Phase 4 — Configurable base URL; workspace-aware `dev`/`build`.** ⚠️ partial — dev/build done; the base URL exists in the client but the cockpit still fetches same-origin
- **Phase 5 — Opt-in remote-access auth (`remote-setup`, JWT, login screen, CORS).** ❌ not started
- **Phase 6 — Explicit OpenAPI spec served + drift-tested (public contract).** ❌ not started

## Implementation Plan
### Phase 0 — Scaffold api-client
Create `web/api-client` (`@open-mercato/cezar-api-client`) with `package.json` + `tsconfig`. Move the Node-free shared pieces first: `web/app/src/api/project-scope.ts`, `web/app/src/protocol/*`, pure validators/utils. Leave re-export shims at old web paths. Root gains `workspaces`; add placeholder `web/app/package.json`. Suite green.

### Phase 1 — `AppType` + first family + `hc`
Add `src/server/app-type.ts` (`export type AppType = typeof app`) + a `./app-type` entry in the server package `exports`. Chain one small self-contained family in `server.ts`. In api-client add `src/client.ts` = `hc<AppType>` wrapped with `ApiError`/`scopeApiPath`/SSE lifted from `web/app/src/api/client.ts`, and the `src/index.ts` barrel. Prove typed end-to-end for that family. Parity tests green.

### Phase 2 — Web package
Move all React/Vite/Tailwind/Radix/etc. deps from root `devDependencies` into `web/app/package.json` (`@open-mercato/cezar-web`, `private`) + dependency on api-client. Repoint web imports `./api/{types,client}` → the package (keep shims). Update `web/app/vite.config.ts` (outDir stays `web/dist`) + split vitest config. `npm run dev` still boots both.

### Phase 3 — Chain the rest; single-source DTOs; delete the mirror
Chain remaining route families. Move response types → `web/api-client/src/dto/*`; server imports them for `c.json()` typing (optionally `z.infer` of zod response schemas per family). Migrate the other mirrored logic (model presets, skills ordering, skills banner) into api-client. **Delete** `web/app/src/api/types.ts` + `src/server/api-types.test.ts` once covered.

### Phase 4 — Base URL + one-command build/run
Same-origin-default base URL (`import.meta.env.VITE_CEZ_API_BASE ?? ''`, plus optional runtime `<meta>`/`window.__CEZ_API_BASE__`) prepended in `send()`, `runFileRawUrl`, both `EventSource` URLs — default `''` keeps bundled-CLI behavior byte-identical. `scripts/dev.mjs` → workspace scripts (`npm -w …`), keeping free-port probe, `CEZ_API_PORT`, `/api` proxy, either-dies-kills-both. Root `build`: api-client → server `tsc` → web `vite build` → `check:pack`.

### Phase 5 — Opt-in remote-access auth
Add `src/server/auth.ts` (jwt verify middleware, `POST /api/auth/login`, scrypt verify) and `~/.cezar/` account + secret read/write. Add a `remote-setup` CLI step (or extend `server-install`) that creates the account, generates the secret, sets CORS origins, and prints the URL. Wire the verify middleware into `/api/*` after the origin guard, active only when config exists; skip `/api/health` + login. Resolve the SSE-auth mechanism (cookie vs query token) here. Web app: login screen on `401`, token storage, `Authorization`/cookie on API + SSE. Tests: 401/valid/expired, local-mode-adds-no-middleware, secret file perms.

### Phase 6 — Explicit OpenAPI spec (public contract)
With routes chained, layer `hono-openapi` (or `@hono/zod-openapi` per family) to emit `GET /api/openapi.json` from the same schemas; drift-test the documented paths against `projectRouteManifest(app)` ∪ workspace routes (same philosophy as `bc-route-inventory`). Optionally generate a language-neutral client for non-TS consumers. Additive; does not replace `hc`.

## Test Strategy
- **Green suite after every phase:** `npm run typecheck` (server + web) + `npm test` — especially `route-parity`, `bc-route-inventory`, and (until deleted) `api-types`.
- **Typed client:** web-side type test that a migrated endpoint's response is inferred (no `any`) and a wrong path/body is a compile error.
- **Auth:** login issues a valid JWT; protected route rejects missing/invalid/expired token (`401`) and accepts a valid one; `/api/health` stays open; **local mode registers no auth middleware** (assert byte-identical behavior); secret file is `0600`; SSE auth works via the chosen mechanism.
- **One-command run:** `npm run dev` boots server + Vite on one pinned port; browser loads live data over the same-origin `/api` proxy.
- **CLI bundles both:** `npm run build` + `npm pack --dry-run --json` — `check:pack` passes, tarball has `web/dist/index.html` + assets; cold `node dist/index.js` boot serves the SPA.
- **Headless/independent:** run `dev:server` alone and drive the API through `createCezClient()` from a throwaway consumer (no web app) — proves independent usability; verify a same-origin reverse-proxy topology and (remote mode) a cross-origin + JWT topology.
- **Security invariants:** cross-origin writes still rejected in local mode; only `/api/health` CORS-open unless remote CORS configured.

## Out of scope
- **Reusable React components / embedding cezar UI in another product's layout** (the other half of #557) — separate spec.
- Multi-user / RBAC / SSO / OAuth — v1 auth is single-owner JWT.
- Moving `src/` or renaming/splitting the published `@open-mercato/cezar` CLI package.
- Any change to the HTTP wire surface, SSE event vocabulary, or existing on-disk state formats.
```
