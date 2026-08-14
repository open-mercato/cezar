# Adopt TypeScript 7 (the native compiler)

We moved from TypeScript 5.6 to 7.0, the Go-native compiler rewrite. TypeScript 7 ships no
JavaScript compiler API — `require("typescript")` returns only `{ version, versionMajorMinor }`,
and `tsserver` is gone — which currently blocks typescript-eslint, ts-jest, and Volar-based
tooling. Cezar uses `tsc` purely as a compiler and typechecker: it has no linter that consumes
the compiler API (oxlint, our chosen linter, does not — see Consequences), no other programmatic
API consumer, and vite/vitest/tsx strip types with esbuild and never load the `typescript`
package. None of the blockers apply to us, so we took 7.0 directly rather than parking on the
6.0 bridge release.

## Consequences

Two config changes are not obvious from reading the tsconfigs:

- **`"types": ["node"]` is now mandatory in `tsconfig.json`.** TypeScript 7 defaults `types` to
  `[]` instead of "every package under `@types`". Without it the build fails with `TS2591:
  Cannot find name 'process'` even though `@types/node` is installed.
- **`baseUrl` was removed from `packages/web/tsconfig.json`.** TypeScript 7 removed the option
  (`TS5102`). `paths` now resolves relative to the tsconfig's own directory, so the existing
  `"@/*": ["./src/*"]` mapping kept working unchanged. The bundler-side alias is unaffected —
  it is declared explicitly in `packages/web/vite.config.ts`, and the tsconfig `paths` entry only
  mirrors it for typechecking.

**This decision commits us to oxlint over typescript-eslint for linting.** typescript-eslint
consumes TypeScript as a JS library, so TS 7 breaks it outright — its peer range is
`>=4.8.4 <6.1.0` and installing it against 7.0.2 fails with `ERESOLVE`. It stays blocked until
TypeScript 7.1 ships the new API. oxlint is unaffected for the opposite reason: it has no
dependency on the `typescript` package at all, and its type-aware mode vendors typescript-go
directly into its own Go binary (`oxlint-tsgolint`) rather than loading yours.

That makes TS 7 a **prerequisite** for our linter rather than a tax on it. oxlint's type-aware
docs state that TypeScript 7.0+ is required and that `baseUrl` is unsupported — the exact
option this migration removed, so we satisfy both by construction. Two things to plan around
when we adopt it: oxlint's type-aware rules are explicitly carved out of its semver guarantee,
so pin and upgrade `oxlint` and `oxlint-tsgolint` together; and `oxlint --type-aware
--type-check` can fold in typescript-go's own type diagnostics, which may later let it replace
the separate `tsc --noEmit` typecheck step.

If we ever do need a compiler-API consumer (ts-jest, a codemod, Volar-based tooling), the
sanctioned escape hatch is a side-by-side install — alias `typescript` to
`@typescript/typescript6` for that tool while `tsc` stays on 7.x — rather than reverting.

`tsc` in 7.0 is fully capable for our use: JS + `.d.ts` + source-map emit under `NodeNext`,
project references, and `--build` all work. The compiler is a platform-specific Go binary
delivered through 20 optional dependencies; all of them are pinned in `package-lock.json`, so
`npm ci` on CI's `ubuntu-latest` resolves `linux-x64` correctly.

## Considered Options

- **Stay on 5.x.** Rejected: no upside beyond inertia, and the migration cost only grows.
- **Adopt 6.0 as a bridge first.** Microsoft recommends 5.x → 6.0 → 7.0 so deprecations surface
  as warnings before they become errors. Rejected as an unnecessary intermediate step here: the
  project is small enough that we could run the real 7.0 compiler and fix the two errors it
  actually reported. 6.0 would be worth it for a codebase too large to fix in one pass.
