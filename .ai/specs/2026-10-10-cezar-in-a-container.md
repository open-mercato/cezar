# cezar in a container — a project built with Docker and nothing else

> Status: written (2026-10-10), NOT yet built or run — see "Verification" at the end.
> Implementation: `docker/Dockerfile`, `docker/entrypoint.sh`, `docker/compose.yml`,
> `.dockerignore`; user guide `docs/docker.md`.
> Builds on: `2026-10-10-preview-gateway.md` (how the Browser column reaches an app inside the
> container), `2026-10-10-task-slots.md`, `2026-10-10-worktree-env-seeding.md`.

## 1. Problem

cezar is zero-config; the projects built in it are not. A real one wants a particular Node, a
package manager at a pinned version, `make`, Python, a shell its scripts were written for, and a
set of services in Docker. On a machine that lacks any of those the cockpit opens and the
project does not run — WRAP-CREATORS on a Windows host is the worked example: its Makefiles say
`SHELL := /bin/bash` and call `python3`, and neither exists there.

The goal this serves: a project is built from cezar alone. That needs the project's toolchain
to be somewhere cezar can reach it without the user installing it.

## 2. Decision: cezar runs in the container, not the project

Two shapes were possible.

**A container per project** (a dev container cezar starts terminals and agents in). It keeps
cezar on the host — and so keeps the host's shell, the host's agent CLI and the host's paths in
play. The agent would have to run inside the container too, or it could not run the tests it
writes; then its login, its config and cezar's own state files all have to cross the boundary.
Every seam cezar has (worktrees, terminals, the agent runners, autosave) would grow a second
mode.

**cezar itself in a container that also holds a toolchain.** Nothing in cezar changes: it
already knows how to run when it is not on the viewer's machine (hosted mode), and the two
things hosted mode lacked — a preview and per-task ports — are the two specs this builds on.
The same image is the VPS deployment.

The second is built. It adds no code path to the service; it is packaging.

## 3. The image

- **Built from source**, in a build stage that produces the same tarball `npm publish` ships,
  installed globally in the runtime stage. The desktop shell is not a workspace and is not built.
- **Toolchain:** Debian bookworm, Node 22, `corepack` (yarn/pnpm at a project's pinned
  version), `n` (a project's pinned Node), git, `gh`, make, a C toolchain, Python 3, and the
  Claude Code CLI.
- **A Docker daemon inside** (`docker-ce`, started by the entrypoint). See §4.
- **Runs as `node`**, not root. The entrypoint is root for two things — owning the volumes and
  starting the daemon — and `exec`s everything else as `node`.
- **State under `/data`:** `CEZ_HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GH_CONFIG_DIR`,
  `GIT_CONFIG_GLOBAL` and `~/.ssh` all point there, so one volume holds everything a rebuild
  must not lose. Repositories live in `/projects` (`CEZ_PROJECTS_DIR`), a second volume.

## 4. Why the Docker daemon is inside

A project's `docker-compose.yml` publishes `5432:5432` and its `.env` says
`DATABASE_URL=…@localhost:5432`. Two ways to give the container Docker:

- **The host's socket, mounted in.** The services then run beside the cezar container, not in
  it. `localhost:5432` inside cezar is not the database, and a bind mount in the compose file
  names a path the host daemon cannot see. Every project would need its env rewritten.
- **A daemon in the container.** Services share the container's network namespace: `localhost`
  means what the project's env says it means, and paths are the container's own.

The second is the only one where "works like it does locally" holds, and it is what a dev
container's docker-in-docker does. Its cost is `privileged: true`, stated in `docs/docker.md`
without softening: a privileged container is not a boundary against the code running in it.
`CEZ_DOCKER=0` and no `privileged` gives a cezar without project services.

## 5. How the cockpit reaches things

- `cezar serve --bind-host 0.0.0.0` inside; compose publishes `127.0.0.1:4321`. Binding a
  non-loopback address makes cezar a hosted cockpit, which is correct — the viewer's browser is
  not in the container.
- Hosted mode withholds the terminal and file editing because a hosted cockpit is normally on
  the network. Here it is published on the host's loopback only, so the image sets
  `CEZ_TERMINAL=1` and `CEZ_FILE_EDIT=1`. The compose file says, at the port mapping, that
  widening the address withdraws that justification.
- A task's app is framed through the preview gateway: `CEZ_PREVIEW_PORTS=8500-8519`, published
  on the host's loopback at the same numbers.

## 6. Not done here

- **Design Mode** in the container — it requires a cockpit on the app's own machine.
- **Other agent CLIs** in the image. They install with npm at runtime and do not survive a rebuild.
- **A published image.** It is built locally from the checkout; a registry is a release decision.
- **The installer.** `server-install` does not know this shape; on a VPS the compose file sits
  behind whatever authenticated front the operator already runs.

## 7. Verification

Recorded honestly, because this spec's claims are only as good as what was run:

- The preview gateway, task slots and env seeding the image relies on are covered by the suite,
  and the gateway was exercised live in a browser against a hosted-mode cezar (2026-10-10).
- **The image has NOT been built or run.** On the authoring machine Docker Desktop's engine did
  not start, so `docker build` never ran. What was checked without a daemon: the entrypoint
  parses (`sh -n`), `docker compose config` accepts the compose file, and the build stage's
  steps (`npm ci`, the two builds, `npm pack`) are the ones the repo's own `npm run build`
  gate runs. The runtime stage — the apt sources, the inner daemon starting, cezar running as
  `node`, a preview through the published pool — is unproven until someone runs
  `docker compose -f docker/compose.yml up --build` and opens a task's app in the Browser column.
  Change this section when that has been done.
