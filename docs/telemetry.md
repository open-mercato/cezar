# Telemetry

cezar can send usage data and error reports to its maintainers at Open Mercato, so we can see
what breaks and what to build next. **It is opt-in.** Until you say yes, nothing is sent — no
events, no error reports, not even a daily ping — and no install id is created.

## Answering

- **Cockpit** — a bar at the bottom of the main pane asks until you answer; it covers nothing and
  opens no dialog on its own. *Share usage data* and *Don't share* both record your answer;
  *Details* opens the full list of what is and isn't sent.
- **Settings → Privacy** — the same answer as a switch, at any time.
- **Terminal** — `cezar telemetry enable`, `cezar telemetry disable`, `cezar telemetry status`.
  A headless install that nobody answers for sends nothing.

The answer is stored per machine in `~/.cezar/config.json` (`telemetry`). When what we collect
changes, the policy version goes up and cezar asks again; an earlier yes does not carry over.

## What is sent

Every event carries `service`, `version` (release and channel, e.g. `0.15.0-nightly`),
`platform` (`macos`, `linux`, `windows`) and `runtime` (`app` or `cli`), plus an index key:

- `cezarId` — a random UUIDv7 for this installation, created on the first send after you opt in;
- for something done in a browser, `<cezarId>:<sid>`, where `sid` is a random UUIDv7 kept in
  that browser's localStorage (`cezar:sid`).

Events: `cezar_run` (at most once a day), `app_start`, `app_stop`, `task_start` (agent and model),
`page_viewed` (the route's shape, e.g. `/p/:param/tasks/:param/changes`), `message_sent` (where
from), `open_in` (which app), `add_project_opened` (which Add project dialog: `new`, `clone`,
`folder`), `project_added` (`local`, `github`, `cli`, or for a new project `new_local`,
`new_github`, `new_template`), `project_create_failed` (the step that failed, e.g.
`folder_exists`, `github_create` — never the error text), `diff_comment_added`,
`task_archived` / `task_unarchived` / `task_pinned` / `task_unpinned` / `task_deleted` (with the
task's status). Every label comes from a closed set the server enforces.

Error reports carry the error type, message and stack with your home directory, working
directory, temp directory and registered project roots replaced by `~`, `<repo>` and `<tmp>`,
plus technical context: build, uptime, memory, route shape, browser engine, enabled feature flags.
Every red error toast the cockpit shows is reported the same way, with the method, status and
route shape of the API call that failed just before it (e.g. `POST
/api/v1/p/:param/runs/:param/messages`, 409). The toast's text is masked first: quoted values,
emails, URLs, slash-bearing names (paths, branches, `owner/repo`), your project names and
anything after a `: ` become placeholders.

`cezar telemetry inspect` prints the envelope an event would carry, without sending it.

### The desktop shell

The desktop app's native shell reports its own failures — Node.js could not be downloaded,
cezar could not be installed, the cockpit process never answered or exited — under runtime
`app-shell` with the shell's version. It reads the same answer: with a yes, a failure is reported
on its own (code, message, cezar and shell version, architecture, how Node was found) and the
failure page says so. Without one, nothing is sent; the failure page offers a **Send error
report** button instead, which sends that one report — the error and the log the page shows, paths
masked as above, no install id — and only when clicked. `CEZ_TELEMETRY=0` / `DO_NOT_TRACK=1` hide
the button too.

## What is never sent

Prompts, messages, code, file contents or diffs; file paths; repository, branch or project
names; emails, names, tokens, keys or credentials. Your IP address is visible to the receiving
server as with any HTTPS request; cezar does not put it in any payload.

## Where it goes

`https://stats.openmercato.cloud` (override with `CEZ_TELEMETRY_URL`). Sends are fire-and-forget
with a 3 s timeout and never block or break cezar.

## Withdrawing

`cezar telemetry disable` or the switch in Settings → Privacy stops sending immediately — a
running cockpit re-reads the answer before every send — and deletes the install id. If you
later opt in again, you start as a new installation.

## Environment

| Var | Effect |
|---|---|
| `CEZ_TELEMETRY=0` / `DO_NOT_TRACK=1` | Block sending, whatever the stored answer. |
| `CEZ_TELEMETRY=1` | Lift the automatic block under CI, test runners and `CEZ_DRY_RUN=1`. It does **not** grant consent. |
| `CEZ_TELEMETRY_URL` | Send to another endpoint. |
| `CEZ_TELEMETRY_DEBUG=1` | Log each request's status and body to the server console. |
