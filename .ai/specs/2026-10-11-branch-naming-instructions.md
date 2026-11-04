# Branch naming instructions

Status: implemented · Date: 2026-10-11 · Relates: spec `2026-07-17-task-auto-naming` (the namer this
extends), spec 006 (one worktree + branch per task)

## Problem

Every task branch is `cez/<id8>`. Teams with a branch convention (`feature/<slug>`,
`<type>/<area>/<slug>`) cannot follow it from cezar: the branch is created by `createWorktree`
before any agent step runs, so neither the Settings system prompt nor a workflow step can influence
it, and an agent that renames the branch mid-run breaks the bookkeeping that recomputes
`cez/<id8>` from the run id. The ask ("every time you create a branch, use …") was tried as a
prompt template and did nothing, which is the expected result.

The model to copy is Conductor's "branch rename preferences": free-text instructions, and a cheap
LLM call derives the name from the first prompt.

## Design

**One free-text setting.** `branchNaming` in `.ai/cezar/config.json` (Settings → Agents, beside
the system prompt; committable so a team shares it). Absent = `cez/<id8>`, exactly as today. No
template language — the instructions are prose and the namer reads them.

**One LLM call, not two.** The creation-time namer (`generateRunName`, fired fire-and-forget in
`startRun`) already reads the first prompt. When `branchNaming` is set its JSON answer gains a
`branch` field written under those instructions. The live title refresh at turn end never asks for
a branch.

**Wait at the fork, never rename.** The worktree is forked when the scheduler picks the task up.
On a busy cockpit that is seconds after creation and the answer is already in; on an idle one the
task starts immediately and the wait begins together with the namer call, and a cold `claude -p`
alone takes more than five seconds (run 269606ac forked on `cez/` under a 5 s budget). `execute`
therefore awaits the pending namer promise for `BRANCH_NAME_WAIT_MS` — the namer's own 20 s
timeout plus 10 s — and only when instructions are set; the zero-config path keeps the instant
fork. A timeout, a failed namer or `CEZ_AUTONAME=0` forks as
`cez/<id8>` and keeps it: a branch is named once, at creation, so a push or PR never points at a
name that later changed.

**Sanitize, then make unique.** The model's string goes through `sanitizeBranchName` (whitespace
to `-`, drop everything outside `[A-Za-z0-9._/-]`, collapse runs, strip `..`, `@{`, `.lock`, leading
`-`/`/`, cap 80 chars). The fork then appends `-<id8>` when a local or `origin/` branch of that name
already exists, so a generated name can never attach to someone else's branch.

**The record is the source of truth.** `RunRecord.branch` already exists; the sites that used to
recompute `cez/<id8>` read it instead:

- `createWorktree` takes `opts.branch` (restart recovery and `rematerializeReclaimedWorktree` pass
  the stored branch so the reattach path finds the right ref).
- `pruneOrphans` reads the orphan worktree's checked-out branch from `git worktree list` rather than
  deriving it from the directory name; `cez/<id8>` stays the fallback.
- `getBranches` hides every branch a run record owns from the base-branch picker, in addition to the
  `cez/` prefix.

**Cockpit.** While a run is `running` with no branch yet (and is not an in-place run), the branch
cell and the card meta show a small skeleton instead of the dash, so the wait reads as intentional.

## Non-goals

- Renaming an existing task's branch, or re-naming on the live title refresh.
- A template language or placeholders; the instructions are prose.
- Changing the worktree directory name (`.ai/cezar/worktrees/<runId>`) or the dispatch unit id.

## Settings regrouping (2026-10-12)

The branch rule was typed into the wrong Settings box twice before this feature existed: once as a
prompt template, once as the system prompt. Both sat on pages whose name said nothing about who
reads the text. Project Settings is therefore split by what a control IS, superseding the R6
§Settings layout (Agents held the system prompt; Prompt templates was its own section):

| Section | Holds | Rule |
| --- | --- | --- |
| Agents | providers, default runner and account, per-runner models | machinery: which agent runs |
| Instructions | system prompt, branch naming, prompt templates | text a model reads; each hint names the reader and the moment |
| Tasks | base branch, review before finishing, live title updates | behavior of a run, not of an agent |

`/settings/prompt-templates` redirects to `/settings/instructions#prompt-templates`; the composers'
"Edit templates…" links point there. The three sections share one `PUT /config` mutation
(`use-config-save.ts`). `config.json` keys and the API are unchanged. Provider-status gating only
ever disabled runner and model controls, so moving the textareas and toggles off the Agents page
removed the "unrelated settings stay usable" assertions rather than any behavior.
