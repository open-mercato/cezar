# Task slots — one number per task worktree

> Status: implemented (2026-10-10).
> Implementation: `packages/cezar/src/task-slot.ts`; read by `RunManager.slotEnv`
> (`workflows/run.ts`) and the terminal route (`server/server.ts`).
> Related: `2026-10-10-worktree-env-seeding.md` (the other half of a runnable worktree),
> `2026-10-07-task-workspace.md` §7, which records "per-task port allocation" as not built.

## 1. Problem

A task's worktree isolates its files. It does not isolate its ports: two tasks that both run
the project's dev command both ask for :3000. The second fails to start — or starts on a port
nobody was told about while the first task's Browser column goes on framing :3000, which is
now showing a different task's work. The same is true of a database both of them migrate.

cezar cannot fix this by renumbering. Which process listens where is decided inside the
project — a framework default, a `docker-compose.yml`, six services reading six variables —
and there is no variable that means "your port" to all of them. (`PORT` is the nearest thing,
and setting it would give every service in a multi-service project the same one.)

## 2. Behaviour

cezar gives every task worktree a **slot**: an integer from 1 to 99 that no other task
worktree on the machine holds. It tells every process it starts for that task:

| Variable | Value |
| --- | --- |
| `CEZ_TASK_SLOT` | The slot, e.g. `3`. |
| `CEZ_TASK_PORT_BASE` | `20000 + slot × 100` — the first of a hundred ports that slot may use. |

The three places cezar starts a process on a task's behalf all read the same slot:
the agent (`agentEnv`), a workflow's `command:` steps, and the workspace terminal.

The project derives what it needs: `PORT=${CEZ_TASK_PORT_BASE:-3000}`, a database named
`app_$CEZ_TASK_SLOT`. A project that ignores the variables behaves exactly as before.

A task that runs in the repo itself (worktree off) has no slot. It is the shared stack — the
project's ordinary ports — and the variables are **present and empty** there, so a slot this
cezar happened to inherit (a cezar started from a task's terminal) cannot reach it.

## 3. Mechanism

- **Leases are files**: `~/.cezar/task-slots/<n>.json`, holding the run id and the worktree
  path, created with an exclusive open. The number must be unique across every project and
  every cezar process on the host, and a run store belongs to one project — so it does not
  live on the run record, and the HTTP contract is unchanged.
- **Nothing releases a slot.** A worktree can end by delete, archive, retention or a crash, and
  a release hook on each is a list that will miss one. A lease whose worktree directory no
  longer exists is free; that is checked on every lookup. It is the one signal that is true on
  every path.
- **A lease that cannot be read stays taken.** It may be another process mid-write, and handing
  one number to two tasks is the single failure this exists to prevent.
- **Degradation.** A home that cannot be written, or all 99 slots held, yields no slot: the
  variables are empty and the task runs as it would have before.

## 4. Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Set `PORT` too? | No. | One value read by every service in a project makes them collide with each other. |
| Reserve the ports? | No. | A block is a convention, not a bind; nothing stops another program using it. The base sits above the usual dev ports and below the ephemeral range (Linux 32768, Windows 49152). |
| Why 99 | Two digits keep a derived port a readable offset and a derived database name short. A host running a hundred task apps at once has other limits first. |
| A flag to turn it off? | No. | It sets two variables nobody else reads, starts nothing and opens nothing. |
| Shown in the cockpit? | Not yet. | The terminal already answers `echo $CEZ_TASK_SLOT`; a visible slot belongs with the preview work that will use it. |

## 5. What this does not do

Start anything, allocate a database, or rewrite an env file. A project that keeps its ports in
a copied `.env` still has to derive them from the slot at start-up — the copy carries the main
checkout's values (spec `2026-10-10-worktree-env-seeding.md` §3).
