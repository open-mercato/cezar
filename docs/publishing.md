# Publishing — stable releases and npm previews

How cezar reaches npm. Two paths, deliberately separate
(spec: `.ai/specs/2026-07-18-npm-preview-publish.md`, issue #482):

- **Stable releases** (`latest`) are **owner-driven and manual**: a maintainer
  runs the [`Release`](../.github/workflows/release.yml) workflow from the
  Actions tab (`workflow_dispatch`) and picks the version bump. CI never moves
  `latest` — a push to `main` publishes nothing.
- **Previews** are **CI-driven**: the `publish-snapshot` job in
  [`ci.yml`](../.github/workflows/ci.yml) publishes a snapshot of every package
  after a fully green `verify` run — on `develop` pushes and same-repo PRs only.
- **Nightlies** are **clock-driven**: [`nightly.yml`](../.github/workflows/nightly.yml)
  cuts `main`'s tip every night under the `nightly` dist-tag, so `npx cezar-cli@nightly`
  is always the trunk. Also runnable on demand from the Actions tab.

Three packages are in the release, always at the same version; two of them ship:

| Package | Ships? | What it is |
|---|---|---|
| `@open-mercato/cezar-api-client` | **no — `private`** | the typed client and shared contract types (`packages/api-client`) |
| `@open-mercato/cezar` | yes | the service + CLI, ships the built cockpit (`packages/cezar`) |
| `cezar-cli` | yes | the unscoped bin alias, so `npx cezar-cli` works (`alias-cezar`) |

That table is also the **publish order**, and it is load-bearing: each package
depends on the one above it, so publishing a dependent first would briefly
advertise a version of its dependency that is not on the registry yet. The
workspace root itself is `private` and is not in the release at all.

**Private ≠ excluded.** The api-client is stamped like everything else — its
version moves in lockstep and the service's pin against it is rewritten — it is
simply never handed to npm. It is consumed inside the workspace (the cockpit
bundles it from source, the service's tests import it) and stays unpublished
until its surface stops moving: it still carries the hand-written DTOs, which
shrink family by family as routes are converted, so publishing now would
advertise a contract that changes materially every release. Publishing it is one
line — delete `"private": true` from its manifest; the release code reads npm's
own flag and needs no change. Note the token requirement in step 3 below before
doing so.

## Stable releases

Run **Actions → Release → Run workflow** from `main` and choose a bump:

| Bump | Effect (base `0.1.5`) |
|---|---|
| `patch` | `0.1.6` |
| `minor` | `0.2.0` |
| `major` | `1.0.0` |
| `existing` | publishes the version already committed to `packages/cezar/package.json` |

The workflow verifies, builds, then `scripts/release.mjs` stamps every manifest
(intra-release dependencies keep a **caret** range — stable follows compatible
releases, unlike the exact-pinned snapshots), publishes them in dependency order
with `--tag latest --provenance`, commits the bump, tags `v<version>`, and cuts a
GitHub Release. It's gated behind the `production` environment, so a release can
require reviewer approval. Without `NPM_TOKEN` it degrades to a loud dry run.

## Nightlies

Every night at **03:17 UTC**, [`nightly.yml`](../.github/workflows/nightly.yml)
verifies `main` (typecheck, unit suites, build, packaged-CLI e2e — the same gate
a release runs) and publishes it under the `nightly` dist-tag:

```bash
npx cezar-cli@nightly              # whatever is on main as of last night
npx cezar-cli@0.1.5-nightly.20260813.126   # that exact night, forever
```

The version is named after the **day it was cut** — `<base>-nightly.<YYYYMMDD>.<run_number>`
— so the version list reads as a calendar and a user can tell how old their build
is without looking anything up. The run number trails the date so an on-demand cut
never collides with the scheduled one; both are numeric semver identifiers, so the
ordering stays chronological.

**Manual runs:** Actions → Nightly → *Run workflow* (from `main`). It publishes
immediately, even if nothing has merged since the last one — that's what the
`force` input defaults to. A *scheduled* run skips itself when `main` has not moved
in 24 hours, because that build is already the one tagged `nightly`.

The channel is requested **by name** (`CEZ_RELEASE_CHANNEL=nightly`), never inferred
from the event, so no other workflow's manual dispatch can cut a nightly by accident;
`computeSnapshot` additionally re-checks that the ref is `main`. Nightlies are
prereleases under an explicit dist-tag like every other snapshot — they can never
become the default install.

## Preview channels

| Event | Version (example) | dist-tag | Install |
|---|---|---|---|
| same-repo PR, CI green | `0.1.5-pr482.123` | `pr-482` | `npx cezar-cli@0.1.5-pr482.123` |
| push to `develop` | `0.1.5-develop.124` | `develop` | `npx cezar-cli@develop` |
| nightly cut of `main` | `0.1.5-nightly.20260813.126` | `nightly` | `npx cezar-cli@nightly` |

A push to `main` publishes **nothing**: the trunk reaches npm through the nightly
above, or through an owner-driven stable release — never straight off a merge.

Version scheme: `<base>-<channel>.<run_number>`, with `.<run_attempt>` appended
on re-runs so no publish ever collides. Prerelease versions under explicit
dist-tags are invisible to a plain `npx cezar-cli`, which keeps resolving
`latest`.

Every package publishes in lockstep, in dependency order, with each intra-release
dependency **pinned to the exact snapshot version** — so a preview always runs
exactly the code it was built from. Names are read from the checked-out manifests
at publish time, never hardcoded, and the pin is rewritten in whichever dependency
section declares it, so moving a dependency between `dependencies` and
`devDependencies` needs no change here.

On every PR snapshot the job upserts one sticky comment (marker
`<!-- cezar-npm-preview -->`) with the exact copy-pasteable commands. When a PR
closes, [`npm-preview-cleanup.yml`](../.github/workflows/npm-preview-cleanup.yml)
best-effort removes its `pr-<N>` dist-tag from every package (the versions
themselves stay — npm allows unpublish only within 72 hours, and untagged
prereleases are inert).

## Pieces

| Piece | Role |
|---|---|
| `packages/cezar/src/release/snapshot.ts` | pure decisions: channel/version/dist-tag, install lines (unit-tested) |
| `packages/cezar/src/release/manifests.ts` | the shared stamper: which manifests exist, and how each pins the next (unit-tested) |
| `scripts/release-snapshot.mjs` | orchestrator: stamps manifests, `npm publish --tag <channel> --provenance`, emits result JSON (`--dry-run` supported; e2e-tested) |
| `ci.yml` → `publish-snapshot` | gate (`needs: verify`), same-repo guard, provenance permissions, sticky PR comment, step summary |
| `nightly.yml` | the 03:17 UTC cron + manual dispatch: main-only guard, "did main move?" check, full verify, then the same orchestrator with `CEZ_RELEASE_CHANNEL=nightly` |
| `npm-preview-cleanup.yml` | dist-tag removal on PR close |

Guards: the job runs only for pushes and same-repo PRs (fork PRs get no
secrets, and `computeSnapshot` re-checks the head repo as defense in depth);
the dist-tag is always explicit so a snapshot can never become `latest`;
concurrency is non-cancellable so a publish never stops part-way through the
set (and if it ever did, the alias — published last — is the one users install,
so its tag only moves once everything below it is on the registry). **Without the `NPM_TOKEN` secret the job degrades to a loud dry
run and stays green** — the pipeline is safe to merge before the admin setup
below is done.

## One-time admin setup

On **npmjs.com** (as an owner of the npm org and of the `cezar-cli` package):

1. Verify the org exists and your user is an **Owner**.
2. Give the org control of the unscoped alias (unscoped packages attach to
   orgs via teams) — run as the current `cezar-cli` owner:
   `npm access grant read-write <org>:developers cezar-cli`.
3. Create a **granular access token**: *Read and write*; packages and scopes =
   the org **scope** (`@open-mercato/*`) rather than a hand-picked package
   list, **plus** the `cezar-cli` package; set an expiry per your policy (CI
   fails loudly with `E401`/`E404` when it lapses).
   - Selecting the scope instead of individual packages is load-bearing: a
     token limited to *selected packages* cannot **create** a new one, and npm
     reports that as a misleading `E404 Not Found - PUT <name>` rather than a
     `403`. Every package added to the release set fails its first publish
     until the token can create packages in the scope —
     `@open-mercato/cezar-api-client` was the first to hit this.
4. For every package: Settings → *Publishing access* → **"Require two-factor
   authentication or an automation or granular access token"** (CI publishes
   with the token; humans still need 2FA).

On **GitHub** (this repository):

5. Settings → Secrets and variables → Actions → new repository secret
   **`NPM_TOKEN`** with the token from step 3.
6. Nothing else — the workflows declare their own `permissions:` blocks, so
   repo-level Actions defaults can stay read-only.

After the first stable publish under a new package name (post-rename only):

7. Publish a final forwarding patch of the old scoped package and deprecate
   it: `npm deprecate <old-name> "moved to <new-name> — npx cezar-cli still works"`.

## Verifying a preview

- The PR's sticky comment (or the job's step summary for branch pushes) has
  the exact command — e.g. `npx cezar-cli@0.1.5-pr482.123`.
- `npm view cezar-cli dist-tags` shows every active channel.
- Server flows accept pinned previews too:
  `npx cezar-cli@<version> server-deploy --platform <id>`
  (see [Remote access](server-install/README.md)).
