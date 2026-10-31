# Publishing — stable releases and npm previews

How cezar reaches npm. Two paths, deliberately separate
(spec: `.ai/specs/2026-07-18-npm-preview-publish.md`, issue #482):

- **Stable releases** are **owner-driven**: one click on the
  [`Release`](../.github/workflows/release.yml) workflow, run from the
  `release/vX.Y.x` line to ship (see [Release lines](#release-lines)). CI never
  moves `latest` — a push publishes nothing.
- **Previews** are **CI-driven**: the `publish-snapshot` job in
  [`ci.yml`](../.github/workflows/ci.yml) publishes a snapshot of every package
  after fully green `verify`, `vitest` and `webhooks-cross-platform` runs — on `develop`
  pushes and same-repo PRs only.
- **Nightlies** are **clock-driven**: [`nightly.yml`](../.github/workflows/nightly.yml)
  cuts `main`'s tip every night under the `nightly` dist-tag, so `npx cezar-run@nightly`
  is always the trunk. Also runnable on demand from the Actions tab.

The Linux jobs run the full unit suites, typecheck, build and packaged-CLI tests.
`webhooks-cross-platform` runs the webhook suite on Linux, macOS and Windows;
its macOS and Windows legs also build and run `npm run test:package`, including
installation of the tarball and a dry-run CLI workflow. Linux package checks run
in `verify` instead of being duplicated in the matrix. A failing matrix leg blocks
preview publication; blocking merges additionally requires branch protection.
Developers keep using the existing local commands on their own operating system.

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

Four workflows, no hand-edited versions. Every write they make uses the
release GitHub App's token (step 6 below), never `GITHUB_TOKEN`: PRs and tags
made with that token start no workflows.

| Workflow | Run from | Does |
|---|---|---|
| [`Release cut`](../.github/workflows/release-cut.yml) | `main` | With main at `X.Y.Z`: creates `release/vX.Y.x` at main's tip, adds the `backport release/vX.Y.x` / `backport main` labels, hands main's `# Unreleased` to the line, and opens the PR moving main (manifests, cockpit, lockfile) to `X.(Y+1).0`. A re-run from the same main commit finishes a half-done cut; once main has moved past it, it refuses. |
| [`Release`](../.github/workflows/release.yml) | a `release/vX.Y.x` branch (the *Use workflow from* picker) | Picks the version (below), stamps every manifest, the lockfile and `CHANGELOG.md`, commits that to the line, verifies and builds **that commit**, then tags it `vX.Y.Z`. It publishes nothing itself. |
| [`Release publish`](../.github/workflows/release-publish.yml) | the `vX.Y.Z` tag (started by the tag) | Runs **at the tagged commit**, so npm provenance attests the code that ships. Checks the tag names the manifests and sits on its line, skips a version already released, resolves the dist-tag, builds, publishes, opens the changelog PR to `main`, and **last** creates the GitHub Release. One publish at a time across all lines. |
| [`Backport`](../.github/workflows/backport.yml) | — (labels) | A merged PR labelled `backport release/vX.Y.x` is cherry-picked into a PR on that line (carrying its category, priority, risk and QA labels — never `qa-approved` — plus `backport`, `review`); `backport main` forward-ports a hotfix that landed on a line first. Conflicts open a draft with instructions. Runs from a scan of PRs merged in the last 30 days (on every push to `main`, every 15 minutes, and on same-repo PR events), so **fork PRs and labels added after a merge are covered too**. The label is the source of truth: a backport is owed until an open or merged backport PR exists — closing one with its branch deleted re-runs it; remove the label to stop it. |

**How Release picks the version.** A release is *done* when its GitHub Release
exists; the tag pins its commit.

| The line's state | Release does |
|---|---|
| newest tag `vX.Y.Z` has a GitHub Release | bumps the patch, commits, tags the bump |
| a fresh line (`X.Y.0` committed, untagged, not on npm) | ships `X.Y.0` as committed |
| a bump whose run died before tagging (untagged, not on npm) | ships it as committed |
| newest tag has **no** GitHub Release | stops: re-run that tag's **Release publish** run. Fixes merged since go to the next patch — one npm version never mixes two commits |
| untagged version **already on npm** (its tag was deleted) | refuses: restore the tag at the commit it was published from. **Never delete a release tag.** |

**Dist-tags.** Only the newest line moves `latest`, which the cockpit's stable
update channel follows. *Release publish* compares against the highest
`latest` across every published package (failing closed when npm can't be
read), so a half-published run can't let a patch move one package's `latest`
backwards. A patch to an older line publishes under `latest-X.Y`
(`npx cezar-run@latest-0.15`) and its GitHub Release is not marked latest. A
package already on npm is skipped and its dist-tag re-pointed
(`--reconcile-tag`).

**Changelog.** A hand-written entry wins: an existing `# X.Y.Z` heading is kept,
and a leading `# Unreleased` on the line is renamed to the version (*Release
cut* moves `main`'s `# Unreleased` to the new line, so it is never shipped twice). Otherwise the
entry is GitHub's generated notes since the previous tag on that line, grouped by
PR label per [`.github/release.yml`](../.github/release.yml) — `feature` → ✨ Features,
`security` → 🔒 Security, `bug` → 🐛 Fixes, `refactor`/`dependencies`/`documentation`
→ 🧹 Maintenance — with contributors credited. Backport PRs keep the original title and
labels; the release workflows' own PRs carry `skip-changelog` (plus a category and
`review`) and are left out. The same entry, plus the install command, is the
GitHub Release body.

**Finishing a failed release.** If *Release* fails before tagging, run it again
from the line. If *Release publish* fails (npm, the changelog PR, the GitHub
Release), use **Re-run jobs** on that run: it rebuilds the same tagged commit,
skips what already reached npm, and finishes.

*Release publish* runs one at a time across every line (two lines publishing at
once could both read `latest` before either moves it). GitHub keeps only **one**
waiting run per group: if a third tag arrives while one publishes and one waits,
the waiting run is cancelled. The tag survives, and the next *Release* on that
line reports it as tagged but not released — re-run its *Release publish* run.

Only `release/vX.Y.x` branches can run `Release`; the pre-release-lines
`release/0.9.x` branch is retired.

*Release publish* is gated behind the `production` environment (required
reviewers, deployment tag rule `v*`). Without `NPM_TOKEN` it degrades to a loud
dry run. *Release*'s `dry_run` input plans, stamps, verifies, builds and
previews the release body without committing or tagging anything.

**Running a workflow:** GitHub → **Actions** → pick the workflow in the left
sidebar → **Run workflow** → choose the branch in **Use workflow from** → tick
`dry_run` to rehearse → **Run workflow**.

### Hotfix from telemetry (a patch on the current line)

1. Open the fix PR against **`main`**, labelled `backport release/v0.16.x`
   (the newest line — `git branch -r --list 'origin/release/v*'`). Merge it.
2. The **Backport** workflow opens a PR with the same title against the
   line. Wait for CI, approve, merge. Repeat 1–2 for every fix that should ship.
3. Actions → **Release** → *Use workflow from* **`release/v0.16.x`** → run
   (optionally `dry_run` first). It tags `v0.16.1`, which starts **Release
   publish** → approve its deployment. `0.16.1` is on npm.
4. Merge the `docs(changelog): add the 0.16.1 entry` PR it opens on `main`.

### Next minor (cut a new line)

1. Actions → **Release cut** → *Use workflow from* **`main`** → run with
   `dry_run`, check the summary (`release/v0.17.x`, main → `0.18.0`), then run
   it again without.
2. Merge the `chore(release): open 0.18.0 on main` PR it opens. Features keep
   landing on `main` from here; only backports reach `release/v0.17.x`.
3. Stabilize: fixes go to `main` labelled `backport release/v0.17.x`, as above.
4. Actions → **Release** → *Use workflow from* **`release/v0.17.x`** → run;
   approve the **Release publish** run its tag starts. `0.17.0` is on npm and
   moves `latest`.
5. Merge the changelog PR on `main`.

The previous line keeps working: a fix labelled `backport release/v0.16.x` and a
Release run from that branch publish `0.16.x` under `latest-0.16`.

### Resolving a conflicted backport

A cherry-pick conflicts when the change depends on a commit that `main` has and the
line does not. The Backport workflow then opens a **draft** with the conflict markers
committed and posts the commands on the original PR. Never merge the draft as is.

1. **Find the missing commit.** For each conflicted file:
   ```bash
   git fetch origin main release/v0.16.x
   git log --oneline "$(git merge-base origin/main origin/release/v0.16.x)..<merge commit>^" -- <file>
   ```
   lists what `main` changed there that the line never got.
2. **Decide what that commit is:**
   - **a fix the line should have too:** backport it first (label its PR
     `backport release/v0.16.x`, merge that backport), then close the draft **and delete
     its branch** (`gh pr close <n> --delete-branch`): the next scan (within 15 minutes)
     opens a fresh backport on top. No hand edits. A closed draft whose branch is kept is
     left alone: the action would reopen that stale branch instead of cherry-picking again.
   - **a feature, or unrelated:** resolve on the draft's branch. Keep the line's code
     and apply only what the original PR intended. Taking `main`'s version of a whole
     file is right only when the original PR replaced that file and the leftover
     difference is harmless (#1642: a one-line test-fixture tweak from #1427).
   - **the code moved or was refactored on `main`:** port the fix by hand **on the
     draft's branch** (reset it to the line, write the fix where the code lives there,
     force-push) — keeping that PR is what tells the scan the backport exists.

   If the bug turns out not to exist on the line, remove the label from the original PR
   and close the draft with `--delete-branch`.
3. **Validate on the branch** (the release tests at least; the full gate for code),
   push, run `gh pr ready <n>`, and comment what conflicted and how it was resolved.
4. **Review** it like any backport: CI green, and its diff changes only what the
   original PR's diff changed (`gh pr diff <original>` vs `gh pr diff <backport>`).

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
| `scripts/release-line.mts` | `cut` / `prepare` / `tag` / `verify` / `announce` for the release-line workflows; GitHub writes through `scripts/lib/github.mts` (e2e-tested against a fake GitHub API) |
| `scripts/release.mts` | publishes the release set in dependency order under `--dist-tag` (`latest` by default) |
| `scripts/tsconfig.release.json` | strict typecheck of the `.mts` release tooling (`npm run typecheck:release`); Node runs it directly with type stripping (Node ≥ 22.18), importing `packages/cezar/src/release/*.ts` — no build step |
| `scripts/release-snapshot.mjs` | orchestrator: stamps manifests, `npm publish --tag <channel> --provenance`, emits result JSON (`--dry-run` supported; e2e-tested) |
| `ci.yml` → `publish-snapshot` | gate (`needs: [verify, vitest, webhooks-cross-platform]`), same-repo guard, provenance permissions, sticky PR comment, step summary |
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
6. **The release GitHub App** — every release workflow mints a one-hour token
   from it (`actions/create-github-app-token`); there is no fallback.
   - Create it under the **org**: `https://github.com/organizations/<org>/settings/apps/new`
     (an App made under a personal account can only be installed there).
     Homepage = the repository URL, no callback URL, webhook **off**,
     "Only on this account".
   - Repository permissions: **Contents, Pull requests, Issues, Workflows —
     read & write**. Install it on this repository only.
   - Store its **Client ID** (`Iv23…`, not the numeric App ID) as the
     repository *variable* `RELEASE_APP_CLIENT_ID`, and a generated private key
     (the whole `.pem`) as the *secret* `RELEASE_APP_PRIVATE_KEY`.
   - Why an App: nothing expires, PRs it opens are authored by the App (so any
     maintainer can approve them), its tags and PRs start workflows, and its
     API commits are GitHub-signed.
7. Branch ruleset **`release lines`** on `release/v*`: restrict creations and
   deletions, block force pushes, require a PR (1 approval) and the CI checks
   ("do not require status checks on creation" ✅), signed commits optional —
   with the **App** on its bypass list (*Always*): *Release* commits the bump
   straight to the line.
8. Tag ruleset on `v*`: restrict creations, updates and deletions, App on its
   bypass list. Anyone who can push a `v*` tag would otherwise start a publish.
9. Environment **`production`**: required reviewers, and a deployment tag rule
   `v*` so only release tags can deploy to it.
10. Nothing else — the workflows declare their own `permissions:` blocks, so
   repo-level Actions defaults can stay read-only. `RELEASE_TOKEN` is no longer
   read and can be deleted.

After the first stable publish under a new package name (post-rename only):

11. Publish a final forwarding patch of the old scoped package and deprecate
   it: `npm deprecate <old-name> "moved to <new-name> — npx cezar-run still works"`.

## Verifying a preview

- The PR's sticky comment (or the job's step summary for branch pushes) has
  the exact command — e.g. `npx cezar-run@0.1.5-pr482.123`.
- `npm view cezar-run dist-tags` shows every active channel.
- Server flows accept pinned previews too:
  `npx cezar-run@<version> server-deploy --platform <id>`
  (see [Remote access](server-install/README.md)).
