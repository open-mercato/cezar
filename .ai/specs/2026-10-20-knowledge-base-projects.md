# Knowledge-base projects — trunk-based notes repos

Status: phase 1 implemented (2026-10-20). Server: `packages/cezar/src/workflows/landing.ts`, the
landing/read-only wiring in `workflows/run.ts`, config keys in `config.ts`. Cockpit:
`packages/web/src/routes/settings/knowledge-base-fields.tsx` (Settings → Tasks), the Ask chip and
project defaults in `routes/new-task.tsx`.

## Problem

A personal knowledge base kept in git (an Obsidian vault, journals, meeting and people notes) is
fed by an agent: the user types raw input, answers a question or two, and expects the note filed,
linked and saved. cezar's code model gets in the way: a branch per note to review and merge,
agents may never land, two notes filed together conflict on the same daily note, and a question
about the notes still gets a worktree to clean up.

## Shape

Every key lives in `.ai/cezar/config.json`, is optional, and absent means today's code-project
behavior. **Settings → Tasks → Project type → Knowledge base / notes** writes the preset
`{ profile: 'notes', taskWorkspace: 'in-place', landing: 'auto', reviewGate: false }`; every key
stays adjustable on its own, and switching back to Code clears them.

| Key | Effect |
| --- | --- |
| `taskWorkspace: 'in-place'` | A task that does not ask (`worktree` absent on `POST /runs`, automations, the CLI) runs in the repo checkout. Applied in `execute`, recorded as `worktree: false`. Never for variants, dispatch or a PR head. The composer sends `worktree: true` explicitly when the user wants isolation. |
| `landing: 'auto'` | An in-place write run lands on `CEZ:DONE` (below). |
| `requiredChecks: string[]` | Shell commands run in the checkout after the rebase, before every push. |
| `defaultSkill`, `askSkill` | The composer preselects them when nothing is picked. |
| `teamSkills` (API) | `false` writes `skillsRepos: []`. |
| `systemPrompt` | Already existed (Settings → Instructions): the project-wide "read AGENTS.md, this is a knowledge base". |

### Serialized writes

In-place runs already share one repo-root lease (#438): a write task waits for the one before it,
so two notes submitted together are filed one after the other. Nothing new was needed. A write
task parked on a question keeps the lease, as before — its context describes the files as it left
them.

### Auto-land

On `CEZ:DONE`, both turn-end handlers call `landOnDone` before closing the session:

1. The checkout must be on a branch, and on `baseBranch` when one is configured.
2. Commit everything outside `.ai/cezar/` with the run title. cezar's own state never lands —
   committing `config.json` would track it, and a tracked config cannot grant auto-land.
3. With an upstream: fetch it, `git rebase @{u}`. A conflict aborts the rebase and names the files.
4. Run `requiredChecks`.
5. `git push <remote> HEAD:<branch>`; a rejected push (someone landed in between) fetches and
   rebases once more.

Step 2 commits whatever is dirty in the checkout, including edits the user made by hand while
the task ran; in a notes repo the agent is the only writer, which is the premise of the mode.

Without an upstream the local commit is the landing. A failure at any stage is sent into the
open session ("fix this, then end with CEZ:DONE again") up to `MAX_LAND_ATTEMPTS` (3); after that
the session closes and the run fails with the landing error. `settleSuccess` lands anything a run
left behind that never reached `CEZ:DONE` (Finish, an idle close) and fails the run if that
landing fails, so a run with unlanded work never wears a success badge. The outcome is recorded
on the run as `landing` (`status`, `sha`, `pushed`, `files`, or `stage` + `error`) and as notes.
`CEZ_DRY_RUN=1` skips fetch and push.

**Permission.** Pushing to the base branch is the owner's decision, so it is granted the way
worktree scripts are: a git-tracked `.ai/cezar/config.json` cannot grant it (the run notes why,
and Settings shows `landingBlocked`). The agent is told in its system prompt that auto-land is
granted and that cezar, not the agent, pushes — the Guard's written permission.

### Read-only (Ask) tasks

`POST /runs { readOnly: true }` runs in the checkout with tools `Read, Grep, Glob`, a read-only
system prompt, no repo-root lease (it runs beside a write task) and never lands. No branch, no
worktree, nothing to clean up. The composer offers an **Ask** chip on in-place and notes
projects; a notes project turns it on by itself when the message ends with `?`.

**Limit:** only Claude enforces `allowedTools`. Codex, OpenCode and the others get the
instruction but not the restriction (see #430); a write they make anyway is swept into the next
landing. A per-runner read-only sandbox is follow-up work.

## Not in phase 1

- **Per-workflow landing policy.** Phase 1 is per project.
- **File locks** (lock only the daily note). The lease already serializes all writes; finer locks
  would only matter if write tasks had to overlap.
- **Required checks on draft PRs and worktree runs.** They gate auto-land only.
- **Outcome-first task view** ("filed: meeting X, 2 tasks, updated person Y" with file links). The
  data is there (`run.landing.files`); the thread view does not render it yet.
- **Automation recipes** (weekly review on a schedule, inbox triage every few hours). The
  existing automations already run in the project's workspace and landing policy, since both are
  project defaults; one-click templates are missing.
- **Remote and mobile input.** Bookmarklets and `POST /runs` exist today; a phone/email path that
  turns into an ingest task needs a hosted entry point.
- **Skill routing beyond `?`.** Choosing among more than two skills from the message would need
  the namer model.
