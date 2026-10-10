# Env files in task worktrees

> Status: implemented (2026-10-10).
> Implementation: `packages/cezar/src/worktree-env.ts`, wired through `RunManager.seedWorktree`
> in `packages/cezar/src/workflows/run.ts`.
> Related: `2026-07-16-agent-config-files.md` §"The worktree problem" (the same problem, for the
> agents' own personal config), `2026-10-07-task-workspace.md` §6–7 (the terminal and the Browser
> column this makes useful in a worktree).

## 1. Problem

A task runs in its own worktree, and `git worktree add` gives that worktree the tracked files
and nothing else. A project's `.env` is gitignored by design, so in every project that has one
the task's tree cannot start anything that talks to a database, a payment provider or a mail
service — and the failure reads like a bug in the code rather than a missing file.

The task workspace made this visible. It offers a terminal in the worktree, discovers the
project's `dev` command and frames the address it prints; with no env files the command it
offers does not start, and the preview has nothing to show.

A project could work around it — WRAP-CREATORS carries `scripts/cezar-worktree-prepare.sh` as a
workflow step for exactly this — but that is configuration a user has to author before a
default cezar works, which is the thing `AGENTS.md` § Zero config rules out.

## 2. Behaviour

When cezar creates a worktree directory, it copies the main checkout's ignored env files in.

- **Which files.** A regular file named `.env` or `.env.<anything>` that **git reports as
  ignored** in the main checkout. Nothing is matched by name alone: a tracked `.env.example` or
  `.env.test` is not ignored, so it is left to the branch, at the branch's version.
- **Where.** At any depth up to six directories (`apps/<app>/.env`, `packages/<pkg>/.env`).
  Dependency and build directories are not searched, and neither is any directory with its own
  `.git` — a nested repository, or cezar's own worktrees under `.ai/cezar/worktrees`.
- **When.** At both sites that create a worktree directory: a new task, and a Continue that
  re-creates a directory retention had reclaimed. Both go through `RunManager.seedWorktree`,
  which also seeds the agents' personal config — that second site seeded neither before.
- **What the user sees.** One note in the task: `seeded env files from the main checkout: …`,
  listing paths. Contents never enter an event.

## 3. What it will not do

- **Overwrite.** A file the worktree already has is left alone. A task may have rewritten its
  env on purpose — its own port, its own database — and a fresh copy would silently point it
  back at the shared stack. The cost: a secret rotated in the main checkout reaches new
  worktrees, not existing ones.
- **Leak into a commit.** Every autosave is `git add -A`. Normally the worktree's own
  `.gitignore` hides the copy, but its branch may predate the rule. So each copy is checked with
  `git check-ignore` **in the worktree**; one that is not ignored there is added to the shared
  `.git/info/exclude`, and removed again if even that does not hide it.
- **Link.** Files are copied. A symlink would make an edit in one task's tree an edit in all of
  them, and does not survive Windows without elevation.
- **Run anything.** Dependencies are not installed. That is a command with a cost and a
  failure mode, and the workspace already offers the project's own commands in the terminal.

## 4. Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Default | On. `CEZ_WORKTREE_ENV=0` turns it off. | The worktree is not runnable without it, and a replacement that ships off is not a replacement. It adds no network or process exposure — see below. |
| Does the copy widen what an agent can read? | No. | The agent's default tool set includes unrestricted `Bash`, and the main checkout is a parent directory of its worktree. The files were already one `cat` away. |
| Which files | Git's ignore answer, not a name list. | No list to author; the repo already says which files belong to the machine. |
| Other untracked config (`.dev.vars`, `.envrc`, credentials JSON) | Not copied. | Each is a separate judgement about what is safe to duplicate. The env family is the one every project shares. |
| Hosted mode | Same behaviour. | The copy stays on the host that owns both trees. |

## 5. Not in this spec

Per-task ports and databases, so two worktrees can run the same stack at once; a preview proxy
for hosted mode; running a project's toolchain in a container. Each is a separate piece of the
same goal — a project buildable from cezar alone — and none is needed for the copy to be
correct.
