# Fleet — run several cezar instances as one

A fleet lets you hand tasks to "the fleet" instead of one machine. One instance is the **hub** (it
owns the job queue); the others are **workers** that dial the hub, say how much free capacity they
have, and run what they are given. Each job runs in its own git worktree on the node that took it
and, when it finishes, that node pushes the branch and opens a **draft PR** — so the result
survives an ephemeral pod. You stay the merge button.

Fleet mode is **opt-in and off by default**. With no `CEZ_FLEET_*` variable set nothing here runs:
no extra port, no extra file. Design: `.ai/specs/2026-10-21-fleet-coordination.md`.

## How it works

- Workers **pull**: every ~5 s a node POSTs `heartbeat` (its free capacity, host load, the jobs it
  holds) to the hub and gets back newly assigned jobs and cancellations. Workers need no inbound
  port.
- A node reports its **own** effective capacity (`maxParallel` minus busy), so whatever limits you
  set locally — including dynamic or autoscaled ones — decide how much work that node receives.
  Jobs go FIFO to the node with the most free capacity.
- A job is held under a **60 s lease** renewed by each heartbeat. A node that goes silent loses its
  jobs: they return to the queue (3 lost attempts, then `failed`). A node that comes back and
  reports a job it no longer owns is told to drop it.
- Jobs run **autonomously** (they never park waiting for a person) with the default `quick-task`
  workflow unless you name another.
- The hub is a node too, and keeps its queue in `$CEZ_HOME/fleet/jobs.json`, so a hub restart
  loses nothing it had saved.

## Try it locally (two instances)

```bash
export CEZ_FLEET_TOKEN=$(openssl rand -hex 32)          # >= 32 characters

# terminal 1 — the hub (cockpit :4321, fleet listener :4330)
cd ~/code/my-repo
CEZ_HOME=/tmp/hub CEZ_FLEET_HUB=1 CEZ_FLEET_NODE_ID=hub cezar serve --no-open

# terminal 2 — a worker (add CEZ_DRY_RUN=1 to try it without real agents)
cd ~/code/my-repo-clone
CEZ_HOME=/tmp/w1 CEZ_FLEET_HUB_URL=http://127.0.0.1:4330 CEZ_FLEET_NODE_ID=w1 cezar serve --no-open -p 4322

# terminal 3 — submit and watch
export CEZ_FLEET_HUB_URL=http://127.0.0.1:4330
cezar fleet submit "add a --version flag" --repo your-org/my-repo
cezar fleet status            # nodes, free capacity, jobs, branch / PR url
cezar fleet cancel <jobId>
```

`cezar fleet submit` options: `--repo <url>` (default: this directory's remote), `--base <branch>`,
`--workflow <name>`, `--runner <id>`, `--model <model>`, `--no-pr`. `status --json` prints the raw
nodes + jobs.

A node maps a job's repo to a project by **normalized remote URL** (`https://`, `ssh`, `git@` and
`owner/repo` spellings all match). If it has none registered it clones the repo with `gh` into
`CEZ_PROJECTS_DIR` (default `~/cezar/projects`) and registers it. Clone-by-URL is GitHub-only; for
other forges pre-register the project on each node (`cezar projects add <dir>`).

## Kubernetes

Manifests live in [`deploy/kubernetes/`](../deploy/kubernetes): a hub Deployment (one replica) +
Service on the fleet port + PVC, and a worker StatefulSet (replicas N, a PVC per pod,
`CEZ_FLEET_HUB_URL=http://cezar-hub:4330`).

1. **Image.** No official image is published; `deploy/kubernetes/Dockerfile` is an *example*
   (node:22-slim + git + gh + `@open-mercato/cezar` + the Claude Code / Codex CLIs). Build and push
   it, then set `image:` in `hub.yaml` and `workers.yaml`.
2. **Secrets.**
   ```bash
   kubectl create secret generic cezar-fleet --from-literal=token="$(openssl rand -hex 32)"
   kubectl create secret generic cezar-agent-credentials \
     --from-literal=GH_TOKEN=<clone/push/PR token> \
     --from-literal=ANTHROPIC_API_KEY=<key>      # claude runner; OPENAI_API_KEY for codex
   ```
   Pods cannot do the interactive browser login the CLIs normally use, so give each agent CLI an
   API key (or mount its credentials) and `gh` a `GH_TOKEN` (the image runs `gh auth setup-git` so
   `git push` works). Jobs never carry credentials; every node uses its own.
3. **Apply and submit.**
   ```bash
   kubectl apply -k deploy/kubernetes
   kubectl scale statefulset cezar-worker --replicas=6          # more nodes, more throughput
   kubectl exec deploy/cezar-hub -- cezar fleet submit "fix the flaky test" --repo your-org/app
   ```
   Inside the hub pod `CEZ_FLEET_HUB=1` and the token are already set, so `cezar fleet` reaches the
   local listener without further config. From elsewhere in the cluster set `CEZ_FLEET_HUB_URL` and
   `CEZ_FLEET_TOKEN`.

Resources: size a worker for `maxParallel` concurrent agents (default 2). The example requests 2
CPU / 4 GiB and limits 4 CPU / 8 GiB; raise them if your builds and test suites are heavy. The
cockpit inside each pod binds loopback only and is not exposed.

## Several VMs

On each VM install cezar (`npm i -g @open-mercato/cezar`, or `cezar install`), the agent CLIs and
`gh auth login`, then run a systemd unit:

```ini
# /etc/systemd/system/cezar-fleet.service  (workers; the hub sets CEZ_FLEET_HUB=1 instead of _HUB_URL)
[Unit]
Description=cezar fleet node
After=network-online.target

[Service]
User=cezar
WorkingDirectory=/srv/cezar/boot
Environment=CEZ_FLEET_HUB_URL=http://hub.internal:4330
Environment=CEZ_FLEET_NODE_ID=%H
EnvironmentFile=/etc/cezar/fleet.env     # CEZ_FLEET_TOKEN=..., ANTHROPIC_API_KEY=..., GH_TOKEN=...
ExecStart=/usr/bin/cezar serve --no-open --repo /srv/cezar/boot
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Keep `fleet.env` mode `0600`. `cezar server-install` (the VPS wizard) puts an authenticated
reverse proxy in front of the *cockpit*; that is a different surface and is not needed for fleet
nodes, which only need to reach the hub's fleet port.

## Security

- The token (`CEZ_FLEET_TOKEN`, >= 32 characters, compared in constant time) is the only
  credential. Whoever has it can queue prompts that agents execute on **every** node. Store it in a
  Secret / `0600` file, rotate by restarting all nodes with the new value.
- The fleet listener serves **only** `/api/v1/fleet/*`; anything else is a 404. The cockpit API is
  untouched: it still binds `127.0.0.1` and has no auth, and is never exposed by fleet mode.
- The listener is plain HTTP. Terminate TLS in front of the hub (Ingress, reverse proxy) or keep it
  on a private network / VPN; use an `https://` `CEZ_FLEET_HUB_URL` when you do. Restrict who can
  reach the port (NetworkPolicy, security group) in addition to the token.
- An invalid fleet config (missing/short token, hub and worker both set) disables fleet mode with a
  warning; cezar still boots as a normal single instance.

## Limits

- Single hub, no HA. The queue is restart-safe through `jobs.json`; running jobs are kept if nodes
  re-report within a lease.
- A restarted worker forgets which jobs it held; its leases expire and the jobs are requeued (the
  old local run may linger on that node until you cancel it).
- No shared filesystem and no node affinity or priorities. No cockpit panel yet — use
  `cezar fleet status`.
