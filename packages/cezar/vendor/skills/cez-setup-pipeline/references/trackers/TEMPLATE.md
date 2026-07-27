# Tracker provider: {name}

Copy this file to `.ai/trackers/{name}.md`, set `"tracker": "{name}"` in `.ai/agentic.config.json`, and fill in every operation below. This is the whole integration surface: no skill changes are needed to support a new tracker — skills name operations, this file says how to execute them. Use `github.md` as the reference implementation for structure and level of detail.

## How to write a provider

- **One file, all operations.** Every operation a skill can name must have a heading here with either a concrete command/tool call (CLI, MCP tool, API call) or an explicit delegation (see below). An operation you leave empty will strand every skill that uses it.
- **Split-provider setups are normal.** Many teams track issues in one tool (Linear, Jira) while PRs and CI stay on the code host (GitHub). In that case implement the *Issues* section against the issue tracker and delegate the *Pull requests*, *Labels*, and *Identity* sections, e.g.: "Pull request operations: as in `github.md` (gh CLI)." Map identifiers both ways in the Conventions section (for example, a Linear ticket `ENG-123` referenced from a GitHub PR body, and the PR URL attached back to the ticket).
- **Preserve the semantics, not the syntax.** A skill saying "close the issue with a comment linking the PR" must end with the ticket in the tracker's done/closed state and a visible cross-link — whatever commands that takes.
- **Concepts that must map somewhere:** issue/PR identifiers and how they are written in text; how a PR declares which issue it resolves (and whether that auto-closes it); draft PRs (or the nearest equivalent, e.g. a "WIP" state); labels (or the tracker's tags/states — if the tracker models workflow as states instead of labels, say how each pipeline label maps to a state); assignees; comments; CI check status; review verdicts (approve / request changes); merge.
- **Claim/lock protocol.** Skills coordinate via three claim signals: assignee = automation user, `in-progress` marker, and a `🤖`-prefixed claim comment with a timestamp. Define how each is expressed in this tracker; all three should be readable back by **get-issue**/**get-pr** so concurrent skills detect the lock.
- **Guards.** Reproduce the label-guard behavior: a label/tag mutation checks existence first and degrades to a logged skip when missing; `labels.enabled: false` in the config skips label operations entirely.
- **Cross-repo targets.** Every operation should accept an optional `{repo}` (owner/name, or this tracker's project identifier) and default to the current checkout's repository when omitted — some skills address repositories other than the current one and always pass the target explicitly. `github.md` documents this contract as its blanket `--repo` rule. A provider that cannot support cross-repo targets must say so explicitly here, so dependent skills fail loud instead of silently querying the wrong repository.

## Prerequisites

{CLI/MCP server/API token needed, and how to verify it — the **auth-check** operation}

## Conventions

{identifiers, cross-linking syntax, draft equivalent, comment formatting, claim signals}

## Label guards

{the guard behavior above, in this tracker's terms}

## Operations

### Identity and repository

- **auth-check** — verify credentials; fail fast when missing.
- **current-user** — the automation user's login/handle.
- **repo-info** — the repository/project handle.
- **default-branch** — the code host's default branch (used when `baseBranch` is `"auto"`).

### Issues

- **get-issue** — id, field list → issue data (title, body, state, author, url, labels/state, assignees, comments).
- **search-issues** — text query, state → matching issues.
- **create-issue** — title, body, assignee, labels → created issue URL.
- **close-issue** — id, reason, closing comment.
- **comment-issue** — id, body.
- **update-issue** — id, new title and/or body → edits the issue's own fields (not labels/assignees).
- **assign-issue / unassign-issue** — id, user.
- **label-issue / unlabel-issue** — id, label (through the guard).
- **get-issue-comment** — comment id → body, author, URL.
- **list-issue-comments** — id → conversation comments.

### Pull requests

- **get-pr** — number, field list → PR data (see `github.md` for the full field set skills request).
- **list-prs** — state/search filters, limit → PRs.
- **search-prs** — free-text query (e.g. an issue reference), state → matching PRs.
- **create-pr** — base branch, draft flag, title, body → PR URL + number.
- **comment-pr** — number, body (multi-line bodies must preserve formatting).
- **attach-image-evidence** — number, a comment body, a slug (e.g. `pr-<n>`), and a list of local image file paths → post a single comment that embeds the images so they render **inline** in the tracker, and return the comment URL. The mechanism is the tracker's business (an upload/attachment endpoint, a media API, or a pushed evidence branch referenced by raw URLs) — the skills only name the operation and pass image paths. Contract: never mutate the change's own branch to store evidence; when the tracker cannot render uploaded images (e.g. a private repo whose raw URLs need auth), still post the comment with links to the images and say so rather than failing the caller. This is how QA skills post screenshots without any host-specific logic living in the skill.
- **assign-pr / unassign-pr** — number, user.
- **label-pr / unlabel-pr** — number, label (through the guard; pipeline labels are mutually exclusive).
- **get-pr-diff** — number → full diff or changed-file list.
- **get-pr-files** — number → changed files with per-file status (added/modified/removed).
- **checkout-pr** — number → PR head available locally (fork PRs included).
- **review-pr** — number, verdict (approve / request changes), body.
- **merge-pr** — number; squash by default.
- **mark-pr-ready** — promote a draft PR.
- **get-pr-checks** — number → CI check runs (name, state, link).
- **get-required-checks** — base branch → required status checks; when unreadable, treat all reported checks as required.
- **get-pr-comment / get-review-comment** — comment id → body, author, URL (conversation vs inline review comment).

### CI runs

- **list-runs** — branch (or head SHA) → recent CI runs with id, workflow name, status, conclusion.
- **get-run** — run id → status, conclusion, per-job breakdown.
- **get-run-failed-logs** — run id → log output of the failed steps (the diagnosis input for CI failures).
- **rerun-failed** — run id → re-execute only the failed jobs (used to disambiguate flakes before code changes).
- **watch-run** — run id → block until the run completes, signaling success/failure; may degrade to polling **get-run**.

### Labels

- **list-labels** — all label/tag names.
- **create-label** — name, color, description; never delete or rename existing ones.
- **ensure-label-taxonomy** — create every missing label from the config's taxonomy.
