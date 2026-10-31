# Systems — one grouping of related repositories, with upstream/downstream links and contracts

> Slug: `repository-systems` · Status: **draft — for specification review** · Base: `upstream/main`
> @ `b7af5e0c` (v0.15.0+). Builds on: `2026-07-20-multi-project-workspace.md` (registry, project
> contexts), `2026-08-10-global-tasks-and-project-tags.md` (tags as an engine-invisible lens, the
> global `/tasks` page), `2026-10-05-cross-task-waits.md` (open PR #1289: `cez task create
> --project`, wait edges). Answers the "project roles & groups" spec deferred in #1303 and blocking
> #1317, and settles #1084's Q1–Q7 for the grouping half.

## 📝 TLDR

People who keep one application in several repos (web + API, or a handful of microservices)
register each repo as its own project. Today cezar has no idea how those repos relate, so an agent
in `web` cannot tell that `api` provides the REST contract it calls, or which repo to hand work to.
**Proposed (future behavior):** an optional, user-defined **System**. It names its member projects,
each member's role, and the **links** between them: who provides and who consumes, over what
(HTTP API, events, shared schema, library, database), and where the contract file lives. Member
runs get a short, bounded "system context" prompt section. It tells the agent who is upstream and
downstream, how to read a sibling's contract read-only, and to hand cross-repo changes off with
`cez task create --project` instead of editing a sibling repo. Cross-repo work is **one task per
repo, coordinated by one lead task**: the user starts a "System task" in a lead repo, which hands
work to sibling repos (workers never delegate further), waits slot-free and finishes with a
summary and a merge order. Linked tasks show together in the cockpit. The global Tasks page can be
narrowed to one System, so the tasks behind one application read as one list. With no System
defined, cezar behaves exactly as it does today. A sibling spec, *contract impact*, outlined at
the end of this one, builds on the same links: when a reviewed task changes a contract its
project provides, the review gate lists the affected consumers.

## 📝 Open Questions — recommended defaults (design below assumes them)

Each question has a recommended default, and the rest of the spec is written under those defaults.
Items marked ⚠ change public surfaces or the product direction, so the owner must confirm them
before implementation starts.

| # | Question | Recommended default | Why |
|---|---|---|---|
| Q1 ⚠ | Name of the concept: `space`, `project`, `system`, `group`, `workspace`? | **System** (UI: "System", code: `systems`, file: `systems.json`). | See § Naming. `workspace`, `project` and `group` are already taken in this codebase. `system` is the term the leading software catalog (Backstage) uses for exactly this. |
| Q2 ⚠ | Does a System let one agent edit several repos in one session (#1084)? | **No.** A System is the grouping and relationship map. Cross-repo *work* goes through delegation (`cez task create --project`, #1289), so every repo keeps its own worktree, branch, review gate and PR. | The owner's 2026-10-06 brainstorm (#1303) prefers delegation over multi-repo editing. Delegation is runner-neutral (no `--add-dir`) and needs no `RunRecord` reshaping (BC §3). If #1084 is built later, its "repo sets" **are** Systems, so the project keeps one grouping concept. |
| Q3 ⚠ | One grouping concept: Systems, tags, or both? | **Both, with separate jobs.** Tags stay an engine-invisible lens (spec 2026-08-10, unchanged). A System is the one engine-visible group. The Settings page offers "create a System from tag X" as the bridge between them. | #1303 asks for *one* grouping that the engine reads. Promoting tags would make removing a tag dangerous, which that spec rejected outright. |
| Q4 | How many Systems may a project belong to? | **At most one in v1.** Enforced on write (409). The schema keeps `members` as an array, so lifting the limit later is additive. | This answers #1303's "what bounds a group?": the prompt has exactly one system to render, and two systems can never give an agent contradictory upstream/downstream maps. |
| Q5 | Where is a System stored? | **Its own file, `~/.cezar/systems.json`.** It follows the `agent-accounts.json` precedent (BC §9) and is never a key inside `config.json`. | A cezar version that has never heard of Systems never opens the file, so it cannot drop one. Membership references registered project ids **and the member's realpath root**; project removal clears membership (a new scrub, since the removal route scrubs nothing today). |
| Q6 | How does the agent read a sibling's contract? | **Read-only, through git and on every runner:** the prompt gives `git -C <root> show <ref>:<path>` against the provider's freshest base ref. No `--add-dir`, no sibling worktree. When a provider agent delegates work that depends on its own *unmerged* contract change, the delegation line tells it to name its branch (`cez/<id8>`) in the objective. Task worktrees share the provider repo's refs, so the consumer reads `git -C <root> show cez/<id8>:<path>` and sees the new contract, not the old one. | Only the Claude and Copilot runners support `--add-dir`. Every runner has a shell. Reading a ref also ignores whatever uncommitted state the user's sibling checkout is in. |
| Q7 | Should the review-gate "contract impact" banner (changed contract → affected consumers) ship in this spec? | **No. It moves to a sibling spec** (see § Follow-up spec). It needs only this spec's store, and the prompt does not need it, so each ships independently. When it ships, follow-ups stay user-clicked: never auto-created. | Scope cohesion: one deployable capability per spec. |
| Q8 | Is there a per-run opt-out of the system-context prompt? | **Not in v1.** The section is capped at 4 KB and present only in member projects. | A per-run toggle adds a `POST /runs` field and a `RunRecord` field for a token cost that is small and bounded. Revisit if users ask for it. |
| Q9 | Can Systems be shared with a team (committed file, export/import)? | **Deferred to a later spec.** v1 Systems are per-machine. | Portability needs members matched by remote URL rather than local project id, which is its own design. |
| Q10 ⚠ | Should `create --project` be limited to the System's members? | **No.** #1289 leaves it unrestricted, and this spec only *orders and annotates* targets (via `cez task projects`, #1303). | Restricting it would take away behavior that #1289's owner approved. |
| Q11 | Is a cross-repo task one task per System, or split? | **Split: one task per repo**, coordinated by one **lead** task in one member repo (§ Orchestration). | Every repo keeps its own worktree, branch, review gate and PR, which a single System-wide task cannot do without #1084's multi-repo editing. |
| Q12 | How is the lead started and told how to coordinate? | **A built-in `system-task` workflow** (`workflows/templates.ts`, next to `implement-and-verify`) with a **static** playbook, plus a "Start System task" button. The button opens the lead repo's composer preset with that workflow, `worktree: true`, and the existing `dispatch` intent (`maxSubtasks`, `budgetUsd`), which makes the lead a dispatch root that can file `cez task report` and bounds the tree's cost. There is no new run-creation route or `RunRecord` field. The default lead is the member that provides the most links, and the user can change it. | Built-in workflows are the canonical way to ship a reusable playbook. The dispatch intent is the existing primitive for a budgeted root. |
| Q13 | Can the lead and its workers message each other mid-run? | **No, not in this spec.** The lead sends the objective once, at creation. The worker answers once, through #1289's outcome delivery when it settles. Both can read each other's branches through git. The user can still message any task. | A cross-project message bus is new delivery semantics: ordering, wake-ups and storage. It is a follow-up only if real System tasks show that settle-time delivery is not enough. |
| Q14 | May a worker in a System task delegate further? | **No in v1.** `systemContextPart` omits the delegation lines for any run with `waitedBy`, and the playbook tells workers to report upstream needs back to the lead. | #1289's `create` path has no depth or cycle check, and a lead started without a budget has no ceiling, so letting workers delegate would allow an unbounded, recursive tree of paid autonomous runs (A→B→A…). A one-level tree is bounded by the lead's `maxSubtasks` and budget. |

## 📝 Problem Statement

- **A project is exactly one repo, and nothing records how repos relate.** All state is scoped per
  project (`server/project-context.ts`; `/api/v1/p/:projectId/…`; `RunRecord.worktreePath`,
  `branch` and `pullRequestUrl` are singular). The only cross-repo signal is `tags`. Spec 2026-08-10
  made tags engine-invisible on purpose, and they are many-valued free text: tagging two unrelated
  repos `frontend` must not make them delegation targets of each other (#1303's brainstorm).
- **Delegation is arriving without an address book.** #1289 adds `cez task create --project` and
  cross-task waits. #1303 adds `cez task projects` so an agent can find target ids. Neither tells
  the agent **which** project serves which purpose, **in which direction** a dependency runs, or
  **where** the contract lives. #1317 ("Generate description") is blocked on exactly this missing
  per-project role field.
- **Contract drift is the real cost.** In a web + API split, the expensive failure is an agent
  changing `openapi.yaml` (or an event schema, or a proto) in the provider and stopping there,
  while the consumers break. Nothing in cezar connects "this diff touched a contract" with "these
  repos consume it".
- **Evidence it matters.** #1084 (open, `risk-high`) asks for multi-repo tasks and repo sets. #1284
  (closed) deferred cross-project rosters to it. #1289 and #1303 each exist because users run one
  application across several registered repos. No open issue or PR defines relationships or
  contracts between repos (checked 2026-10-13 against `open-mercato/cezar` issues and PRs:
  #1084, #1284, #1289, #1303, #1316, #1317).

## 📝 Naming

| Candidate | Verdict |
|---|---|
| `workspace` | Taken. It means the whole per-user installation: `~/.cezar/`, `/api/v1/workspace/*`, BC §9 and `resources.maxParallel`. |
| `project` | Taken. It means one registered repo (`/p/:projectId`). |
| `group` | Taken twice: the sidebar's per-project block (`components/project-groups.tsx`) and "group by" on `/tasks`. #1303 also uses "project groups" loosely. |
| `space` | Too vague. It suggests a container that *owns* tasks, and a System does not. No prior art. |
| repo set (#1084) | Describes membership only, and relationships are the point here. Kept as the description of what a System *contains*. |
| stack | Clashes with stacked PRs (Graphite and similar) and docker-compose stacks. |
| product | A business term. One product often spans several systems, and many systems have no product. |
| **system** | **Chosen.** Backstage's catalog uses exactly this word: "a collection of components that exposes APIs and works together". It reads naturally ("the storefront system: web → api → payments"). The word also appears in code as "system prompt" and the "system" theme, so code identifiers always say `systems`, `RepoSystem` or `systemContext`, never a bare `system` variable. |

## 📝 Research — prior art

- **Backstage Software Catalog** (Spotify, CNCF). Its kinds are `System`, `Component`, `API` and
  `Domain`, with the relations `partOf`, `providesApis`/`consumesApis` and `dependsOn`.
  *Taken:* the name and the provider → consumer link with a contract as the edge payload.
  *Skipped:* a separate `API` entity, `Domain`, ownership groups, YAML ingestion from repos. A
  link's optional `contract.path` covers what `API` entities do for a coding agent.
- **Nx / Turborepo project graph, `nx affected`.** These tools infer dependencies from imports and
  compute which projects a change affects. *Taken:* "affected consumers" as the payoff of the graph
  (the follow-up contract-impact spec). *Skipped:* inference. Across repos there is no shared import graph,
  so the links are declared by the user.
- **Sourcegraph Batch Changes, multi-gitter, Renovate group PRs.** One logical change produces one
  PR per repo, and a view tracks them together. This confirms #1084 Q3's per-repo answer: the PR
  stays per repo, and only the *view* is grouped.
- **Gerrit topics and Zuul `Depends-On`.** Cross-repo changes are ordered by explicit dependency
  footers, and the gate merges them in order. *Taken:* the follow-up objective states "merge after
  <provider PR>". *Skipped:* enforced cross-repo gating, because cezar never merges (review gate).
- **Google `repo` manifests, `meta`, VS Code multi-root `.code-workspace`.** These are a list of
  repos with no relationships. They show that a plain repo set is cheap and well understood, and
  that relationships are what cezar would add.
- **Pact and AsyncAPI/OpenAPI-first.** The contract is an artifact that lives at the boundary.
  *Taken:* a per-link contract path, plus discovery of conventional contract files.
  *Skipped:* a broker and verification runs.
- **Claude Code `--add-dir` and Cursor multi-root.** These give an agent read and write access to
  several roots. *Skipped in v1* (Q2, Q6): only two of cezar's runners support it, and write
  access across repos is exactly what the owner's delegation direction avoids.

## 📝 Proposed Solution

1. **A System store** (`~/.cezar/systems.json`). It holds the name, description, members (project id
   plus role) and links (provider, consumer, kind, optional contract path and notes). The file is
   optional and degrades gracefully: when it is missing, corrupt or unreadable, there are no Systems
   and one warning is logged.
2. **A Systems API family** (`/api/v1/systems`, workspace-level, mounted once) and a **Settings →
   Systems** editor. The editor's empty state offers to create a System from any tag that two or
   more projects share.
3. **System context in member runs.** The section is composed at both session sites in
   `workflows/run.ts`, so it reaches the first step, every Continue and every restart recovery. It
   is ≤ 4 KB, framed as user configuration, and lists upstream and downstream projects with
   read-only contract commands. The lines about delegation appear only when `create --project`
   exists and is enabled (#1289).
4. **Visibility.** `/tasks` gains a System facet, a project row shows its System, and
   `cez task projects` (#1303) lists System siblings first, with their roles.
5. **Orchestration.** A cross-repo change is one lead task plus one worker task per affected
   repo. A built-in `system-task` workflow carries the coordination playbook, and the cockpit
   shows linked tasks together (§ Orchestration, Phase 3, needs #1289).

**Alternatives considered**

| Alternative | Why it lost |
|---|---|
| Promote tags to the group (a designated tag) | Spec 2026-08-10 rejected engine-read tags. A tag carries no direction and no contract, so the relationship data would need a home anyway. |
| One System owns its runs (`~/.cezar/systems/<id>/runs`, a `/s/:systemId` scope); #1084 Q1(b) | A second run store, a second route scope, and a second index for retention, recovery and ⌘K, all to list tasks the `/tasks` facet can already list. It cannot be undone once runs live there. |
| A primary repo plus attached worktrees in one run (#1084 Q1(a), multi-repo editing) | Runner-dependent (`--add-dir`), and it touches `RunRecord`, retention, diff/PR routes and slot accounting (Q2–Q6 of #1084), against the owner's delegation direction. It stays possible later, with Systems as its "repo set". |
| A per-project `description` on the registry entry (#1317's wording) | A role only means something relative to the siblings, and a registry key would make `config.json` carry System data an older writer could drop (BC §9). The role lives on the System member instead, and #1317's button writes there. |
| Infer links from code (package names, OpenAPI client generators, compose files) | Noisy and per-ecosystem. It would run on every edit or every run, and a wrong inferred edge is worse than none. Discovery is limited to *suggesting contract files*. |

## 📝 Architecture

```mermaid
flowchart LR
  subgraph home["~/.cezar (workspace)"]
    reg["config.json projects[] (existing)"]
    sys["systems.json (NEW)"]
  end
  api["/api/v1/systems family (NEW)"] --> sys
  del["DELETE /api/v1/projects/:id + cezar projects remove (existing)"] -->|scrub membership| sys
  sys --> ctx["systemContextPrompt (NEW)"]
  ctx --> run["run.ts session sites ×2 (existing)"]
  ctx --> prev["GET /api/v1/systems/:id/preview (NEW)"]
  sys --> cli["cezar systems CLI (NEW) + cez task projects (planned, #1303)"]
  run -.->|"cez task create --project (planned, #1289)"| other["sibling project run"]
```

Takeaway: only one engine path consumes a System, prompt composition, and it reaches the agent
through the existing system-prompt seam. Every other reader is a view: the API, the cockpit, the
CLI and `cez task projects`. Nothing outside `systems.json` is written. Removing every System
returns cezar to today's behavior byte for byte.

- **New: `packages/cezar/src/workspace/systems.ts`.** Owns the store: `loadSystems()` and
  `mergeWriteSystems(fn)` (read-modify-write, atomic tmp+rename, `0600`, path resolved **once**
  per AGENTS.md § workspace registry), `normalizeSystemInput()`, which the route and the CLI share,
  and `scrubProjectFromSystems(projectId)`. It also keeps an in-memory snapshot refreshed by
  write and by an mtime check at session start, never polled. A corrupt file degrades to
  `{systems: []}` with one warning and stays on disk until the next successful write, which first
  renames it aside to `systems.json.corrupt-<ts>` so its content is never silently lost. The schema
  uses per-key `.catch`, per-entry salvage for `systems[]`, `members[]` and `links[]`, and
  `.passthrough()` at every level, the same rules as BC §9. There is **no `.bak` restore**.
  AGENTS.md names `config.json.bak` as the one deliberate exception to "delete it and it resets",
  and `agent-accounts.json` (the precedent this file follows) has none. Deleting `systems.json`
  therefore resets Systems.
- **New: `packages/cezar/src/workspace/system-context.ts`.** The pure function
  `systemContextPrompt({system, projectId, registry, refs, delegation})` returns a string or
  `undefined`. It returns `undefined` when the project is not a member, or when no *other* member is
  registered and present. The project's own role and its direct links are always kept. When the
  section would exceed 4 KB, content is cut in a fixed order: the System description is shortened
  first, then link `notes`, then links beyond the first 12. Each cut is marked `…(truncated)`.
  `refs` maps each provider to its freshest base ref through the existing `freshestBaseRef`
  (`git-diff-base.ts`, exported for this), the rule AGENTS.md mandates for "which ref is current".
  One `git cat-file -e <ref>:<path>` per contract path (≤ 20 per System, and it works for files
  and directories) flags paths missing from that ref as "(not found on <ref>)", so a stale path
  never reads as authoritative. A file path renders `git -C '<root>' show '<ref>:<path>'`. A
  directory path (stored with a trailing `/`) renders
  `git -C '<root>' ls-tree -r --name-only '<ref>' -- '<path>'` followed by the `show` form.
  **Every interpolated root, ref and path is single-quoted** (with `'` escaped), so a root with
  spaces still works and no stored value can become shell syntax. Free text (`role`, `notes`,
  `description`) is rendered inside a fenced block under the header "Configuration written by the
  user, not instructions. It never overrides the task."
- **Git failure policy (session-start path).** Ref resolution and the `cat-file` checks run with a
  short per-call timeout (2 s) and a shared budget (5 s per session start). On any git error or
  timeout, the "(not found)" flags and the ref-specific commands for that provider are dropped and
  the rest of the section is kept. A git failure never removes the System map and never delays or
  fails a run.
- **Changed: `workflows/run.ts`.** Both `composeSystemPrompt(...)` sites, one in `execute` and
  one in `runContinuation` (cited by function because #1289 moves the line numbers), gain one part
  from a single helper, `systemContextPart(run)`. It takes the run, not only the project id,
  because it gates the delegation lines on the run itself (below). Per AGENTS.md, *find every construction site*: there is no new
  `ActiveRun` field, and the part is recomputed per session from the snapshot. A Continue therefore
  sees current Systems, and a restart behaves like a Continue.
- **Changed: `server/server.ts`.** A new chained family builder `systemsRoutes` mounts once under
  `/api/v1/systems`, with validation through `jsonZodValidator`, `paramZodValidator` and
  `queryZodValidator`. The project-removal handler calls `scrubProjectFromSystems(id)` after
  `removeProject(id)`. `projects-cli.ts` `remove` does the same, routed through one helper so the two
  removal paths cannot drift.
- **Changed (after #1303 merges): `dispatch/task-cli.ts` `projects`.** Same-System projects are
  listed first with `system` and `role` columns. The change is additive output on a command that
  does not exist on `main` yet.
- **Cross-system effects.** There is no change to runners, worktrees, `RunRecord`, retention, the
  semaphore or dispatch. Each delegated task is an ordinary single-repo run: one slot, its own
  worktree and branch `cez/<id8>`, its own review gate and PR. Waiters park slot-free per #1289.
  This settles #1084's Q2, Q3, Q6 and Q7 by construction.
- **Delegation lines and their gate.** #1289 already injects the `cez task create --project` and
  `cez task wait` syntax into every run where it is reachable (`waitsPrompt` via
  `prepareDispatchSession`). The System section therefore **never restates CLI syntax**, because two
  copies would drift. It only adds *which* ids to hand off to and why (roles, link direction), plus
  the rule "hand cross-repo changes off; do not edit another repository". These lines appear only
  when the run manager's own per-session checks (#1289's `waitsReachable()` and
  `dispatchReachable()`) both pass. That is the same gate #1289 uses, so the two prompts always
  agree, including in a headless `cezar run`, where dispatch is unreachable. They are also
  omitted for any run with `waitedBy`: **a worker never delegates further** (Q14).
- **Degradation when a peer is absent.** If #1289 is not merged, or `CEZ_TASK_WAITS=0` /
  dispatch is off, the delegation lines are omitted and the map and read-only contract commands
  remain. If a member project is `missing`, it is shown as unavailable in the UI and left out of the
  prompt. If the provider is not a git repo, the contract command is omitted for that link. A
  read-only home makes every write answer 500 with the reason, while reads keep working.

## 📝 Orchestration — how a cross-repo task runs

**Shape: one lead plus N workers, one task per repo.** A System is not a task container (Q11).
A change that spans repos is a **lead** task in one member repo and **worker** tasks in sibling
repos. Each is an ordinary single-repo run, with its own worktree `cez/<id8>`, slot, review gate
and PR. The lead/worker link is #1289's wait edge: `waits[]` on the lead, `waitedBy` on each
worker. This spec adds no new link.

**How the tasks communicate**

| Direction | Channel | Carries | Timing |
|---|---|---|---|
| Lead → worker | The objective given to `cez task create "<objective>" --project <id>` (#1289), plus `title`, `scope`, `success` and `budget` | What to do, where the contract is (`git show cez/<lead-id8>:<path>` when the lead changed it), and what "done" means | Once, at creation |
| Worker → lead | #1289 outcome delivery when the worker settles (`deliverMessage`, else `enqueueMessage`) | Status, title, branch, PR URL, cost, the worker's `cez task report` result, last error | Once per worker, at settle |
| Either → either | Git refs, read-only: task worktrees share the repo's refs | The other side's committed code and contracts (`git -C <root> show <branch>:<path>`) | Any time, as of the last commit |
| Worker → human | `CEZ:ASK` | A question only the user can answer. It does **not** settle the edge (#1289 Q3), so the lead keeps waiting | Until the user answers |
| Human → any task | The cockpit composer | Corrections and answers | Any time |

There is no agent-to-agent chat (Q13). A lead that must correct a worker does it after that
worker settles: it creates a follow-up worker on the same branch topic, or it reports back to the
user.

**The `system-task` playbook** is the built-in workflow (Q12). It has one agent step, and its
prompt wraps `{{task}}`. Its text is **static**, because a built-in is a constant validated when
the module loads (`templates.ts` `builtIn()`) and cannot compose itself per session. The playbook
refers to "the System section and the task tools described above". Whether those tools are
present is decided per session by `systemContextPart` and #1289's own prompt, so the playbook
never names a command that the run cannot use. The playbook adds the procedure:

1. **Plan per repo.** List which members need a change and why, using the upstream/downstream
   links. A repo with no change gets no task.
2. **Contract first.** If this repo provides a contract that changes, change it here, commit, and
   name the branch. If another repo owns the contract, create that worker first and wait for it
   before fanning out to its consumers.
3. **Fan out.** Create one worker per remaining repo with the cross-project task tool described
   above (the playbook text names no command). Each
   objective is self-contained: the goal, the contract command, the acceptance check, and "do not
   edit other repositories". It also says that the worker must not create tasks itself, and
   should report any upstream need back in its own report (Q14). Independent workers run in
   parallel. Create at most 4 at a time (#1289's `WAIT_MAX_PENDING`) and batch the rest after
   earlier ones settle.
4. **Wait, never poll.** End the turn. Each settle wakes the lead with that worker's outcome.
   Then: accept it, create a follow-up worker, or stop and ask the user.
5. **Finish with a summary** in the lead's own `cez task report` and final message. The lead can
   file it because "Start System task" makes it a dispatch root (see below). The summary lists
   **one branch per repo** (`cez/<id8>`, plus the PR URL only when one was opened; workers settle
   at `review` without a PR by default), the merge order (providers before consumers, from the
   links), and anything left undone.

Default split strategy is **contract first, then fan out**. The playbook also lets the lead fan
out immediately when the objective already fixes the contract. **Workers do not delegate** (Q14).
A worker that discovers it needs an upstream change says so in its report, and the lead, woken
with that outcome, creates the upstream worker. The tree is therefore always one level deep: one
lead and at most `maxSubtasks` workers. This replaces the "discovered on the way" case for System
tasks. A plain run in a member repo that has no `waitedBy` can still hand work off, exactly as
#1289 allows.

**Where the lead lives.** "Start System task" (the System editor and the `/tasks` System facet)
preselects the member that is the provider in the most links, with ties going to the first
member. The user can pick any member. The button opens that project's composer preset with
`workflow: system-task`, `worktree: true` (a lead commits its contract change, so it must never
commit on the user's own checkout), and the existing `POST /runs` **`dispatch` intent**
(`dispatchIntentSchema`), prefilled with `maxSubtasks` (default: the number of other members) and
an editable `budgetUsd`. The intent is what makes the lead a dispatch root. That root is what lets
`cez task report` work (`recordReport` refuses a run without a `dispatch` record), and it gives
the tree a cost ceiling that workers' carved budgets come out of. None of this is a new field: it
is the composer's existing dispatch preset. The button creates nothing until the user submits.

**What the user sees.** #1289 already ships `TaskWaitsLine` and `CreatedByLine`
(`web/src/components/task-waits.tsx`). This spec **extends them rather than adding a panel**. On a
lead, `TaskWaitsLine` also lists settled and created edges (not only pending ones), each with
repo, title, live status, branch or PR chip, and edge state, joined to the existing workspace runs
index (`GET /api/v1/workspace/runs-index`), so no new route is needed. On a worker,
`CreatedByLine` is unchanged. `/tasks` gains **group by lead**:
a lead with its workers folded under it. This needs `waitedBy?` on `runIndexEntrySchema`, an
additive optional key, unless #1289 already adds it. `dashboardTaskRowSchema` is
`runIndexEntrySchema.omit({usage})` (`contract/dashboard.ts`), so the key also reaches the
dashboard payload. Its parity test and BC §2 entry are updated in the same step.

**Gating and degradation.** The button needs #1289 with `capabilities().taskWaits` and dispatch
on (the cockpit's view of the same flags). Otherwise the button is disabled with the reason
("cross-task waits are off on this cockpit"). A `system-task` run started by name anyway has no
hand-off tools in its prompt. The playbook tells it to do this repo's part only and list the other
repos' work in its summary instead of delegating it. Merge order is advice only: cezar never merges, and each PR still goes through
its own review gate.

## 📝 Data Model

New file `~/.cezar/systems.json` (BC §9 addition). The zod schema lives in
`packages/contract/src/systems.ts` for the API shapes. The persistence schema in
`workspace/systems.ts` is the same shape made permissive (`.catch` / `.passthrough()`).

```ts
type SystemsFile = {
  version: 1;
  systems: RepoSystem[];
};
type RepoSystem = {
  id: string;            // slug from name, unique; allocated like project ids; immutable
  name: string;          // 1..64
  description?: string;  // ≤ 2000 — "how it fits together" (protocols, brokers, auth, envs)
  members: SystemMember[];   // 0..20 — 0 is valid (a draft, or after a scrub) and inert in prompts
  links: SystemLink[];       // 0..40
  createdAt: string;     // ISO
  updatedAt: string;     // ISO — optimistic-concurrency token for PUT
};
type SystemMember = {
  projectId: string;     // a registered project id (never the unregistered boot entry)
  root: string;          // the member's realpath root, captured when it was added. Project ids are
                         // slugs of basename(root) and get reused, so the id alone cannot prove
                         // that this is still the same repo.
  role?: string;         // ≤ 500 — "REST backend for web + mobile" (#1317 writes here)
};
type SystemLink = {
  id: string;            // stable within the system (nanoid-8)
  provider: string;      // projectId — UPSTREAM: owns the contract
  consumer: string;      // projectId — DOWNSTREAM: depends on it
  kind: 'http-api' | 'events' | 'shared-schema' | 'library' | 'database' | 'other';
  contract?: {
    paths?: string[];    // ≤ 5, repo-relative IN THE PROVIDER: a file, or a directory with a
                         // trailing `/` (`schemas/events/`). No globs in v1: git show cannot take one.
    notes?: string;      // ≤ 500 — "REST /v2, bearer auth"; "NATS subject orders.*"
  };
};
```

Invariants (enforced by `normalizeSystemInput`, 400 on violation): member ids are unique; every
link endpoint is a member; `provider !== consumer`; no duplicate `(provider, consumer, kind)`;
paths are relative, not absolute, contain no `..` segment, and use only `[A-Za-z0-9._/-]`. That
excludes globs, spaces and every shell metacharacter, and quoting (§ Architecture) is the second
layer. a project
belongs to at most one System (409, Q4). A member counts as **dangling** when its id is not in the registry, or when the registry entry's
root differs from the stored `root`. The second case covers a freed id that was reused by another
repo with the same basename. A dangling member is shown `unregistered`, never rendered into a
prompt, and dropped silently with its links on the next save, so a whole-replace PUT never fails
on it. A member that is *new* to the System must be registered (400 otherwise). The server fills
in its `root` from the registry and ignores any client-sent value. Cycles are **allowed**. Two services that exchange events both ways are a real case, and
links describe relationships rather than scheduling anything.

No `RunRecord` change, no `.ai/cezar/` change, no `config.json` change. Sensitive data: none by
design. The fields are user-authored descriptions of local repos, stored `0600`. The editor's help
text tells users not to put credentials in `notes`, and the prompt renders `notes` verbatim, so a
secret pasted there would reach the agent. The existing `secret-redaction` pass still scrubs known
env secret values from event text.

```mermaid
flowchart LR
    classDef newEntity fill:#2f6feb,color:#fff,stroke:#1b4fb0
    classDef existingEntity fill:#e5e7eb,color:#111,stroke:#9ca3af

    entity_1["RepoSystem"]:::newEntity
    entity_2["SystemMember"]:::newEntity
    entity_3["SystemLink"]:::newEntity
    entity_4["WorkspaceProject (config.json projects[])"]:::existingEntity
    entity_5["RunRecord (per-repo runs.json)"]:::existingEntity

    entity_1 -->|1-n| entity_2
    entity_1 -->|1-n| entity_3
    entity_2 -->|"n-1 projectId (≤1 system per project)"| entity_4
    entity_3 -->|"n-1 provider"| entity_4
    entity_3 -->|"n-1 consumer"| entity_4
    entity_4 -->|1-n| entity_5
```

## 📝 API Contracts

New `packages/contract/src/systems.ts`, re-exported from `index.ts`. Each route is chained into the
`systemsRoutes` builder, mounted **once** (workspace-level, like `/projects`), and validated as
middleware. All of it is same-origin, and the existing `/api/*` origin guard covers every mutation.

| Route | Body / query | Answer | Errors |
|---|---|---|---|
| `GET /api/v1/systems` | — | `{systems: SystemView[]}` | never errors; a corrupt or missing file answers `[]` |
| `POST /api/v1/systems` | `SystemInput` | `{system: SystemView}` 201 | 400 invalid; 409 member already in another System |
| `PUT /api/v1/systems/:systemId` | `SystemInput & {expectedUpdatedAt?: string}` (whole replace) | `{system: SystemView}` | 400; 404 unknown; 409 member conflict or stale `expectedUpdatedAt` |
| `DELETE /api/v1/systems/:systemId` | — | `{removed: true, id}` | 404 |
| `GET /api/v1/systems/:systemId/preview` | `?projectId=` | `{prompt: string \| null}`: exactly what `systemContextPrompt` renders for that member (`null` when nothing would be injected) | 404 unknown System or project |
| `GET /api/v1/systems/contract-candidates` | `?projectId=` | `{available: true, paths: string[], truncated: boolean}` or `{available: false, reason}` | 404 unknown project |

- `SystemInput = {name, description?, members: [{projectId, role?}], links: [{id?, provider,
  consumer, kind, contract?}]}`. The server allocates `id` and a missing `link.id`.
- `SystemView = RepoSystem` with each member enriched by `{name, status: 'ok' | 'missing' |
  'not-git' | 'unregistered'}`. `unregistered` marks a dangling id left by a crash between the
  registry write and the scrub; it is shown and never rendered into a prompt. Keys that may be
  undefined are spread conditionally, per the AGENTS.md wire rule.
- `contract-candidates` reads `git ls-tree -r --name-only <freshest base ref>` once per request.
  It filters for conventional names (`openapi*`, `swagger*`, `asyncapi*` in `.yaml`, `.yml` or
  `.json`; `*.proto`; `*.graphql`/`*.gql`; `*.avsc`; `**/schemas/**/*.json`) and caps the list at
  50 (`truncated`). It never writes and never reaches the network. A candidate inside a schema
  directory is also offered as the directory itself (`schemas/events/`).
- Tests: `contract-parity.systems.test.ts` (both directions), `typed-bodies.test.ts` (routes reach
  `AppType`), and `bc-route-inventory.test.ts` (new routes listed in BC §2). All routes are
  workspace-level, so `route-parity.test.ts` is unaffected.

CLI (BC §1, additive): `cezar systems [list]`, `cezar systems show <id>`, and
`cezar systems remove <id>`, which read and write the file directly with the same normalizer.
**Creating and editing are deliberately cockpit-only in v1.** A link table is awkward to express
in flags, and `remove` exists so a headless user can always undo. Import/export (a later spec) is the
planned headless authoring path.

## 📝 UI/UX

Prototype: `.ai/specs/assets/2026-10-13-repository-systems/` contains static, illustrative HTML
mockups (open from disk, with `#light` for the light theme) plus dark and light PNG renders. They
show layout and flow, not final design, and prove no working behavior.

| # | Screen | Phase | Mockup |
|---|---|---|---|
| 01 | Settings → Systems, empty state with create-from-tag suggestions | 1 | ![](assets/2026-10-13-repository-systems/mockup-01-systems-empty-dark.png) |
| 02 | System editor: members and roles, links and contract paths, relationships, agent preview | 1–2 | ![](assets/2026-10-13-repository-systems/mockup-02-system-editor-dark.png) |
| 03 | Start System task: composer preset with lead, `system-task` workflow, worktree and dispatch limits | 3 | ![](assets/2026-10-13-repository-systems/mockup-03-start-system-task-dark.png) |
| 04 | Lead run: extended `TaskWaitsLine`, session hand-offs, final summary with one branch per repo | 3 | ![](assets/2026-10-13-repository-systems/mockup-04-lead-run-dark.png) |

Light renders sit beside each file as `…-light.png`.


- **Settings → Systems** (`/settings/global/systems`, outside the project scope, like the other
  global settings).
  - *Empty state:* "Systems tell agents how your repositories depend on each other." Below it, one
    suggestion per tag that two or more projects share: "Create **storefront** from 3 projects
    tagged storefront". Without such tags it shows only the Create button.
  - *Editor:* name and description; members as a project picker plus a role field per member
    (#1317's "Generate" button lands beside it later); links as rows of
    `provider ▸ consumer · kind · contract paths · notes`. The contract-paths field autocompletes
    from `contract-candidates` and still accepts free text.
  - *Read-only views in the editor:* a "Relationships" list per member ("api: upstream of web
    (http-api), downstream of payments (library)") and an **Agent preview** that shows exactly what
    `systemContextPrompt` renders for a selected member. That makes the prompt cost and content
    visible before any run.
  - Saving sends PUT with `expectedUpdatedAt`. A 409 shows "Changed elsewhere — reload" and never
    silently overwrites.
- **Settings → Projects row** shows a "System: storefront" chip that links to the editor.
- **Global `/tasks`** gets a **System** facet and a group-by option, derived from current
  membership exactly as tags are. A run's System is its project's System.
- **Composer** (member projects only) shows a small inline "System: storefront" chip with a tooltip
  ("Agents in this project see the storefront map"). It is informational, with no toggle (Q8).
- **Start System task** (System editor and the `/tasks` System facet), the extended
  `TaskWaitsLine` on run detail and **group by lead** on `/tasks`: specified in § Orchestration.
- Accessibility and theming follow the house rules: keyboard-reachable rows, light/dark/system,
  and unit coverage for the editor states (empty, suggestions, editing, 409, read-only home error).

## 📝 Edge Cases & Failure Scenarios

| Scenario | Behavior |
|---|---|
| `systems.json` missing (or deleted by the user) | No Systems. The prompt and UI chips are absent, and behavior is identical to today. |
| `systems.json` corrupt | One warning, and `GET` answers `[]`. The file stays on disk until the next successful write, which first renames it aside to `systems.json.corrupt-<ts>`, so nothing is silently lost and nothing is auto-restored. |
| Read-only or full home | Reads work. Writes answer 500 with the OS reason, the atomic write persists nothing, and the UI shows a one-line error. |
| Member project removed (route or CLI) | Membership and the links touching it are scrubbed in one atomic write. A System left with no members is kept. |
| Member id reused: a removed project's slug is reallocated to a different repo with the same basename | The stored `root` no longer matches, so the member is `unregistered` and never rendered as the old repo. |
| Git slow or failing during session start | Per-call 2 s timeout and a 5 s budget. The ref-specific commands and "(not found)" flags for that provider are dropped, the map stays, and the run is never delayed beyond the budget. |
| Crash between registry removal and the scrub | A dangling member is shown `unregistered`, skipped by the prompt, and dropped (with its links) by the normalizer on the next save of that System. It is never a 400. |
| Consumer task must follow an unmerged provider change | The provider agent names its branch in the delegated objective (Q6), and the consumer reads the contract from that branch, not from base. |
| Member root moved or deleted (`missing`) | Shown as unavailable and left out of the prompt. Its links are kept, because the user may restore it. |
| Contract path not on the provider's base ref | The prompt says "(not found on origin/main)" instead of rendering a command. |
| Provider is `not-git` | The link is kept and the contract command is omitted. `contract-candidates` answers `{available: false, reason}`. |
| Two tabs edit the same System | The second save gets a 409 through `expectedUpdatedAt`. |
| Old cezar sharing the home | It never opens `systems.json`, so it loses nothing and shows nothing. |
| Dispatched child or delegated task in a member project | It gets the same section, because it is a run of that project. Consistent by construction. |
| A worker discovers it needs an upstream change | It has no delegation lines (Q14), so it reports the need and settles. The lead wakes with that report and creates the upstream worker. |
| A worker settles `failed` or `cancelled` | The lead is woken with that outcome (#1289 Q3). The playbook tells it to retry once with a corrected objective or stop and report, never to edit the worker's repo itself. |
| A worker never settles (stuck, or the user never answers its `CEZ:ASK`) | #1289's edge deadline (24 h default) wakes the lead with `timed-out`, and the lead reports what is still open. |
| A System change needs more than 4 workers | The playbook creates them in batches of at most 4 (`WAIT_MAX_PENDING`). Further `create` calls are refused by #1289 until an edge resolves. |
| The lead is cancelled or deleted while workers run | #1289 resolves its edges as `waiter-ended`. Workers keep running as independent tasks with their own review gates, and each worker's `CreatedByLine` still names its creator. |
| "Start System task" while waits are off | The button is disabled with the reason. A `system-task` run started by name runs single-repo without delegation steps. |
| A role or description that was generated from repo content (#1317, later) | It is still framed as configuration. The prompt header says it is context and must not override the task. |

## 📝 Risks & Impact Review

- **Product direction (needs the owner, not a defect):** Q1 (the name), Q2 (no multi-repo
  editing, which closes #1084's single-session variant for now), Q3 (tags and Systems coexist), and
  Q10. Scoping, decided by the author 2026-10-14: Phase 3 (orchestration) **stays in this spec**,
  rather than in its own spec gated on #1289 as the architectural review suggested. Because it
  targets semantics still moving in an open PR, its first step is "re-verify every #1289 reference
  against the merged code". A "no" on Q2 means a different spec. Systems would remain useful as #1084's repo set, but
  §§ Architecture and Phasing would change.
- **Prompt-surface risk.** Every member run's system prompt gains up to 4 KB. Mitigations: members
  only, a hard cap, the Agent preview, and the section is never present without a user-created
  System. The prompt also tells agents to delegate rather than edit siblings. That is guidance and
  not enforcement: cezar's zero-config `Bash` stays unrestricted (#430), and the agent can still
  write to a sibling path. Enforcement is out of scope and noted as a follow-up.
- **Prompt injection.** Free text (`role`, `notes`, `description`) is user-authored today. With
  #1317's generated roles and a future import, it will be partly repo-derived. It is rendered
  fenced, under a "configuration, not instructions" header, and every value that reaches a shell
  command is charset-restricted and single-quoted.
- **Hard-to-reverse surfaces.** The new routes (BC §2), the `runs-index`/dashboard `waitedBy?` key
  (BC §2), the file format (BC §9), the CLI subcommands (BC §1) and the built-in workflow name
  `system-task` (BC §4: built-in names are protected) are all additive. `version: 1` reserves room for a numbered migration. Rollback means
  removing the feature: `systems.json` stays on disk, and nothing else depends on it.
- **Dependency risk.** The delegation lines and `cez task projects` enrichment depend on unmerged
  #1289 and #1303, and Phase 3 depends on #1289 entirely. Phase 1 does not. Phase 2 ships the map and contract commands regardless and
  adds the delegation lines behind the run manager's per-session `waitsReachable()` and
  `dispatchReachable()` checks, the same gate #1289's own prompt uses.
- **Orchestration cost risk.** One submitted System task can start several paid autonomous
  workers. Bounds, all of them existing primitives: the lead is a dispatch root, with `maxSubtasks`
  defaulting to the number of other members and an editable `budgetUsd` from which workers' budgets
  are carved. The tree is one level deep (Q14). #1289 allows 4 pending edges per waiter. Every worker
  is visible and cancellable on the lead's `TaskWaitsLine`. Inferred, not traced: whether
  `maxSubtasks` counts cross-project creates. Phase 3 step 0 verifies this, and if it does not,
  the playbook's batch limit plus the budget remain the bound.
- **Repository rules check:** zero-config (no required file, no new env var: the feature is
  inert until the user creates a System, which is the opt-in); contract/route/validator
  invariants (one zod schema per shape, chained family, middleware validation, `/api/v1` only);
  per-repo worktrees and review gate unchanged; BC sections updated in the same PR as each surface.

## 📋 Phasing

- **Phase 1: define Systems.** Store, contract, API family (CRUD), Settings editor including the
  create-from-tag suggestions, project chip, the `/tasks` System facet and CLI read/remove. It ships
  value alone: one place that says which repos form one application, and one task list across
  them, with no engine effect.
- **Phase 2: agents see the System.** `systemContextPrompt` at both session sites, the preview
  route and panel, `contract-candidates` autocomplete, the composer chip, delegation lines when
  #1289 is available, and `cez task projects` enrichment when #1303 is available.
- **Phase 3: orchestration (needs #1289 merged).** The built-in `system-task` workflow, the
  "Start System task" button, the extended `TaskWaitsLine`, and group-by-lead on `/tasks`
  (§ Orchestration).
- **Later (separate specs, not scheduled here).** *Contract impact* (§ Follow-up spec). Export/import
  with remote-URL member matching (Q9). Cross-project mid-run messaging (Q13). #1317's
  Generate-role button, which writes `SystemMember.role`. #1084 multi-repo editing in one session,
  which would reuse Systems as its repo set.

## 📋 Implementation Plan

### Phase 1 — define Systems

1. **Contract.** Add `packages/contract/src/systems.ts` (input, view, list, remove, preview and
   contract-candidates schemas plus bounds constants) and export it. *Test:* schema unit tests for
   every invariant in § Data Model (including no globs and no `..`).
2. **Store.** Add `workspace/systems.ts` and `paths.ts` `systemsFile()`, covering load, salvage,
   merge-write, normalize and scrub. *Tests:* corrupt file → `[]` plus one warning, file
   untouched, then renamed aside on the next write; a deleted file resets (no restore); a member
   whose id was reused by another root reads `unregistered`; paths outside the charset are
   refused; per-entry salvage; `.passthrough()` round-trip of unknown keys;
   `CEZ_HOME` sandbox guard; one-system-per-project 409; dangling member dropped on save rather
   than refused; new unknown member refused. Pin the **empty/absent-file** case explicitly.
3. **Routes.** Add the `systemsRoutes` family (GET, POST, PUT with `expectedUpdatedAt`, DELETE) in
   `server.ts`. *Tests:* `contract-parity.systems.test.ts`, `typed-bodies.test.ts`,
   `bc-route-inventory.test.ts`, a 409 stale-write case, and a 400 matrix.
4. **Project removal scrub.** Add one `unregisterProject()` helper used by `DELETE
   /api/v1/projects/:id` and `cezar projects remove`. *Tests:* both paths scrub; a crash
   simulation between the two writes yields `unregistered` in the view.
5. **CLI.** Add `cezar systems list|show|remove`. *Test:* `projects-cli`-style unit tests, with the
   exit codes added to BC §1.
6. **Cockpit editor.** Add `routes/settings/systems.tsx` and `lib/systems.ts` (validation mirror,
   tag suggestions, relationships list), plus api queries. *Tests:* component states in light and
   dark (empty, suggestions, edit, 409, error).
7. **Visibility.** Add the project-row chip and the `/tasks` System facet/group-by in
   `lib/global-tasks.ts`. *Tests:* table-driven facet and group tests.
8. **Docs and BC.** Update BC §1/§2/§9 (and correct the record: the project-removal route gains
   its first scrub), `docs/reference.md` and the README features list. Add no
   `.env.example` change, because no env var is introduced (say so in the PR body).

### Phase 2 — agents see the System

1. **Renderer.** Add `workspace/system-context.ts` `systemContextPrompt` (a pure function, given
   refs) plus `systemContextPart(projectId)` (snapshot, git ref resolution, `cat-file` checks).
   *Tests:* golden prompts for non-member → `undefined`, only one registered member →
   `undefined`, upstream-only, downstream-only, cycle, missing member skipped, file vs directory
   path commands, quoting of a root with spaces and of a `'` in a ref, fenced free text,
   truncation order at 4 KB, path not on ref, git timeout → map kept with flags dropped, and
   delegation lines on/off. Export `freshestBaseRef` from `git-diff-base.ts` rather than
   reimplementing it.
2. **Wire both session sites.** Change `run.ts` `execute` and `runContinuation`. *Tests:* a member
   project's first step, Continue and recovery each carry the section, and a non-member's prompt
   is byte-identical to before. Prove the Continue test fails when only one site is wired: stash the
   source and see it go red, per AGENTS.md.
3. **Preview.** Add the `GET /api/v1/systems/:systemId/preview` route and the editor panel.
   *Tests:* parity, typed-bodies and BC inventory; component test.
4. **Contract candidates.** Add the `GET /api/v1/systems/contract-candidates` route and the editor
   autocomplete. *Tests:* a fixture repo with each conventional name, directory suggestions, the
   50 cap, and `not-git` → unavailable.
5. **Composer chip.** *Test:* the chip renders only for members.
6. **(After #1289/#1303 merge) Delegation lines and `cez task projects` enrichment.** These are
   target ids, roles and direction, plus the "name your branch when the consumer depends on your
   unmerged change" line (Q6), and never CLI syntax, which #1289's `waitsPrompt` owns. *Tests:*
   gating on `waitsReachable()`/`dispatchReachable()` (on, off, headless `cezar run`); no line
   for a run with `waitedBy` (Q14); no `cez task create` syntax inside the System section; `task-cli.test.ts` ordering and columns.
   Then add an e2e smoke (`npm run test:e2e`, dry run) with two fixture projects in one System,
   asserting that the preview matches the prompt the mock runner receives.

### Phase 3 — orchestration (needs #1289 merged)

0. **Re-verify against merged #1289.** Check every #1289 reference in this spec against the merged
   code: `WAIT_MAX_PENDING`, `waitedBy`, `waitsReachable`/`dispatchReachable`, `recordReport`'s
   dispatch requirement, `TaskWaitsLine`/`CreatedByLine`, the `create`-path budget carving, and
   whether cross-project creates count toward `maxSubtasks`. Amend this spec before code if any
   of them changed. *Output:* a short note in the implementation PR.
1. **Built-in workflow.** Add `SYSTEM_TASK` in `workflows/templates.ts`: one agent node whose
   prompt is the **static** § Orchestration playbook wrapping `{{task}}`. It names no CLI syntax.
   It refers to the tools described in the System and dispatch sections, which `systemContextPart`
   and #1289 gate per session. *Tests:* the catalog lists it as `source: 'built-in'`; a repo file
   named `system-task` overrides it; with waits off, the composed system prompt of a `system-task`
   run contains no `cez task create` line; the name is inventoried in BC §4.
2. **Lead selection.** Add `defaultLead(system)` in `lib/systems.ts` (most provider links, then
   first member) and the "Start System task" button in the System editor and on the `/tasks`
   System facet. It navigates to `/p/<lead>/` with the composer preset to `system-task`,
   `worktree: true` and a `dispatch` intent (`maxSubtasks` = other members, editable `budgetUsd`).
   *Tests:* table-driven `defaultLead`; the submitted body carries the intent and the run gets a
   `dispatch` record (so `cez task report` from the lead is accepted, a test that would fail
   without the preset); the button is disabled with a reason when `taskWaits` is off;
   nothing is submitted by the button itself.
3. **Runs index.** Add `waitedBy?` on `runIndexEntrySchema`, spread conditionally, if #1289 did not
   already add it. *Tests:* `contract-parity` for the index **and** for the dashboard rows
   (`dashboardTaskRowSchema` derives from it); an old payload without it still parses. Record both
   in BC §2.
4. **Extend #1289's `TaskWaitsLine`** so that on a lead it lists settled and created edges as well
   as pending ones, with repo, title, live status (joined to the runs index), branch or PR chip, and
   edge state. `CreatedByLine` is unchanged. *Tests:* component states (pending, settled,
   timed-out, target deleted, worker with no lead).
5. **Group by lead on `/tasks`.** Add it in `lib/global-tasks.ts`. *Tests:* table-driven grouping,
   including a worker whose lead is in another project and a lead whose workers were deleted.
6. **E2E smoke** (`npm run test:e2e`, dry run): three fixture projects in one System, a
   `system-task` lead whose mock agent creates two workers, both settle, the lead wakes twice, and
   the lead's waits line shows both workers settled. The lead's report lists two branches.

## ✅ Acceptance Criteria

**Phase 1**
- With no `systems.json`, every existing test passes unchanged, and the system prompt of a run is
  byte-identical to `main` (golden test).
- A user can create a System from Settings, or from a shared tag in one click. They can add members
  with roles and add links with kind and contract paths, and the result survives a restart and an
  older cezar writing `config.json`.
- Removing a member project, through the API or the CLI, removes it and its links from its System
  in the same operation.
- `/tasks` filters and groups by System.
- The new routes appear in BC §2, the file in BC §9 and the CLI in BC §1. The contract-parity,
  typed-bodies and bc-route-inventory suites are green, and the full validation gate
  (`typecheck`, `test`, `test:unit`, `build`, `test:package`) passes.

**Phase 2**
- A run in a member project, including its Continue and restart-recovered sessions, carries a
  ≤ 4 KB section naming its upstream and downstream projects. Each listed contract path has a
  `git show` (file) or `git ls-tree` (directory) command, or is flagged as not on the ref. No
  `--add-dir` is required on any runner in `runnerSchema` (Claude, Codex, OpenCode, Cursor, Pi,
  Junie, Copilot).
- The editor's preview shows exactly the section the agent receives.
- When #1289's waits and dispatch are reachable for the run, the section names which sibling ids
  to hand cross-repo changes to (without restating the CLI syntax) and asks the agent to name its
  branch when the delegated work depends on its unmerged contract change. When they are not
  reachable, or the run is a worker (`waitedBy`), those lines are absent.
- Every root, ref and path in a rendered command is single-quoted, and a git failure or timeout
  never removes the map or delays a run past the 5 s budget.

**Phase 3**
- From a System, "Start System task" opens the default lead repo's composer with `system-task`
  selected, `worktree: true`, and a dispatch intent with `maxSubtasks` and an editable budget. The
  user can change the lead, and nothing runs until they submit.
- A `system-task` lead plans per repo, changes its own contract first when it provides one,
  creates at most 4 workers at a time with self-contained objectives, waits without holding a
  slot, and finishes with a `cez task report` that is accepted, listing one branch per repo (and a
  PR only where one was opened) and a provider-first merge order.
- Workers never create tasks. The tree is one level deep and bounded by the lead's `maxSubtasks`
  and budget.
- Each worker is an ordinary single-repo task with its own worktree, branch, review gate and PR.
  No task edits another repo's files.
- The lead's `TaskWaitsLine` lists all its workers (pending and settled) with live status, and a
  worker's `CreatedByLine` names its lead.
  `/tasks` can group workers under their lead.
- With `CEZ_TASK_WAITS=0`, or without #1289, the button is disabled with a reason and
  `system-task` runs without delegation steps.

## 📋 Follow-up spec: contract impact (outline only)

This is a separate, independently deployable capability. It depends on this spec's store and not
on the prompt.

- `GET /api/v1/p/:projectId/runs/:id/system-impact`, with the `/api/v1/runs/:id/system-impact`
  alias that `route-parity.test.ts` enforces, answers
  `{impacts: [{systemId, linkId, consumer: {projectId, name}, kind, paths}]}`. It intersects the
  run's changed files (the `server/git-changes.ts` path, anchored by `resolveTaskDiffBase` with the
  run's `branch` and `startedAt`) with the contract paths of links this project provides, and it is
  computed on request, never stored. A reclaimed worktree answers `[]`.
- The review-gate banner reads "This task changed `openapi/api.yaml`, which **web** and
  **mobile** consume." One **Create follow-up in web** button per consumer opens that project's
  composer pre-filled with the objective, the provider's branch and PR, the changed paths read from
  `git show <provider branch>:<path>`, and "merge after <provider PR>". It is user-clicked and never
  auto-created (Q7).
