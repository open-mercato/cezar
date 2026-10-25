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

Events: `cezar_run` (at most once a day), `app_start`, `app_stop` (why: `signal`, `restart`, `supervisor_gone`), `task_start` (agent and model),
`page_viewed` (the route's shape, e.g. `/p/:param/tasks/:param/changes`), `message_sent` (where
from), `open_in` (which app), `add_project_opened` (which Add project dialog: `new`, `clone`,
`folder`), `project_added` (`local`, `github`, `cli`, or for a new project `new_local`,
`new_github`, `new_template`), `project_create_failed` (the step that failed, e.g.
`folder_exists`, `github_create` — never the error text), `diff_comment_added`,
`task_archived` / `task_unarchived` / `task_pinned` / `task_unpinned` (which button: `sidebar`,
`tasks_table`, `all_tasks`, `task_view`, `palette`, `shortcut`; `bulk` for Archive finished, `api` for a non-cockpit
caller), `task_deleted` (with the task's status), `provider_login_opened` / `provider_login_not_opened` / `provider_connected`
(what an agent's **Connect** did — the agent and an outcome such as `unknown`, `no_terminal` or
`already_connected` — and whether the login it opened finished within 15 minutes),
`provider_update_opened` (what an agent's **Update** — offered next to an "X or newer is required"
error — did: the agent and `opened`, `unsupported`, `hosted` or `no_terminal`),
`skills_provisioned` (whether a task's selected skill and its companions were `installed` into
its workspace, were `already_present`, or the selected skill was `root_not_found`; the count
installed — never a skill name), `skill_missing_in_session` (the agent's backend, once per task,
when its Skill tool still answered "Unknown skill"), `session_resume_fallback` (whether the fresh
session that replaced a pruned conversation ended without a session error — `recovered` —, or
`fresh_failed`, or was `cancelled`), `task_failed` (the agent's backend and a kind —
`missing_session`, `usage_limit`, `auth`, `timeout` or `other` — never the error text; once per
transition into failed, not for runs a restart interrupted nor for an auto-resume failing again),
`skills_update_apply_dropped` (a skills update whose request lost its connection, and whether
following the server then found it `recovered`, `not_applied`, `unreachable` or `timed_out`),
`attachments_sent` (how many attachments a sent message carried, as a bucket —
`1`, `2-4`, `5-10`, `11-20` — never their names, types or contents), `attachments_restaged`
(whether the automatic re-upload after an expired staged attachment was `recovered` or
`failed`), and the command palettes' use: `palette_opened` (`command` for ⌘K, `task` or
`task_switch` for ⌘P), `task_command_run` and `task_shortcut_used` (which task command ran — from
a ⌘P row or from its keyboard shortcut — as a fixed command name such as `pin`, `git:push` or
`view:changes`; saved layouts, Open-in targets and ⌘1–⌘9 are folded into `layout`, `open` and
`tab`; counted in the tab and sent at most once a minute with how many times), `task_switched`
(`enter`, `cycle`, `tab`, `cmdk`, `cmdk_tab`), `palette_mode_used` (`tasks`, `commands`, `files`,
`pr_number`, `automation` — the shape of a search, never its text; a bare prefix such as the `@`
⌘P pre-fills is not counted), `palette_dismissed` (the view a
palette was closed from with nothing chosen), `shortcut_rebound` (which command's shortcut was
changed; a reset is not counted), `schedule_menu_opened` (the start-time menu beside the new-task
Send button was opened), `start_option_picked` (`now`, `at`, `usage_reset`) and `task_scheduled`
(`at`, `usage_reset` — a task was scheduled; never the time itself). Pins and archives also say `palette` or `shortcut` when they came from there. Every label
comes from a closed set the server enforces.

Which features are used, never what they are named: `task_origin` (where a task came from —
`cockpit`, `cli`, `api`, `inbox`, `e2e_setup`, `scheduled_task`, `automation_schedule`,
`automation_github`, `automation_tracker`, `dispatch_implement`, `dispatch_review`),
`workflow_used` (a built-in workflow by name — `quick-task`, `implement-and-verify`, … — or
`custom`, `custom_graph`, `planned`, `dispatch`, `other_builtin`; your own workflow's name is never
sent), `skill_used` (once per session per skill: a public skill by name — Open Mercato's `om-*`
skills and cezar's own `create-cezar-automation` — any other only as `repo`, `global` or `team`),
`variants_started` (`2` or `3`), `dispatch_tree_started` (`toggle` from the composer, `agent` when
a task first dispatches on its own), `automation_created` / `automation_deleted` /
`automation_fired` (what the automation listens to — e.g. `github:pull_request.opened`,
`github:multi`, `schedule:daily`, `tracker:jira` — and for a firing how many tasks it started;
never its name, prompt or filters), `automation_toggled` (`enabled`, `paused`), `workflow_saved`
(`chain_created`, `chain_updated`, `graph_created`, `graph_updated`, `deleted`), `pr_opened`
(`draft`, `ready`, or `agent` when the task's agent opened it), `review_decided` (`accepted`,
`landed`), `design_mode_enabled` (`button`, `shortcut`), and once a day with `cezar_run`,
`feature_inventory`: how many projects, enabled and paused automations, custom workflows, repo
and global skills, projects with their own skills repos, and tracker connections this machine has
— counts only, and only those above zero.

Error reports carry the error type, message and stack with your home directory, working
directory, temp directory and registered project roots replaced by `~`, `<repo>` and `<tmp>`,
plus technical context: build, uptime, memory, route shape, browser engine, enabled feature flags.
Every red error toast the cockpit shows is reported the same way — except an expected outcome the
toast already tells you how to resolve (a file over the attachment limit, git refusing a pull or
push, an agent CLI that is not installed), which is shown and not reported — with the method, status and
route shape of the API call that failed just before it (e.g. `POST
/api/v1/p/:param/runs/:param/messages`, 409). The toast's text is masked first: quoted values,
emails, URLs, slash-bearing names (paths, branches, `owner/repo`), your project names and
anything after a `: ` become placeholders. For a provider or agent-account call the report also
names the agent (`claude`, `codex`, …). When the call got no answer at all, the report names the
browser's own transport error (e.g. `TypeError: Load failed`), masked the same way.

Every error an agent shows in a task's thread is reported the same way, as an `AgentError` named
by the agent (`opencode: OpenCode 1.18.0 or newer is required to use the free tier`), with whether
it ended the session and whether it asks for a newer CLI. The text is masked first: quoted values,
emails, URLs and slash-bearing names (paths, branches, `owner/repo`) become placeholders, and
times, dates and delays become `<time>` / `<n>`. A provider usage limit whose reset cezar can read
is not reported — auto-resume handles it; one it cannot read is, under the code `usage_limit_unparsed`.

When cezar cannot read whether an agent's CLI is signed in, it reports why (timed out, could not
start, unexpected exit, unrecognised output) with the shape of the answer only: exit code, Node's
error code, output sizes, whether it was JSON, how the binary was found (an override, an absolute
location or `PATH`, and its extension) and the CLI's `--version`. Never its output.

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
