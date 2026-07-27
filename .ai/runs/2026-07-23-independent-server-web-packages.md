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

### Phase 3 — Chain the rest; single-source DTOs; delete the mirror — **~25%**
- [x] 1. DTOs relocated to `packages/api-client/src/dto/types.ts` and exported from the barrel. Forced by the restructure: once the mirror lived in `packages/web`, the server's drift guard reached across a package boundary and broke `rootDir` — which is exactly the coupling this spec removes.
- [x] 2. All 138 web files import DTOs from `@open-mercato/cezar-api-client`; `api-types.test.ts` imports the package too, not a relative path.
- [ ] 3. **Chain the remaining route families.** 8 of ~75 routes are chained; **67 registrations are still loose statements** (52 on `api`, 15 on `app`). This is the bulk of the remaining work and the gate on everything below it.
- [ ] 4. Server imports the shared DTOs for its own `c.json()` typing; the api-client moves from the server's `devDependencies` to `dependencies`.
- [ ] 5. Migrate the other mirrored logic (model presets, skills ordering, skills banner) into the api-client.
- [ ] 6. **Delete `dto/types.ts` (43 KB) + `api-types.test.ts`** once `AppType` demonstrably covers the surface. Neither can go until step 3 is finished.

### Phase 4 — Base URL + one-command build/run — **half**
- [x] 1. Workspace-aware `dev`/`build`: `scripts/dev.mjs` delegates to workspace scripts, keeps the free-port probe, `CEZ_API_PORT` and either-dies-kills-both. Root build order is api-client → server → web → `check:pack`.
- [x] 2. `createCezarClient({ baseUrl })` exists and defaults to `''` (same-origin).
- [ ] 3. **The web app does not use it.** `packages/web/src/api/client.ts:158` still calls `fetch(scopeApiPath(path))` — hardwired same-origin, with no `VITE_CEZ_API_BASE`, no runtime `<meta>`/`window.__CEZ_API_BASE__`, and no base URL on `runFileRawUrl` or either `EventSource`.
- [ ] 4. The cockpit still talks to the server through the hand-written client, so nothing in the browser exercises the typed path yet.

### Phase 5 — Opt-in remote-access auth — **not started**
- [ ] 1. `auth.ts` (jwt verify middleware, `POST /api/auth/login`, scrypt verify) + `~/.cezar/` account and secret storage.
- [ ] 2. `remote-setup` CLI step; verify middleware wired after the origin guard, active only when config exists, skipping `/api/health` + login.
- [ ] 3. Resolve the SSE auth mechanism (httpOnly cookie vs short-TTL query token — the spec recommends the cookie for cross-origin).
- [ ] 4. Web login screen on `401`, token storage, auth on API + SSE.
- [ ] 5. Tests: 401/valid/expired, **local mode registers no auth middleware**, secret file `0600`.

### Phase 6 — Explicit OpenAPI spec — **not started**
- [ ] 1. `GET /api/openapi.json` emitted from the chained routes; drift-tested against the route manifest.

## Blockers and sequencing notes

1. **`AppType` drags the server's whole `.d.ts` graph** (`node:http`, `NodeJS`, `@hono/node-server`) into any consumer's program. It typechecks today because every real tsconfig sets `skipLibCheck` (verified with an external consumer using `types: []`), but pointing the *browser* at it would re-import the Node types the mirror existed to keep out. **Emit a self-contained, pre-computed client type before migrating the web app** — the spec's own "Hono RPC inference blow-up" edge case, now concrete.
2. Order that follows: pre-computed type → web migrates onto `createCezarClient` (Phase 4.3–4.4) → chain the remaining 67 registrations (3.3) → delete the mirror (3.6).
3. **Publish the api-client before Phase 3 makes it a runtime dependency.** While it is `private`, the service may only import it in tests. The moment `packages/cezar` imports the DTOs from it at runtime, the published CLI gains a dependency npm cannot resolve — `npm i -g @open-mercato/cezar` and `install-as-command --mode global` both break. Publishing also needs the release token scoped to `@open-mercato/*` (a package-list token cannot create a new package; npm reports `E404 … PUT`).
4. **pnpm migration** was considered and deliberately deferred (owner, 2026-07-25): it touches the same five `npm_execpath` scripts and three workflows this branch just rewrote, and `check:pack`'s contract is npm's `pack --dry-run --json` output, which needs a redesign rather than a port. Do it as its own PR after this lands and **before** the Phase 3 chaining grind, so that work happens once on the final toolchain.

## Validation state (2026-07-25)

`npm run typecheck` green (3 packages) · `npm run build` green · `check:pack` ok (345 files, 68 under `web/dist`) · `npm run test:package` 8/8 including the tarball install + cold CLI run · cold-booted `packages/cezar/dist/index.js` serves the SPA, the logo, hashed assets and both API spellings · an external typed consumer drove that server through `createCezarClient<AppType>`.

`npm test` shows ~30 failing files on a loaded macOS dev machine — the real-`git`/CLI-spawning suites timing out at 5 s. The same set fails on a clean `HEAD`, and each passes in isolation; two genuine finds along the way were fixed (the e2e launcher unit test resolving `.ai/scripts` to the package instead of the repo, and the two new `/api/health`-based suites needing a real timeout, since a cold health read shells out to probe agent CLIs).
