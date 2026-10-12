# Create a new project (fresh git repo, optional private GitHub repo)

Status: implemented · Date: 2026-09-29 · Extends: spec 2026-07-20-multi-project-workspace

## Problem

"Add project" can open an existing folder or clone an existing GitHub repo, but cannot
start a project from nothing. Starting one means leaving the cockpit to `git init`,
`gh repo create`, and then registering the folder by hand.

## Goals

- **Add project → New project…** creates `<projectsDir>/<name>` as a git repository and
  registers it, navigating to it like the clone flow does.
- Optionally (default on when `gh` is signed in) also create a GitHub repository under
  the user's account or one of their organisations.
- The GitHub repository is **always private**. There is no visibility choice in the
  dialog and no visibility field in the request; the user can change it on GitHub.
- "Start with" is an explicit choice: an **empty repository** (one empty initial commit,
  no files) or, with GitHub on, **a GitHub template** (`owner/repo`, a URL, or one of the
  suggested templates in `packages/web/src/lib/github-templates.ts` — each verified as a
  non-archived template repository, since `gh repo create --template` accepts nothing else).

## Non-goals

- Public/internal repositories, other forges, deleting a GitHub repo after a failure,
  scaffolding files (README, .gitignore, licence).

## Design

`POST /api/v1/projects/create` `{ name, github?: { owner, template? }, checkoutId? }` —
workspace-level, same guards and target rule as `/api/v1/projects/checkout`
(`packages/cezar/src/server/create-project.ts` reuses `checkout.ts`'s name validation, its
ownership-token `mkdir`, and its guarded `cleanupCheckout`). Progress is emitted as
`checkout-progress` events keyed by `checkoutId`; success registers through the same
`registerFolder` (`source: checkout` when GitHub-backed, `local` otherwise).

1. **Local only:** `git init -b main` and `git commit --allow-empty -m "Initial commit"`,
   so task worktrees have a base commit. Without a git identity the commit is skipped
   (reported as a progress line) and the repo stays usable.
2. **GitHub, empty:** as (1), then `gh repo create <owner>/<name> --private`,
   `git remote add origin https://github.com/<owner>/<name>.git` and `git push -u origin main`
   (no push when there is no commit).
3. **GitHub, template:** `gh repo create <owner>/<name> --private --template <tmpl>`, poll
   `gh api repos/<slug>/commits` until the generated commit appears (≈30 s max), then
   `gh repo clone https://github.com/<owner>/<name>.git` into the target.

Both GitHub paths use the HTTPS remote and persist the `gh` credential helper exactly as
"Clone from GitHub" does (#968, `GH_CREDENTIAL_HELPER_CONFIG` in `checkout.ts`): `gh` injects
credentials only into its own commands, so without the helper a task worktree's later raw
`git push` would fail to authenticate, and a bare `owner/repo` lets `gh` pick an SSH key an
organisation's SAML policy may reject.

A failure cleans up the local folder only. If the GitHub repository was already created,
the error says so; cezar never deletes remote repositories.

**Name.** The name must be a valid GitHub repository name (`GITHUB_REPO_NAME_PATTERN` in
`packages/contract`: letters, digits, `.`, `-`, `_`, at most 100 characters, not `.`/`..`) —
even for a local-only project, because it is the folder AND (now or later) the repository,
and GitHub would silently rewrite anything else. The dialog turns a typed space into `-`,
as GitHub's own form suggests, and blocks Create with an inline hint for anything else.

`GET /api/v1/projects/github-owners` → `{ available: true, owners: [{ login, personal,
avatarUrl?, description? }] }` from `gh api user` and `gh api user/orgs` — the personal
account first, then organisations sorted by login — or `{ available: false, reason }`
(no `gh`, unauthenticated). Only `https://` avatars are passed on. The dialog renders the
owners as selectable cards (avatar, login, "Personal account" or the org description),
the personal account selected by default; it links nowhere else.
A failed org listing degrades to the personal account. `CEZ_DRY_RUN=1` fakes every `gh`
call and runs real `git`.

## Telemetry (opt-in, docs/telemetry.md)

- `add_project_opened` — label `new` / `clone` / `folder`: which Add project dialog was opened
  (cockpit relay, closed set in `packages/contract/src/telemetry.ts`).
- `project_added` — label `new_local` / `new_github` / `new_template` for a created project,
  beside the folder and clone flows' `local` / `github`.
- `project_create_failed` — label is the failed step (`CreateProjectFailureStage` plus
  `register`), never the error text, which can carry paths and repository names.

## Compatibility

Additive: two new workspace-level routes (listed in BACKWARD_COMPATIBILITY.md §2), no
schema, config or env changes.
