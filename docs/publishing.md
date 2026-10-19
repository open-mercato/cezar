# Publishing — stable releases and npm previews

How cezar reaches npm. Two paths, deliberately separate
(spec: `.ai/specs/2026-07-18-npm-preview-publish.md`, issue #482):

- **Stable releases** are **owner-driven**: one click on the
  [`Release`](../.github/workflows/release.yml) workflow, run from the
  `release/vX.Y.x` line to ship (see [Release lines](#release-lines)). CI never
  moves `latest` — a push publishes nothing.
- **Previews** are **CI-driven**: the `publish-snapshot` job in
  [`ci.yml`](../.github/workflows/ci.yml) publishes a snapshot of every package
  after a fully green `verify` run — on `develop` pushes and same-repo PRs only.
- **Nightlies** are **clock-driven**: [`nightly.yml`](../.github/workflows/nightly.yml)
  cuts `main`'s tip every night under the `nightly` dist-tag, so `npx cezar-run@nightly`
  is always the trunk. Also runnable on demand from the Actions tab.

Four packages are in the release, always at the same version; three of them ship:

| Package | Ships? | What it is |
|---|---|---|
| `@open-mercato/cezar-api-client` | **no — `private`** | the typed client and shared contract types (`packages/api-client`) |
| `@open-mercato/cezar` | yes | the service + CLI, ships the built cockpit (`packages/cezar`) |
| `cezar-cli` | yes | the original unscoped bin alias, so `npx cezar-cli` works (`alias-cezar`) |
| `cezar-run` | yes | a second unscoped bin alias, so `npx cezar-run` works (`alias-cezar-run`) — npx resolves a package name, never a bin name, so each npx spelling is its own package |

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

## Release lines

`main` carries the **next** minor; every released minor lives on its own
`release/vX.Y.x` branch, which takes fixes only. A telemetry fix can ship as a
patch in minutes without whatever features `main` has gathered since.

```
main            0.15.2 ──cut──▶ 0.16.0 (features) ───────cut──▶ 0.17.0 …
                   │                                   │
release/v0.15.x    └─ 0.15.3 ─ 0.15.4 (fixes)          │
release/v0.16.x                                        └─ 0.16.0 ─ 0.16.1 …
```

Three workflows, no hand-edited versions:

| Workflow | Run from | Does |
|---|---|---|
| [`Release cut`](../.github/workflows/release-cut.yml) | `main` | With main at `X.Y.Z`: creates `release/vX.Y.x` at main's tip, adds the `backport release/vX.Y.x` label, and opens the PR moving main (manifests, cockpit, lockfile) to `X.(Y+1).0`. |
| [`Release`](../.github/workflows/release.yml) | a `release/vX.Y.x` branch (the *Use workflow from* picker) | Bumps first: once `vX.Y.Z` is tagged the next patch is chosen (a fresh line's `X.Y.0` ships as committed). Stamps every manifest, the lockfile and `CHANGELOG.md`, commits that to the branch, then verifies, builds and publishes **that commit**, tags it, cuts the GitHub Release and opens a PR carrying the changelog entry to `main`. |
| [`Backport`](../.github/workflows/backport.yml) | — (labels) | A merged PR labelled `backport release/vX.Y.x` is cherry-picked into a PR on that line; `backport main` forward-ports a hotfix that landed on a line first. Conflicts open a draft with instructions. A PR from a fork is skipped (no secrets on `pull_request`): port it by hand. |

**Dist-tags.** Only the newest line moves `latest`, which the cockpit's stable
update channel follows. A patch to an older line publishes under
`latest-X.Y` (`npx cezar-run@latest-0.15`) and its GitHub Release is not marked
latest — so a 0.15.4 after 0.16.0 never offers anyone a downgrade.

**Changelog.** A hand-written entry wins: an existing `# X.Y.Z` heading is kept,
and a leading `# Unreleased` on the line is renamed to the version (*Release
cut* moves `main`'s `# Unreleased` to the new line, so it is never shipped twice). Otherwise the
entry is GitHub's generated notes since the previous tag on that line, grouped by
PR label per [`.github/release.yml`](../.github/release.yml) — `feature` → ✨ Features,
`security` → 🔒 Security, `bug` → 🐛 Fixes, `refactor`/`dependencies`/`documentation`
→ 🧹 Maintenance — with contributors credited. Backport PRs keep the original title and
labels; the release workflows' own PRs carry `skip-changelog` and are left out. The
same entry, plus the install command, is the GitHub Release body.

**Re-runs are safe.** A version already tagged is skipped past, a package
already on npm is not published again, and an existing GitHub Release, branch
or PR is reused — so a release that failed half-way is finished by running it
again from the same branch.

Only `release/vX.Y.x` branches can run `Release`; the pre-release-lines
`release/0.9.x` branch is retired.

The `Release` job is gated behind the `production` environment (required
reviewers). Without `NPM_TOKEN` it degrades to a loud dry run, and its
`dry_run` input computes and builds a release without committing, publishing
or tagging anything.

**Running a workflow:** GitHub → **Actions** → pick the workflow in the left
sidebar → **Run workflow** → choose the branch in **Use workflow from** → tick
`dry_run` to rehearse → **Run workflow**. A Release run then waits for the
`production` environment approval (the run page shows *Review deployments*).

### Hotfix from telemetry (a patch on the current line)

1. Open the fix PR against **`main`**, labelled `backport release/v0.16.x`
   (the newest line — `git branch -r --list 'origin/release/v*'`). Merge it.
2. The **Backport** workflow opens `[Backport release/v0.16.x] …` against the
   line. Wait for CI, approve, merge. Repeat 1–2 for every fix that should ship.
3. Actions → **Release** → *Use workflow from* **`release/v0.16.x`** → run
   (optionally `dry_run` first) → approve the deployment. `0.16.1` is on npm.
4. Merge the `docs(changelog): add the 0.16.1 entry` PR it opens on `main`.

### Next minor (cut a new line)

1. Actions → **Release cut** → *Use workflow from* **`main`** → run with
   `dry_run`, check the summary (`release/v0.17.x`, main → `0.18.0`), then run
   it again without.
2. Merge the `chore(release): open 0.18.0 on main` PR it opens. Features keep
   landing on `main` from here; only backports reach `release/v0.17.x`.
3. Stabilize: fixes go to `main` labelled `backport release/v0.17.x`, as above.
4. Actions → **Release** → *Use workflow from* **`release/v0.17.x`** → run →
   approve. `0.17.0` is on npm and moves `latest`.
5. Merge the changelog PR on `main`.

The previous line keeps working: a fix labelled `backport release/v0.16.x` and a
Release run from that branch publish `0.16.x` under `latest-0.16`.

## Nightlies

Every night at **03:17 UTC**, [`nightly.yml`](../.github/workflows/nightly.yml)
verifies `main` (typecheck, unit suites, build, packaged-CLI e2e — the same gate
a release runs) and publishes it under the `nightly` dist-tag:

```bash
npx cezar-run@nightly              # whatever is on main as of last night
npx cezar-run@0.1.5-nightly.20260813.126   # that exact night, forever
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
| same-repo PR, CI green | `0.1.5-pr482.123` | `pr-482` | `npx cezar-run@0.1.5-pr482.123` |
| push to `develop` | `0.1.5-develop.124` | `develop` | `npx cezar-run@develop` |
| nightly cut of `main` | `0.1.5-nightly.20260813.126` | `nightly` | `npx cezar-run@nightly` |

A push to `main` publishes **nothing**: the trunk reaches npm through the nightly
above, or through an owner-driven stable release — never straight off a merge.

Version scheme: `<base>-<channel>.<run_number>`, with `.<run_attempt>` appended
on re-runs so no publish ever collides. Prerelease versions under explicit
dist-tags are invisible to a plain `npx cezar-run`, which keeps resolving
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
| `packages/cezar/src/release/stable.ts`, `bump.ts` | pure release-line decisions: next version, dist-tag, lockfile/changelog stamping (unit-tested) |
| `scripts/release-line.mjs` | `cut` / `prepare` / `announce` for the release-line workflows; GitHub writes through `scripts/lib/github.mjs` (`--dry-run` e2e-tested) |
| `scripts/release.mjs` | publishes the release set in dependency order under `--dist-tag` (`latest` by default) |
| `scripts/release-snapshot.mjs` | orchestrator: stamps manifests, `npm publish --tag <channel> --provenance`, emits result JSON (`--dry-run` supported; e2e-tested) |
| `ci.yml` → `publish-snapshot` | gate (`needs: [verify, vitest]`), same-repo guard, provenance permissions, sticky PR comment, step summary |
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

On **npmjs.com** (as an owner of the npm org and of the `cezar-cli` and `cezar-run` packages):

1. Verify the org exists and your user is an **Owner**.
2. Give the org control of the unscoped aliases (unscoped packages attach to
   orgs via teams) — run as their current owner:
   `npm access grant read-write <org>:developers cezar-cli` (and the same for `cezar-run`).
   An unscoped alias is outside the org scope, so the CI token below cannot create
   it: the FIRST publish of a new alias is manual
   (`cd alias-cezar-run && npm publish --access public`), before the release set
   that includes it reaches CI.
3. Create a **granular access token**: *Read and write*; packages and scopes =
   the org **scope** (`@open-mercato/*`) rather than a hand-picked package
   list, **plus** the `cezar-cli` and `cezar-run` packages; set an expiry per your policy (CI
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
6. **`RELEASE_TOKEN`**: a GitHub App or fine-grained token with
   *Contents* and *Pull requests* read/write on this repo. Required once the
   step 7 ruleset exists — `GITHUB_TOKEN` cannot bypass it, so *Release* could
   not commit the bump to the line. GitHub runs no CI on
   a PR opened with the workflow's own `GITHUB_TOKEN`, so without it the
   main-bump, changelog and backport PRs wait for a manual re-run of their checks.
   Those PRs are never auto-merged: approve and merge them like any other.
7. A ruleset for `release/v*` (no deletion, no force-push; PRs required) with the
   `RELEASE_TOKEN` identity on its bypass list — the Release workflow commits
   the version bump straight to the line through the API (GitHub-signed).
8. Nothing else — the workflows declare their own `permissions:` blocks, so
   repo-level Actions defaults can stay read-only.

After the first stable publish under a new package name (post-rename only):

9. Publish a final forwarding patch of the old scoped package and deprecate
   it: `npm deprecate <old-name> "moved to <new-name> — npx cezar-run still works"`.

## Verifying a preview

- The PR's sticky comment (or the job's step summary for branch pushes) has
  the exact command — e.g. `npx cezar-run@0.1.5-pr482.123`.
- `npm view cezar-run dist-tags` shows every active channel.
- Server flows accept pinned previews too:
  `npx cezar-run@<version> server-deploy --platform <id>`
  (see [Remote access](server-install/README.md)).
