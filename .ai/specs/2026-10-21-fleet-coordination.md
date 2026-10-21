# Fleet coordination — several cezar instances share one job queue

Status: implemented (2026-10-21). Code: `packages/cezar/src/fleet/`; wire shapes:
`packages/contract/src/fleet.ts`; operator guide: `docs/fleet.md`.

## Problem

One cezar runs `maxParallel` tasks on one machine. Teams on Kubernetes or several VMs want to run
many instances and hand work to "the fleet" without choosing a machine.

## Zero config

Off by default. With no `CEZ_FLEET_*` variable set, nothing in `src/fleet` runs, no port opens and
no file is written. A bad fleet config logs one warning and cezar boots as a plain single instance.
The cockpit API stays on `127.0.0.1` without auth, exactly as before: fleet traffic uses its own
listener.

## Roles

| Role | Selected by | Does |
| --- | --- | --- |
| hub | `CEZ_FLEET_HUB=1` | owns the job queue, serves the fleet listener, and is also a node |
| worker | `CEZ_FLEET_HUB_URL=<hub>` | heartbeats to the hub and runs what it is handed |

Both need `CEZ_FLEET_TOKEN` (>= 32 chars). `CEZ_FLEET_NODE_ID` defaults to the hostname. The hub
listens on `CEZ_FLEET_BIND` (default `0.0.0.0`) : `CEZ_FLEET_PORT` (default 4330).

## Protocol (HTTP + JSON, `Authorization: Bearer <token>`)

Only `/api/v1/fleet/*` exists on the fleet listener; every other path is a 404.

- `POST /heartbeat` — node -> hub every 5 s: `{ nodeId, version, capacity: {free, max}, host, jobs: [report] }`.
  Reply: `{ assigned: Job[], cancel: id[], drop: id[] }`.
- `POST /jobs` — submit `{ repoUrl, task, baseBranch?, workflowId?, runner?, model?, openPr? }`.
- `GET /status` — nodes + jobs. `POST /jobs/:id/cancel`.

Pull, not push: workers dial the hub, so a worker needs no inbound port and works behind NAT.

## Scheduling

- A node reports its own effective free capacity (`maxParallel - busy`, minus jobs still being set
  up). Dynamic or autoscaled local limits therefore become fleet-wide distribution with no hub
  knowledge.
- Pending jobs are planned FIFO, each to the live node (heartbeat within 30 s) with the most free
  capacity left; ties by node id. A node is handed only its own share, up to its free capacity.
- An assignment not yet acknowledged (the node has not reported the job) is re-sent on every
  heartbeat until it is, so a lost response loses nothing.

## Leases

- A held job (`assigned|running|review`) carries `leaseExpiresAt = last report + 60 s`; each report
  renews it. An unacknowledged assignment is not renewed.
- Expiry sends the job back to `pending` with `attempts + 1` and clears node/run; the third lost
  attempt marks it `failed`.
- Reports are idempotent. A node re-reporting a job it does not own (requeued, taken over, unknown,
  already finished) is told to `drop` it and stops the local run. A job the hub cancelled answers
  `cancel` to its holder.
- A hub restart reloads `jobs.json` and gives every held job a fresh lease so nodes can re-report
  before anything is requeued.

## Worker execution

1. Resolve `repoUrl` to a registered project by normalized remote (`host/owner/repo`, lowercase;
   `owner/repo` means github.com). None: clone into the workspace projects dir (`checkoutRepo`,
   `gh`) and register it.
2. `RunManager.startRun` with workflow `workflowId` (default `quick-task`), `autonomous: true` so it
   never parks on a user, and the recorded fork point `origin/<baseBranch>` when given.
3. Poll the run: `queued|running|waiting` -> `running`; `done|review` -> publish; `failed|cancelled`
   -> `failed`.
4. Publish (when `openPr`): `createDraftPr` (push + `gh pr create --draft`) so the result outlives
   an ephemeral pod. "Nothing to propose" finishes the job without a PR. Reports `branch`, `prUrl`.

## Hygiene

- Runtime limit: `CEZ_FLEET_JOB_TIMEOUT_MINUTES` (default 240) fails the job and cancels the run.
- A cancel or drop that arrives while the node is still cloning cancels the run as soon as it exists.
- Runs carry `fleetJobId`; a restarted node cancels recovered fleet runs (their jobs were requeued).
- Queued-but-unstarted fleet runs count as used capacity. Capacity is read from `freeCapacity().main`
  / `effectiveLimits().main` when the semaphore has per-pool limits, else `maxParallel - busy`.
- Agents, check steps and cockpit terminals never see `CEZ_FLEET_TOKEN`; the agent env allowlist
  drops every `CEZ_*_TOKEN` / `CEZ_*_SECRET`.

## State

Hub: `cezarHomeDir()/fleet/jobs.json` (atomic tmp+rename, `0600`, zod-validated per entry; corrupt
-> empty queue with one warning; last 500 finished jobs kept). The nodes table is in memory and
rebuilt from heartbeats. Workers hold no fleet state: a restarted worker's jobs expire and requeue.

## Security

- Token: shared secret, compared with `crypto.timingSafeEqual` over SHA-256 digests (length leaks
  nothing). A token shorter than 32 chars disables the role; the auth middleware fails closed.
- The fleet listener is plain HTTP: put TLS in front (ingress / reverse proxy) or keep it on a
  private network. Anyone with the token can queue work that agents execute on every node — treat it
  like an SSH key.
- Jobs carry a repo URL and a prompt, never credentials. Agent CLI and `gh` credentials come from
  each node's own environment.

## Non-goals

No shared filesystem, no hub HA (single hub, restart-safe through `jobs.json`), no per-job
priorities or node affinity, no cockpit panel yet (use `cezar fleet status`), no mid-run migration
of a running job between nodes.
