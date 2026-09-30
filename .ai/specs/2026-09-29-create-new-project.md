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
- Optionally generate the repository from a GitHub template (`owner/repo` or URL).

## Non-goals

- Public/internal repositories, other forges, deleting a GitHub repo after a failure,
  scaffolding files (README, .gitignore, licence).

## Design

`POST /api/projects/create` `{ name, github?: { owner, template? }, checkoutId? }` —
workspace-level, same guards and target rule as `/api/projects/checkout`
(`src/server/create-project.ts` reuses `checkout.ts`'s name validation, its
ownership-token `mkdir`, and its guarded `cleanupCheckout`). Progress is emitted as
`checkout-progress` events keyed by `checkoutId`; success registers through the same
`registerFolder` (`source: checkout` when GitHub-backed, `local` otherwise).

1. **Local only:** `git init -b main` and `git commit --allow-empty -m "Initial commit"`,
   so task worktrees have a base commit. Without a git identity the commit is skipped
   (reported as a progress line) and the repo stays usable.
2. **GitHub, empty:** as (1), then `gh repo create <owner>/<name> --private --source <dir>
   --remote origin --push` (no `--push` when there is no commit).
3. **GitHub, template:** `gh repo create <owner>/<name> --private --template <tmpl>`, poll
   `gh api repos/<slug>/commits` until the generated commit appears (≈30 s max), then
   `gh repo clone` into the target.

A failure cleans up the local folder only. If the GitHub repository was already created,
the error says so; cezar never deletes remote repositories.

`GET /api/projects/github-owners` → `{ available: true, login, orgs }` from `gh api user`
and `gh api user/orgs`, or `{ available: false, reason }` (no `gh`, unauthenticated).
A failed org listing degrades to the personal account. `CEZ_DRY_RUN=1` fakes every `gh`
call and runs real `git`.

## Compatibility

Additive: two new workspace-level routes (listed in BACKWARD_COMPATIBILITY.md §2), no
schema, config or env changes.
