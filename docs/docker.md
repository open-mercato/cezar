# cezar in a container

One image holds cezar and what a project needs to be built in it — git, a compiler toolchain,
Node, Python, the coding-agent CLI, and a Docker daemon of its own for the project's services.
Your machine needs Docker and a browser. Nothing else is installed on it, and it behaves the
same on Windows, macOS, Linux and a VPS.

```bash
docker compose -f docker/compose.yml up -d --build
```

Then open <http://localhost:4321>.

> **Status: untested.** The image and compose file were written against cezar's hosted mode and
> the preview gateway, both of which are tested — but the image itself has not been built or run
> yet. Expect the first build to need a fix or two, and treat everything below as the intended
> behaviour until this note is removed.

## First run

**Log the agent in.** Either pass a credential through the environment — put it in a `.env`
file beside `docker/compose.yml`:

```bash
ANTHROPIC_API_KEY=sk-ant-...        # or CLAUDE_CODE_OAUTH_TOKEN=...
GITHUB_TOKEN=ghp_...                # optional: issues, PRs, draft PRs
```

or log in once from inside the container; the login is kept in the `data` volume:

```bash
docker compose -f docker/compose.yml exec -u node cezar claude
```

```bash
docker compose -f docker/compose.yml exec -u node cezar gh auth login
```

**Add a project.** In the cockpit, clone a repository — it lands in `/projects`, a volume. The
cockpit is the editor, the terminal and the browser for it; there is no folder on your machine
to open in something else, by design.

**Give it its secrets.** Create the project's `.env` files in the Code view or the terminal, in
the project's main checkout. Every task worktree gets a copy of the gitignored ones
automatically (see [reference → env files](reference.md)).

## What works the way it does locally

| | In the container |
| --- | --- |
| Tasks, worktrees, review, draft PRs | Unchanged. |
| Terminal in a task | On. The shell is inside the container, in the task's worktree, as user `node`. |
| Editing files in the Code view | On. |
| A project's services (`docker compose up` for its Postgres, Redis…) | Run on the container's **own** Docker daemon, so `localhost:5432` means to the app what it means on a developer's machine. |
| Previewing a task's app in the Browser column | Through the [preview gateway](server-install/ubuntu-vps.md#previewing-a-tasks-app-the-preview-gateway): type `localhost:3000`, and it is framed from `localhost:85xx`. Up to twenty apps at once. |
| Running the same app in several tasks | Each task has `CEZ_TASK_SLOT` and `CEZ_TASK_PORT_BASE` ([reference](reference.md#running-the-same-app-in-several-tasks-at-once-the-task-slot)). |
| Design Mode | Not available — it needs a cockpit on the same machine as the app. |
| "Open in editor / terminal / file manager" | Not available — there is no host machine to open them on. |

## What is where

| Volume | Holds | Lose it and… |
| --- | --- | --- |
| `data` → `/data` | cezar's registry and task history, the agents' logins, `gh` login, git identity, SSH keys | you log in again and re-add projects |
| `projects` → `/projects` | the repositories and their task worktrees | you clone again; anything not pushed is gone |
| `docker` → `/var/lib/docker` | images and data of the projects' own services | they are pulled and seeded again |

Upgrading is a rebuild: `docker compose -f docker/compose.yml up -d --build`. The volumes stay.

## Security, plainly

- The cockpit and the preview ports are published on **`127.0.0.1` only**. cezar has no login of
  its own and this container hands out a shell — do not change those addresses to `0.0.0.0`.
  On a server, keep them on loopback and put an authenticated front in front
  ([Remote access](reference.md#remote-access-host-cezar-on-a-server)).
- The container is **`privileged`**, for its inner Docker daemon. An agent's commands run as the
  unprivileged user `node`, but that user can use the inner daemon, and a privileged container
  is not a security boundary against the code running in it. Treat it as you would treat running
  the agent on your own machine: it is isolation from accident, not from intent.
- To run without the inner daemon, remove `privileged: true` and set `CEZ_DOCKER=0`. cezar runs;
  projects that need their own services will not start them.

## Limits

- An app that calls its own backend by an absolute address (`http://localhost:9000` baked into
  a frontend bundle) makes that call from your browser, where port 9000 is not published. Open
  the backend in a second Browser tab to learn its gateway address and point the app at it.
- The image ships Node 22. A project that pins another version can switch with `n auto` (reads
  `.nvmrc`) from the terminal, as root: `docker compose exec cezar n 20`.
- Only the Claude Code CLI is preinstalled. Other agent CLIs can be installed with
  `docker compose exec cezar npm i -g …`; they are gone after a rebuild.
