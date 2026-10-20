# Trunk-based projects — work in the checkout, land on the base branch

Status: phase 1 implemented (2026-10-20). Server: `packages/cezar/src/workflows/landing.ts`, the
landing/read-only wiring in `workflows/run.ts`, config keys in `config.ts`. Cockpit:
`packages/web/src/routes/settings/trunk-based-fields.tsx` (Settings → Tasks), the Ask chip and
project defaults in `routes/new-task.tsx`.

## Problem

cezar's default is branch per task: an isolated worktree, a diff to review, a PR to merge, and
agents never land. Some repositories are worked trunk-based instead — many small changes that
should go straight to the base branch once they pass the repo's own checks: a knowledge base or
docs repo fed by an agent, a config or data repo, a solo project. There the default gets in the
way: a branch to review and merge per small change, no way to let agents land, parallel tasks
that conflict on the same shared files, and a read-only question that still gets a worktree to
clean up. cezar does not need to understand the content; the repo brings its own skills, schema
and checks, cezar provides the lifecycle.

## Shape

Every key lives in `.ai/cezar/config.json`, is optional, and absent means today's branch-per-task
behavior. **Settings → Tasks → Development model → Trunk-based** writes the preset
`{ profile: 'trunk', taskWorkspace: 'in-place', landing: 'auto', reviewGate: false }`; every key
stays adjustable on its own, and switching back to Branch per task clears them.

| Key | Effect |
| --- | --- |
| `taskWorkspace: 'in-place'` | A task that does not ask (`worktree` absent on `POST /runs`, automations, the CLI) runs in the repo checkout. Applied in `execute`, recorded as `worktree: false`. Never for variants, dispatch or a PR head. The composer sends `worktree: true` explicitly when the user wants isolation. |
| `landing: 'auto'` | An in-place write run lands on `CEZ:DONE` (below). |
| `requiredChecks: string[]` | Shell commands run in the checkout after the rebase, before every push. |
| `defaultSkill`, `askSkill` | The composer preselects them when nothing is picked. |
| `teamSkills` (API) | `false` writes `skillsRepos: []`. |
| `systemPrompt` | Already existed (Settings → Instructions): project-wide instructions every task gets (e.g. "read AGENTS.md first"). |

### Serialized writes

In-place runs already share one repo-root lease (#438): a write task waits for the one before it,
so two tasks started together run one after the other. Nothing new was needed. A write
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
the task ran; in a trunk-based project agents are expected to be the only writers to the checkout.

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
worktree, nothing to clean up. The composer offers an **Ask** chip on in-place and trunk-based
projects; a trunk-based project turns it on by itself when the message ends with `?`.

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
