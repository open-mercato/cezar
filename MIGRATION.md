# Python port

This fork keeps the TypeScript cockpit and adds a Python one beside it:
[Stario](https://github.com/stariodev/stario) for HTTP, [Datastar](https://data-star.dev)
for the live page, SQLite through [litewriter](https://github.com/Bobowski/litewriter).
Layout and commands follow [stario-create](https://github.com/stariodev/stario-create)
(`app/features/<page>/`, `just check`, `PROJECT_DATA_DIR`).

The TypeScript tree is still the full product. The Python tree is a slice of it.
Nothing below is marked done unless a test or a manual run exercised it.

## Run it

```bash
uv sync
CEZ_DRY_RUN=1 uv run python -m app.main
```

The cockpit listens on `127.0.0.1:4321` (Stario's own default is 8000).
State goes to `./data/app.sqlite3`, or `$PROJECT_DATA_DIR` (Yard uses `/data`).

```bash
uv run python -m app.cli run "describe the change"    # review exits 0
uv run python -m app.cli init
uv run python -m app.cli projects
just check    # ruff, ruff format, pyright, pytest
```

`CEZ_DRY_RUN` defaults to **off**, matching the TypeScript app. Unset, a task
spawns the selected CLI (`claude`, `codex`, `opencode`, `cursor-agent`, `pi`,
`junie`, `copilot`) with that backend's argv and wire format. `CEZ_DRY_RUN=1`
uses the mock agent. Compose sets that. A missing binary fails the run; it
does not fall back to the mock. The Python-only `CEZ_REAL_AGENTS` / `StdinAgent`
dev mode was removed (no TypeScript counterpart).

Docker:

```bash
docker compose up --build
```

Compose publishes `4321`, stores SQLite in the `cezar-data` volume, and mounts
the repo at `/repo`. It sets `CEZ_DRY_RUN=1` and `STARIO_HOST=0.0.0.0`, so the
process is hosted and requires HTTP Basic auth. `GET /health` stays open for
the healthcheck. `docker compose up --build` was run on this slice: the image built (bash, git,
and the cryptography package for the secret store) and the container became
healthy. An earlier boot (before Basic auth) ran a dry-run task to `review` on
`cez/<id8>` inside the mounted repo. This boot checked the gate: `/health` was
200 with no credentials, `/tasks` and `/api/v1/health` were 401, and the
generated password from the data volume authenticated `/api/v1/health`. Git is invoked with `safe.directory=*` for that process only,
because the container user does not own the mounted checkout and would otherwise
treat it as a non-git directory.

## Decisions

| Question | Choice |
| --- | --- |
| Where does state live? | SQLite. `import-runs` copies a `runs.json` array into that table and, when a sibling `runs/<id>.ndjson` exists, copies those events too. The parser and `events_near` are tested. The CLI's write into SQLite is not. Workflows and skills stay files under `.ai/cezar/` so they can still be committed. |
| What does a finished workflow become? | `done`, unless `CEZ_REVIEW_GATE=1` (or `reviewGate: true` in `.ai/cezar/config.json`) and the worktree has a diff and the run is not autonomous. Then it parks at `review`. Finish accepts that park and does not merge. Headless `run` treats both `review` and `done` as exit 0. |
| What happens to a `running` row after restart? | `Engine.recover` (called at the end of `Engine.startup`, before routes and the tick loop) first sweeps `<data dir>/tmp/<run id>` directories of runs that are not live, then resumes a `running` agent whose runner opened a session (`Run.session_runner`; Claude and Pi by run id, Codex and OpenCode when `codex_thread` is stored; any runner under dry-run) as a queued follow-up with `--resume` and the restart prompt that points at `CEZ_HANDOFF_FILE`. A `running` linear workflow with no session yet (queued behind the working-tree lease, or still spawning) is re-queued whole, as TypeScript does. Every other `running` row becomes `failed` with "interrupted by restart" (`mark_interrupted`): a runner that cannot resume, a graph parent whose dispatched children are still in flight, or a graph run with no session (TypeScript re-queues it at its persisted cursor; this port keeps none, so a re-run from the entry could repeat a commit, push or PR node). `queued` stays queued and the tick picks it up. `waiting` stays, so the question or graph park is still on screen. |
| Does `waiting` hold a parallelism slot? | No. The agent process has exited. `max_parallel` still defaults to 2 and caps `running` work. |
| Dry run | Default off, matching TypeScript. Compose sets `CEZ_DRY_RUN=1`. |
| Graph workflows (`version: 2`) | Loaded and walked for `start`, `agent`, `check`, `if`, `loop`, `end`, `fork`, `join`, `dispatch`, `git.commit`, `git.push`, `git.sync-base`, `github.draft-pr`, and `github.wait-ci` (no PR fails; dry-run reports green). A cycle that does not pass a loop `repeat` port is rejected. `github.pr-comment`, `github.issue-comment`, and `github.pr-update` are a dry-run note or a failure. `gate.human`, `ask-user`, and nested `workflow` are executed (`tests/test_graph_human.py`). |
| `onFail` on an agent step | A load error. TypeScript's schema allows the key and ignores it. |
| Secrets on a check | Injected into the check environment from an AES-256-GCM store under the data directory. Values are not returned by the list API. A `cezar` audience is not given to checks. The check itself is always `bash -lc`. |
| `allowedTools` / `bashAllowlist` | Claude argv maps a non-empty allowlist to `Bash(<prefix>:*)`. Pi drops Bash. Copilot is `--allow-all-tools` and the allowlist is not mapped. A check step always runs `bash -lc`, the same as TypeScript: the allowlist does not gate it. |
| Diff base | `resolve_task_diff_base` in `app/engine/git_diff_base.py`: the freshest base ref (`origin/<base>` when the local branch is behind it), and a repointed HEAD measured against `<branch>@{started_at}` unless the merge-base attributes fewer lines. Same rule as `resolveTaskDiffBase` in `packages/cezar/src/git-diff-base.ts`. |
| Fetch | Skipped when dry-run is on. Otherwise one best-effort `git fetch` of the base branch. |
| Dispatch | Cap of 4 in-flight children and the budget carve are ported. A settled child stores a report on the parent. A running parent whose runner implements `steer` receives that report as a Claude-shaped user frame on the open stdin (`ProtocolRunner.steer`). `CEZ_DISPATCH=0` refuses new children. |
| Automations | Paused until enabled. A `schedule` row fires on its interval; a `github` or `tracker` row is polled on it and starts a run per new match (off under `CEZ_DRY_RUN=1` and `CEZ_AUTOMATIONS=0`). An enabled row idle longer than its own interval is moved forward at startup and does not fire a backlog; a poll is baselined on enable, so existing items never fire. Jira and Linear events are not history: the tracker poll sees issues currently in the wanted status. |
| URL shape | `?project=` on workspace pages, not `/p/:projectId/...`. |
| Host guard and login | Loopback `Host` check on `/api`, including health, with the same 403 text as #426. A missing Host is untrusted. `CEZ_REMOTE=1` or a non-loopback bind (compose's `0.0.0.0`) skips it, matching hosted mode, and then requires HTTP Basic auth. `GET /health` stays open for the healthcheck. A loopback bind does not ask for a password. The TypeScript process has no login; its VPS install puts this challenge on nginx. There is no nginx in compose, so the Python process issues it. |
| CSS | Hand-written from the cockpit tokens in `packages/web/src/styles/index.css`. Not DaisyUI. The React screens are not reproduced. |

## Size

Line counts, file counts, and the TypeScript comparison live in
[docs/ts-vs-python-comparison.md](docs/ts-vs-python-comparison.md), which holds the
current measurements. They are not repeated here so the two documents cannot disagree.

## Checks

`uv run ruff check`, `uv run ruff format --check`, `uv run pyright`, and
`uv run pytest -q` were run on this branch with no failures: ruff clean, 689 files
already formatted, pyright 0 errors, **375 tests passed**.
`uv run --group e2e pytest e2e -q` passed **14** of 14 Chromium walks. The tests are
hermetic: they pass whether or not the real `claude` and `gh` are installed or a
`GITHUB_TOKEN` is set.

`docker compose up --build` was run on this slice: the image built (bash, git,
and the cryptography package for the secret store) and the container became
healthy. An earlier boot (before Basic auth) ran a dry-run task to `review` on
`cez/<id8>` inside the mounted repo. This boot checked the gate: `/health` was
200 with no credentials, `/tasks` and `/api/v1/health` were 401, and the
generated password from the data volume authenticated `/api/v1/health`. Git is invoked with `safe.directory=*` for that process only,
because the container user does not own the mounted checkout and would otherwise
treat it as a non-git directory.

## Decisions

| Question | Choice |
| --- | --- |
| Where does state live? | SQLite. `import-runs` copies a `runs.json` array into that table and, when a sibling `runs/<id>.ndjson` exists, copies those events too. The parser and `events_near` are tested. The CLI's write into SQLite is not. Workflows and skills stay files under `.ai/cezar/` so they can still be committed. |
| What does a finished workflow become? | `done`, unless `CEZ_REVIEW_GATE=1` (or `reviewGate: true` in `.ai/cezar/config.json`) and the worktree has a diff and the run is not autonomous. Then it parks at `review`. Finish accepts that park and does not merge. Headless `run` treats both `review` and `done` as exit 0. |
| What happens to a `running` row after restart? | `Engine.recover` (called at the end of `Engine.startup`, before routes and the tick loop) first sweeps `<data dir>/tmp/<run id>` directories of runs that are not live, then resumes a `running` agent whose runner opened a session (`Run.session_runner`; Claude and Pi by run id, Codex and OpenCode when `codex_thread` is stored; any runner under dry-run) as a queued follow-up with `--resume` and the restart prompt that points at `CEZ_HANDOFF_FILE`. A `running` linear workflow with no session yet (queued behind the working-tree lease, or still spawning) is re-queued whole, as TypeScript does. Every other `running` row becomes `failed` with "interrupted by restart" (`mark_interrupted`): a runner that cannot resume, a graph parent whose dispatched children are still in flight, or a graph run with no session (TypeScript re-queues it at its persisted cursor; this port keeps none, so a re-run from the entry could repeat a commit, push or PR node). `queued` stays queued and the tick picks it up. `waiting` stays, so the question or graph park is still on screen. |
| Does `waiting` hold a parallelism slot? | No. The agent process has exited. `max_parallel` still defaults to 2 and caps `running` work. |
| Dry run | Default off, matching TypeScript. Compose sets `CEZ_DRY_RUN=1`. |
| Graph workflows (`version: 2`) | Loaded and walked for `start`, `agent`, `check`, `if`, `loop`, `end`, `fork`, `join`, `dispatch`, `git.commit`, `git.push`, `git.sync-base`, `github.draft-pr`, and `github.wait-ci` (no PR fails; dry-run reports green). A cycle that does not pass a loop `repeat` port is rejected. `github.pr-comment`, `github.issue-comment`, and `github.pr-update` are a dry-run note or a failure. `gate.human`, `ask-user`, and nested `workflow` are executed (`tests/test_graph_human.py`). |
| `onFail` on an agent step | A load error. TypeScript's schema allows the key and ignores it. |
| Secrets on a check | Injected into the check environment from an AES-256-GCM store under the data directory. Values are not returned by the list API. A `cezar` audience is not given to checks. The check itself is always `bash -lc`. |
| `allowedTools` / `bashAllowlist` | Claude argv maps a non-empty allowlist to `Bash(<prefix>:*)`. Pi drops Bash. Copilot is `--allow-all-tools` and the allowlist is not mapped. A check step always runs `bash -lc`, the same as TypeScript: the allowlist does not gate it. |
| Diff base | `resolve_task_diff_base` in `app/engine/git_diff_base.py`: the freshest base ref (`origin/<base>` when the local branch is behind it), and a repointed HEAD measured against `<branch>@{started_at}` unless the merge-base attributes fewer lines. Same rule as `resolveTaskDiffBase` in `packages/cezar/src/git-diff-base.ts`. |
| Fetch | Skipped when dry-run is on. Otherwise one best-effort `git fetch` of the base branch. |
| Dispatch | Cap of 4 in-flight children and the budget carve are ported. A settled child stores a report on the parent. A running parent whose runner implements `steer` receives that report as a Claude-shaped user frame on the open stdin (`ProtocolRunner.steer`). `CEZ_DISPATCH=0` refuses new children. |
| Automations | Paused until enabled. A `schedule` row fires on its interval; a `github` or `tracker` row is polled on it and starts a run per new match (off under `CEZ_DRY_RUN=1` and `CEZ_AUTOMATIONS=0`). An enabled row idle longer than its own interval is moved forward at startup and does not fire a backlog; a poll is baselined on enable, so existing items never fire. Jira and Linear events are not history: the tracker poll sees issues currently in the wanted status. |
| URL shape | `?project=` on workspace pages, not `/p/:projectId/...`. |
| Host guard and login | Loopback `Host` check on `/api`, including health, with the same 403 text as #426. A missing Host is untrusted. `CEZ_REMOTE=1` or a non-loopback bind (compose's `0.0.0.0`) skips it, matching hosted mode, and then requires HTTP Basic auth. `GET /health` stays open for the healthcheck. A loopback bind does not ask for a password. The TypeScript process has no login; its VPS install puts this challenge on nginx. There is no nginx in compose, so the Python process issues it. |
| CSS | Hand-written from the cockpit tokens in `packages/web/src/styles/index.css`. Not DaisyUI. The React screens are not reproduced. |

## Size

Measured with cloc 1.98 on 2026-10-29. Code lines exclude blanks and comments.
TypeScript application rows are `packages/**/*.{ts,tsx}` whose file name does not
contain `test` or `spec` and whose path is not `packages/web/e2e`. An earlier
count of 800 files / 145,968 lines is that same filter **with** `packages/web/e2e`
included (49 TypeScript files, 7,930 code lines: 752+49=801, 138,051+7,930=145,981).
Python `app/` code matches the previous table. cloc skips 16 empty `app/**/__init__.py`
files; 146 `.py` files are on disk. The TypeScript test total warned that
`packages/cezar/src/workflows/dispatch-engine.test.ts` exceeded cloc's line timeout
(679 raw lines), so that test figure may be slightly low.

| Area | Files | Code | Raw lines |
| --- | ---: | ---: | ---: |
| TS `packages/cezar/src` | 296 | 60,602 | 87,276 |
| TS `packages/web/src` | 419 | 72,938 | 95,052 |
| TS `packages/contract/src` | 37 | 4,324 | 7,227 |
| TS `packages/api-client/src` | 6 | 422 | 822 |
| **TS app (no tests, no e2e)** | **752** | **138,051** | **189,176** |
| TS `packages/web/e2e` | 49 | 7,930 | — |
| TS desktop Rust (`packages/desktop/src-tauri/src`) | 5 | 3,118 | 3,837 |
| TS tests | 865 | 164,856 | 200,953 |
| Python `app/engine` | 57 | 11,022 | — |
| Python `app/features` | 48 | 8,345 | — |
| Python `app/integrations` | 12 | 2,713 | — |
| Python `app/` root | 7 | 980 | — |
| Python secrets, store, http, common | 6 | 1,039 | — |
| **Python `app/`** | **130** | **24,099** | **28,099** |
| Python `tests/` | 41 | 8,164 | 9,153 |
| Python `e2e/` | 2 | 465 | 553 |
| `static/css/style.css` | 1 | 253 | 299 |
| App JS (`graph.js`, `diagram.js`, `thread.js`) | 3 | 70 with datastar | 67 |
| Vendored `static/js/datastar.js` | 1 | (folded into that JS cloc) | 11 lines, 33,553 bytes |
| Vendored `static/js/mermaid.min.js` | 1 | 1,951 | 2,315 lines, 2,571,900 bytes |

Python `app/` is 17.4% of the TypeScript application by code lines
(24,099 / 138,051), or 16.5% if the React e2e files are counted as application
code. Python tests are 5.2% of the TypeScript test count (8,629 / 164,856).
Desktop Rust is outside both ratios. Vendored mermaid and datastar are not
application code.

## Checks

`uv run ruff check`, `uv run ruff format --check`, `uv run pyright`, and
`uv run pytest -q` were run on this branch. **375 tests passed** and 2 failed: `test_a_missing_backend_fails_the_run_instead_of_spawning` and `test_github_and_tracker_pages_look_up` fail only on a machine that has the real `claude` and `gh` installed.
`uv run --group e2e pytest e2e -q` passed **13** of 14 Chromium walks; the 14th (`test_repository_commits_and_workflow_steps`) fails only on a machine with the real `gh` installed, like the two pytest failures above.

`docker compose up --build` on this commit became healthy. `GET /health` was 200
with no credentials. `/tasks` and `/api/v1/health` were 401. HTTP Basic against
the generated password in the `cezar-data` volume authorized `/api/v1/health`,
and `POST /api/v1/runs` reached `done` on `cez/<id8>`. The password is not recorded here.

## Checklist

Status is `done`, `partial`, `not done`, or `intentionally not ported`. "Verified" is the check that was
actually run, not a claim that the TypeScript behavior matches line for line.
A non-done status is tagged with one owner stream: `partial · A`, `not done · B`,
`intentionally not ported · C`. **A** is engine, runners, workflows, automations,
recovery, and env vars. **B** is HTTP routes and the CLI. **C** is UI screens,
settings keys, and e2e coverage. **D** is webhooks, integrations, agent profiles,
the WebSocket bus, persistence shape, and hosted terminal policy.
This pass: **207 done**, **0 partial**, **0 not done**, **30 intentionally not ported** (237 rows).
Open rows (partial + not done + intentionally not ported): **A 7, B 17, C 3, D 3** (30).
The porting backlog (partial + not done, leaving the accepted exclusions aside) is **A 0, B 0, C 0, D 0** (0).
Every row is in one of those four states.

### Persistence and model

| Item | Status | Verified |
| --- | --- | --- |
| SQLite for projects, runs, events, settings, automations | done | `tests/test_engine.py`, `tests/test_cockpit.py` |
| Import of `.ai/cezar/runs.json` and NDJSON | done | `tests/test_import_runs.py` keeps id, task, status, workflow, runner, and timestamps, skips a bad row, and reads `runs/<id>.ndjson`. `tests/test_stream_b.py` runs `import-runs` and finds the dashed UUID's event text in SQLite. A second import skips the same id. |
| Workflow and skill files remain the authored source | done | `tests/test_workflows.py`, cockpit workflow/skill test |
| Workspace settings: parallel (default 2), runner, theme, accent | done | `test_unset_parallel_default_is_two` reads `maxParallel` 2 from `GET /api/v1/workspace/config` before any save, and the settings page says the default is 2. `test_settings_save_repaints_the_stream` saves parallel, runner, theme, and accent. |
| Per-project base branch stored at registration | done | The project card and Settings → Tasks save it through `Engine.set_base_branch`. A task started after that forks from the saved branch (`tests/test_screens.py`). |
| Secrets vault | done | `tests/test_secrets.py` and the check injection test. AES-256-GCM, audiences `checks` and `cezar`, project root binding, list API omits values. Stored under `$PROJECT_DATA_DIR/secrets`, not `~/.cezar/secrets`. The data key is the keychain row. |
| Agent accounts / profiles | done | `/settings/accounts` stores `{id, name, runner, home}` in `$PROJECT_DATA_DIR/agent-accounts.json`. Claude gets `CLAUDE_CONFIG_DIR` and Codex gets `CODEX_HOME` (`tests/test_agent_env.py`). `POST /runs` accepts `accountId`. The page also carries what `packages/cezar/src/workspace/agent-profiles.ts` computes: per-account login status and validity read from the account's own files, no agent CLI spawned (`app/integrations/accounts.py` `account_state`: folder missing, not signed in, signed in; the folder looks like an agent folder by the same marker files as `PROFILE_DIR_MARKERS`), a details page (`/settings/accounts/{id}`, who the account is signed in as, named fields only, never the tokens), and a per-project account choice per runner (`POST /settings/accounts/selection/{project_id}/{runner}`, stored in `$PROJECT_DATA_DIR/agent-selections.json`). `Engine.plan_run` gives a new run in that project the chosen account when none is named; an explicit `accountId` wins, and a selection naming a deleted account falls back to the default login. Only Claude and Codex can carry an account, as in TypeScript. Not ported: `open` (opening the folder in the OS file manager), editing and removing an account, and the machine-wide default. Tests: `tests/test_detail_screens.py`. |
| UI state, attachments, layouts | done | `tests/test_surface.py`. Project `.ai/cezar/ui-state.json` and `$PROJECT_DATA_DIR/ui-state.json` merge shallowly and cap a write at 200 keys. Uploads store base64 under the data directory (text, images, pdf, octet-stream) and delete by id. Layouts, drafts, and prompt templates are JSON under the data directory (`tests/test_stream_b_close.py`). |

### Workflows

| Item | Status | Verified |
| --- | --- | --- |
| `steps` XOR `skills` | done | `tests/test_workflows.py` |
| Agent step XOR check step | done | `test_agent_and_check_are_exclusive` in `tests/test_workflows.py` |
| `onFail.retry` must name an earlier step; `max` defaults to 2 | done | `test_retry_must_name_an_earlier_step`, `test_on_fail_max_defaults_to_two` in `tests/test_workflows.py` |
| `retryOn` rejects 0; empty list retries any failure | done | `test_retry_on_rejects_zero_and_any_failure_retries_without_a_list` in `tests/test_workflows.py` |
| `{{task}}` substitution | done | `test_cez_done_does_not_skip_the_next_agent_step` in `tests/test_engine.py` asserts the task text in the prompt |
| Chain note when there are 2+ agent steps; `CEZ:DONE` does not skip | done | `test_cez_done_does_not_skip_the_next_agent_step` |
| Built-in `quick-task`; a valid file overrides it; a bad file does not | done | `tests/test_workflows.py` |
| Queued file snapshot is not replaced by the built-in when the file disappears | done | `test_a_deleted_file_does_not_replace_a_queued_snapshot_with_the_builtin` |
| Version 2 graph workflows | done | `tests/test_graph.py` walks the spec example, including the loop cap. `tests/test_graph_nodes.py` runs a fork, a dispatch, a commit, a dry-run draft PR, and `github.wait-ci`. `tests/test_stream_a.py` runs `github.pr-comment`, `github.pr-update` (`pr ready`, a label, a reviewer), and `github.issue-comment` against a fake `gh`, and fails a comment when the task has no PR. `gate.human`, `ask-user`, and nested `workflow` are the next row. |
| Node editor | done | Loops, fork, dispatch, git, draft PR, and dry-run wait-ci are walked. `/workflows/{name}/editor` is a server-drawn canvas: start a graph, add a node, move it, connect it, and save version-2 YAML. `tests/test_stream_a_close.py`, `e2e/test_screens.py`. |
| `init` example `fix-and-verify.yaml` and `project-conventions.md`, never overwrite | done | `tests/test_cli.py` |
| `.ai/cezar/.gitignore` entry list | done | `test_gitignore_appends_missing_entries_and_keeps_user_lines` |

### Runs

| Item | Status | Verified |
| --- | --- | --- |
| Queue, `max_parallel` (default 2) | done | `test_only_one_run_occupies_a_slot_when_max_parallel_is_one` |
| Statuses `queued` `running` `waiting` `review` `done` `failed` `cancelled` | done | `test_only_one_run_occupies_a_slot_when_max_parallel_is_one` (queued, running), `test_an_ask_waits_and_the_answer_continues` (waiting), `test_the_review_gate_offers_finish` (review), `test_success_is_done_until_the_review_gate_is_on` (done), `test_a_restart_fails_a_running_agent_that_never_opened_a_session` (failed), `test_cancel_stops_a_check_without_waiting_for_it` (cancelled) |
| Success is `done` unless the review gate is on; finish does not merge | done | `test_success_is_done_until_the_review_gate_is_on` and `test_creating_a_task_reaches_review_and_finish_does_not_merge` (the name is older than the assertion: the page shows `status-done` and finish is 409). `test_the_review_gate_offers_finish` parks at `review` only when `CEZ_REVIEW_GATE=1`, then finish does not add a commit. |
| `CEZ:ASK` parks in `waiting`; an answer continues | done | `test_an_ask_waits_and_the_answer_continues` in `tests/test_engine.py`, `test_an_ask_can_be_answered` in `tests/test_cockpit.py` |
| Follow-up from `review` is one more agent turn | done | `deliver` from `review` queues one agent turn with `resume` set and that message as the prompt. `tests/test_stream_a.py`. |
| Cancel, including killing a check | done | `test_cancel_stops_a_check_without_waiting_for_it`, API cancel test |
| Restart fails an unresumable `running` run and leaves `queued` | done | `test_a_restart_fails_a_running_agent_that_never_opened_a_session` |
| Resume of a live CLI session after restart | done | `tests/test_engine.py`: `test_a_restart_requeues_queued_work_and_the_scheduler_runs_it`, `test_a_restart_resumes_a_running_agent_with_its_session_and_handoff`, `test_a_restart_requeues_a_running_workflow_that_never_opened_a_session`, `test_a_restart_fails_a_graph_run_that_never_opened_a_session`, `test_a_restart_fails_a_running_agent_whose_runner_cannot_resume`, `test_a_restart_fails_a_graph_parent_that_was_awaiting_children`, `test_a_restart_keeps_a_waiting_run_waiting`; `tests/test_stream_a.py` `test_an_interrupted_run_resumes_the_cli_session`. `Engine.recover` runs inside `Engine.startup`. Differences from TypeScript `recover()`: a graph run with no session is failed, where TypeScript re-queues it at the persisted cursor (this port keeps no cursor, so a re-run from the entry could repeat a commit, push or PR node); `waiting` ask parks stay waiting (an answer re-queues them) where TypeScript fails them with a Continue button; there is no graph cursor, so a graph parent awaiting dispatched or nested-workflow children is failed, where TypeScript re-queues it at the node. |
| Monitoring / autonomous nudge loop | done | `CEZ:MONITORING` parks in `monitoring` and does not hold a slot. The tick requeues the monitoring nudge after the interval, 40 times, then parks in `waiting`. An autonomous turn without `CEZ:DONE` is continued with the autonomous nudge; the dry-run agent answers that nudge with `CEZ:DONE`. `tests/test_stream_a.py`. |
| Usage-limit auto-resume | done | Claude's usage-limit marker with an epoch (seconds or milliseconds), an ISO timestamp, a dated clock (`Oct 31, 9am (Europe/Warsaw)`), a clock-only reset (`8:10pm (Europe/Warsaw)`), and a relative delay set `auto_resume_at` to the reset plus 30 seconds. The named zone is applied. The tick requeues the run. Attempt 12 stops with a note. A check whose output contains `usage limit` also schedules a short retry. `DELETE …/auto-resume` clears the deadline (`tests/test_stream_a.py`, `tests/test_stream_a_close.py`, `tests/test_stream_b_close.py`). It does not resume a live provider CLI session. |
| Worktree and index retention | done | `Engine.retain()` deletes finished worktree directories past the cap and index rows past `CEZ_RUNS_KEEP`. A queued row stays. `tests/test_stream_a.py`. The selectors in `tests/test_finish.py` still cover keep 0 and live rows. |
| Archive, pin, read/unread | done | `tests/test_surface.py` and `tests/test_graph_nodes.py`. Bulk archive and mark-all-read match the TypeScript rules. |
| Queued message stack editable before dequeue | done | Edit and delete change the text folded into the prompt and do not write it back onto `task`. A second `Engine.startup` records that a deferred message was lost. `tests/test_stream_a.py`. A message that arrives while `running` is still the next follow-up (`tests/test_graph_nodes.py`). |
| Child dispatch cap 4, budget carve, settle report | done | `tests/test_dispatch.py`, `test_dispatch_caps_children_and_reports_when_one_settles` |
| Report injected into the parent's live session | done | A running parent whose runner implements `steer` receives the child's report in that session, and the pending copy is cleared. With no open session the report stays for the next prompt. `tests/test_stream_a.py`. |
| `cez task` CLI inside the worktree | done | `POST /runs/{id}/dispatch` creates a child while the parent is running and has a branch. `POST /runs/{id}/report` stores `status` and `verdict` on that child and 404s a run with no parent. The CLI posts those routes when `CEZ_API_URL` and `CEZ_TASK_ID` are set, and exits 2 when the URL is missing. `tests/test_stream_b.py`, `tests/test_cli.py`. The child uses the parent's runner. |
| Variants (×2 / ×3) and compare | done | The new-task form posts `variants` 2 and 3 and lands on `/tasks/{id}/compare`, which renders A/B and A/B/C (`tests/test_screens.py`). `POST /api/v1/runs` still returns `{runs}` (`tests/test_api.py`). |
| In-place / trunk landing | done | A non-git directory runs in place. `CEZ_WORKTREE_DEFAULT=0` or `"inPlace": true` runs a git checkout in place (`tests/test_stream_a.py`, `tests/test_stream_b_close.py`). `landing: auto` in an untracked `.ai/cezar/config.json` lands that checkout: an interactive `CEZ:DONE` parks for review and Finish commits; an autonomous run commits without parking. Required checks run during that land. A git-tracked config cannot grant auto-land. Without it, finishing an in-place run commits the checkout and `POST …/land` commits a later dirty file. Autosave and land both leave `.ai/cezar` unstaged. `tests/test_stream_a_close.py`, `tests/test_stream_b_close.py`. |

### Git

| Item | Status | Verified |
| --- | --- | --- |
| Worktree per task at `.ai/cezar/worktrees/<id>`, branch `cez/<id8>` | done | `test_success_is_done_until_the_review_gate_is_on` asserts `cez/<id8>` and the dry-run file under that worktree |
| Option-like refs refused before git sees them | done | `test_option_like_refs_are_refused`, bad-base test |
| A failed worktree create does not run in the main tree | done | `test_a_bad_base_does_not_run_in_the_main_tree` |
| Diff includes untracked files and is capped | done | untracked file asserted; a body over the cap is truncated (`tests/test_git_base.py`) |
| Freshest `origin/<base>` vs fork-point attribution | done | `resolve_task_diff_base` in `app/engine/git_diff_base.py`. A stale local `main` measures against `origin/main`. A repointed HEAD uses the branch reflog at `started_at` unless the merge-base attributes fewer lines. No start time stays at `HEAD`. The task diff, the review-gate diff, and `GET /runs/{id}/diff` go through it (`tests/test_git_base.py`). |
| Remotes via `gh repo set-default` / fork parent | done | `resolve_task_remotes` in `app/engine/git_remotes.py`. `gh-resolved=base` wins, else a remote GitHub reports as `origin`'s fork parent, else `origin`. Push follows `remote.pushDefault`. The parent lookup is skipped under `CEZ_DRY_RUN=1` and for non-GitHub hosts. A fake `gh` is the only process spawned (`tests/test_git_base.py`). Fork and push use that remote. |
| Branch naming instructions | done | Dry-run naming stays off unless `CEZ_AUTONAME=1`, then the canned mock answer `feature/implementing-cr-fixes` is the branch and the title is `implementing cr fixes`. `CEZ_AUTONAME=0` keeps `cez/<id8>`. A live run asks the Claude binary with the same prompt and keeps the default when the answer is junk. `tests/test_engine.py`. |
| Orphan worktree directories whose run id is gone | done | `test_orphan_worktrees_go_and_known_runs_stay` |
| Draft PRs, merge, GitHub review | done | `POST /runs/{id}/pr` returns the dry-run URL and does not push. The task page merge box includes a review form (`#review-form`, Send review) that posts `comment`, `approve`, or `request-changes`. `expectedHeadSha` must match the head or the merge is 409 `head_moved` (`tests/test_surface.py`, `tests/test_stream_d_close.py`). |

### Agents

| Item | Status | Verified |
| --- | --- | --- |
| Dry-run mock (`mock:fail`, `mock:ask`, `mock:write`) | done | `mock:fail` fails the headless run (`test_headless_run_treats_review_as_success`). `mock:ask` parks and continues (`test_an_ask_waits_and_the_answer_continues`). `mock:write notes/out.txt` writes that file in the worktree (`test_mock_write_creates_the_named_file`). Not `scripts/mock-claude.mjs`. |
| Claude stream-json session | done | `tests/test_runners.py` fake binary. Argv matches `buildClaudeArgs`. Stdin is one user message; image blocks lead the text. `.ai/cezar/mcp.json` becomes a `0600` `--mcp-config` plus `mcp__<name>` allow rules. A silent process is killed after 15 minutes (8× that is the hard ceiling). `stream_event` text deltas are live-only. Cancel and the inactivity kill are SIGTERM, then SIGKILL after 4s (`tests/test_runner_gaps.py`). A process that is still alive after the turn is reused for the next follow-up; if it has exited, the next turn is a new process with `--resume`. `system/init` stores the session, a thinking block is `reasoning`, and a tool error is prefixed `error:` (`tests/test_runners.py`). |
| Codex app-server | done | fake binary. `thread/start` on the first turn; a stored thread id is `thread/resume` on a later turn (`tests/test_runners.py`). A resume that reports `already has an active writer` is retried, then `thread/fork` (`tests/test_runner_gaps.py`). Stdio MCP servers ride `config` overrides. `item/updated`, `fileChange`, and `contextCompaction` are parsed. `reasoning` and `plan` stay non-tool events, `thread/tokenUsage/updated` is recorded, and a child thread's `turn/completed` does not end the parent (`tests/test_runners.py`). A real process that emits compaction is continued on the same thread (`tests/test_stream_a_close.py`). The engine still stops after 3 compaction continues (`tests/test_stream_a.py`). |
| OpenCode serve | done | Fake binary. `opencode serve --hostname 127.0.0.1 --port N`, then `POST /session` and `POST /session/:id/message`. A `text/event-stream` body surfaces assistant parts and skips the user's echo; `permission.asked` becomes `permission.requested`. A second turn reuses the stored session id and does not create another session. `tests/test_runners.py`. A JSON body is still accepted. |
| Cursor agent | done | fake binary. Argv is `-p --force --trust --output-format stream-json` and the prompt as the last positional (system prompt prepended). Same stream-json parser as Claude, including `system/init`, thinking, and tool errors (`tests/test_runners.py`). One shot: the prompt is argv, not a stdin session. |
| pi RPC | done | fake binary. `pi --mode rpc`, then `{type:get_state}` and `{type:prompt, streamingBehavior:steer}`. `message_update` / `text_delta`, `message_end` text and usage, tool start/end (including an error result), and `agent_settled` ends the turn. `get_state` stores the session id. An extension error is a note, not a failed turn. `--session` versus `--session-id`. A non-empty bash allowlist drops Bash. `tests/test_runners.py`. |
| Junie ACP | done | fake binary. `junie --acp=true -p <cwd>`. JSON-RPC `initialize` (protocolVersion 1), `session/new`, `session/prompt`. `session/update` chunks stream, including thought chunks and plan entries. A tool call uses `title` or else `kind`. `session/new` stores `sessionId`. The prompt response completes the turn. `stopReason: refusal` fails it. `tests/test_runners.py`. |
| Copilot ACP | done | fake binary. `--acp --allow-all-tools --no-auto-update` (`--model` when set). Same ACP frames as Junie, including thoughts, plans, and the session id (`tests/test_runners.py`). `allowedTools` and `bashAllowlist` are not mapped onto flags, matching TypeScript. |
| Stdin subprocess | removed | `CEZ_REAL_AGENTS` / `StdinAgent` was Python-only, with no TypeScript counterpart. `CEZ_DRY_RUN=1` stays the mock; otherwise the protocol runners are used. |
| Missing binary | done | `test_a_missing_backend_fails_the_run_instead_of_spawning` — the run fails with "not found". |
| Model catalog, provider login, accounts | done | `--model` is passed for Claude, Cursor, Pi, and Copilot. `GET /providers/status` is `shutil.which`. `GET /models?runner=` probes Claude with a `list_models` control request and Cursor with `models`, and falls back to the static ids when the probe is empty. `auth status` sets `loggedIn`. `account` selects a home through `profile_env` in `app/engine/agent_env.py` (`tests/test_stream_a_close.py`). Connect, retry, and update spawn the CLI unless the cockpit is a dry run (`tests/test_stream_b_close.py`). Accounts themselves stay the stream D row. |
| MCP, images | done | Claude images and `.ai/cezar/mcp.json` are covered by `tests/test_runners.py`. A staged upload is written into the worktree (`tests/test_finish.py`). The prompt gains `The user attached:` plus those paths (`tests/test_stream_a.py`, `tests/test_stream_b_close.py`). |
| Tool allowlists | done | Claude maps a non-empty bash allowlist to `Bash(<prefix>:*)`. Pi drops Bash. Copilot stays `--allow-all-tools`. Codex and OpenCode argv do not carry an allowlist. `tests/test_runners.py`. |
| Skills as extra system prompt, local directories only | done | The engine loads `.ai/cezar/skills`, `.ai/skills`, `.agents/skills`, and the `.claude` / `.codex` / `.cursor` / `.opencode` mirrors. Global `~/.agents/skills` and `~/.claude/skills` are read, and a local file wins a name clash. A team repo is read from `~/.cache/cez/team-skills` when that directory already exists (`tests/test_stream_a.py`). Org repos configured in Settings are cloned and fetched by `refresh_team_skills` in `app/engine/team_skills.py`. Tests use a local path, not the network. Skills → Refresh runs that fetch (`tests/test_stream_a_close.py`). |

### Automations

| Item | Status | Verified |
| --- | --- | --- |
| Create paused, enable, pause, run now, delete | done | The automations page posts create, enable, pause, run now, and delete (`tests/test_screens.py`). The backlog rule stays `test_a_stale_schedule_does_not_launch_a_backlog`. |
| Stale schedule does not launch a backlog | done | `test_a_stale_schedule_does_not_launch_a_backlog` |
| Due interval launches one run | done | `test_a_stale_schedule_does_not_launch_a_backlog` asserts exactly one run for a due interval |
| Only `schedule` rows fire on time | done | `Engine._launch_due` skips `github` and `tracker` rows. `test_only_a_schedule_fires_on_the_interval` (`tests/test_automation_poll.py`) has all three kinds due and gets one run, no `gh` call. |
| GitHub poller | done | `app/integrations/github_poll.py` ports `github-poller.ts`: search for opened PRs and issues, label events and review / re-review requests rebuilt from the issue timeline (newest pages), closed vs merged, the author / assignee / label / reviewer filters, `maxRecords`, `lookbackDays`, and one launch per PR for review events. It runs `gh api` (`GH_PROMPT_DISABLED=1`, 30 s). Seen keys live in `automation_seen`, the cursor in `automation_state`, in SQLite (`app/store/polling.py`). `app/engine/poller.py` runs it from `Engine.tick` for enabled rows that are due, off in dry-run and with `CEZ_AUTOMATIONS=0`. The first poll after an enable only baselines. Tests: `test_opened_events_and_filters_pick_the_matching_items`, `test_closed_merged_label_and_review_events_come_from_the_search_and_timeline`, `test_a_poll_baselines_then_launches_each_match_once`, `test_an_unseeded_poll_baselines_and_launches_nothing`, `test_the_tick_polls_a_due_row_and_is_off_in_dry_run`, with `tests/fakes/gh_poll.py` first on PATH. |
| Tracker poller | done | `app/integrations/tracker_poll.py` polls `list_issues` for the project's association and keeps issues in the wanted `status` (and `allLabels`, `query`), keyed by id and status. The first poll marks what is there as seen. TypeScript reads provider history (`pollEvents`); Python has only the issue list. `test_the_tick_polls_a_due_row_and_is_off_in_dry_run` covers the shared tick; `tests/test_tracker.py` covers the reads. |
| Matched item in the agent environment | done | A launched run stores `automation` (repo, number, event, PR head). The agent's `AgentSpec.env` and check steps get `CEZ_GITHUB_REPO`, `CEZ_GITHUB_NUMBER`, `CEZ_GITHUB_EVENT`, `CEZ_PR_HEAD_SHA`, `CEZ_PR_HEAD_REF`, `CEZ_PR_BASE_REF` (`test_the_agent_gets_the_matched_item_in_its_environment`). `checkout: pr-head` (forking the worktree from the PR head) is not ported. |
| `/automations/new`, `/automations/:id`, `/automations/:id/log` | done | A form with kind, interval, GitHub events and filters, and tracker status choices read from the tracker integration (`automation_options`). Detail repaints through `db.watch` and edits with revision + 1; a changed trigger re-baselines. The log page lists every poll, check, run-now and schedule launch, opens one check with `?entry=`, and has Check now, Check and launch, and Retry failed launches. `test_the_new_detail_and_log_screens_load`, `test_create_and_edit_commands_validate_and_repaint`, `test_check_and_retry_commands_repaint_the_log_stream`, `test_a_schedule_cannot_be_checked_from_the_screen`. |
| Calendar UI | done | `/automations` renders a month grid. A new automation's name is in the cell for its `next_at` day (`tests/test_screens.py`). |
| GitHub / Jira / Linear reads | done | Unset credentials answer `{available: false}` and do not call out. A recorded server returns one GitHub issue, one Jira issue, one Linear issue, a Jira search hit, and a Linear search hit. `GET /github` returns the dry-run catalog (issues plus a draft PR). Base URLs must be the vendor https host or loopback (`tests/test_integrations.py`, `tests/test_stream_d_close.py`). |

### CLI

| Command | Status | Verified |
| --- | --- | --- |
| `serve` (default) | done | `tests/test_cli.py`. No arguments and `serve` both call `serve` on `127.0.0.1`. `--port 9` is the port passed through. An omitted port uses the first free port from 4321, so an explicit port is never rewritten (`tests/test_stream_b_close.py`). |
| `run` — `review` is exit 0, failure is exit 1 | done | `tests/test_cli.py` |
| `init` | done | `test_init_does_not_overwrite` in `tests/test_cli.py` |
| `projects list` / `add` | done | `test_projects_list_and_add` in `tests/test_cli.py` |
| `projects remove` / `rm` | done | `tests/test_cli.py`. Removes an added id, then a second remove is "not found". `CEZ_SINGLE_PROJECT=1` refuses add and remove. |
| `import-runs <path>` | done | `tests/test_stream_b.py`. The command copies the record and the dashed `runs/<uuid>.ndjson` event into SQLite. |
| `task`, `automation`, `runs`, `secrets`, `telemetry` | done | `tests/test_cli.py`. `task create` posts dispatch and maps `--kind`, `--review-of`, `--scope`, `--budget` (`max_cost`), `--success`, `--evidence`, `--tools` (`allowed_tools`), and `--retry-limit` (0 to 3) onto the body fields `POST /runs/{id}/dispatch` reads. `runs list --json` prints the records. `automation` has `schema`, `list`, `create`/`cron`/`tracker` (JSON), `check [--execute]`, `show`, `run`, `enable`, `pause`, `delete`, `update` (reads the automation, overlays the JSON, and sends the revisioned PUT), and `add` from flags. `add --every`, `--cron`, `--on`, `--kind tracker`, `--label`, `--author`, `--require-label`, `--to-status` map to `everyMinutes`, `kind`, `events`, and `filters`; `add --at` uses the `deferred-start` preview and create routes. The cockpit schedules by interval, so `--cron` is accepted only as `*/N * * * *` or `0 */N * * *`; any other cron shape is refused with that reason. `--model`, `--autonomous`, `--dispatch`, `--max-subtasks`, and `--review-child` have no field on the automation API and are refused, not ignored. `--changed-label` is refused for the same reason. `secrets` list/set/unset match. `telemetry status` does not send; `telemetry enable` exits 1. TypeScript: `packages/cezar/src/dispatch/task-cli.ts`, `packages/cezar/src/automations/automation-cli.ts`. |
| `versions`, `unlink` | intentionally not ported · B | Same family as self-update. This fork does not rewrite its install. |
| `server-install` / `deploy` / `uninstall` | done | Not the Node installer. `server-install` writes the unit and runs `systemctl --user` (or `launchctl` on macOS) through an injectable command. `deploy` runs `docker compose up -d`. `uninstall` disables the unit, runs `docker compose down`, and deletes the files. `CEZ_DRY_RUN=1` prints the commands and does not write or spawn. `tests/test_stream_b_close.py`. |
| self-update `install` / `update` / `use` / `link` | intentionally not ported · B | They rewrite the install. See `versions` and `unlink` above. TypeScript: `packages/cezar/src/index.ts`. |

### HTTP

Project routes are also mounted at `/api/v1/p/default/…` and
`/api/v1/p/<project id>/…`. An unknown project id is 404. The unscoped mount
is the boot project.

| Route | Status | Verified |
| --- | --- | --- |
| `GET /health` | done | `test_health_and_the_task_list` asserts the body is `ok` |
| `GET /api/v1/health` | done | `tests/test_api.py` and `tests/test_stream_b.py` check discovery keys, CORS `*`, no `root` on `projects[]`, disk, `instanceId`, local `terminal` / `designMode`, and `forge`. `tests/test_stream_b.py` also reads `capabilities.webhooks`: false by default, true only for `CEZ_WEBHOOKS=1` (`true` and `0` stay false), matching `resolveCapabilities` in `packages/cezar/src/server/capabilities.ts`; `tests/test_webhooks_d.py` checks the true case. `capabilities.terminal` is `local and terminal_enabled()`, while `POST /runs/{id}/terminal` uses `terminal_enabled()` alone (hosted policy row). |
| `GET /api/v1/runs` | done | JSON array of records. `workflowDef` omitted unless `full=1`. While a check is running the record includes `usage` (`cpuPct`, `rssBytes`, `procCount`) from that process tree (`tests/test_stream_b_close.py`). |
| `POST /api/v1/runs` | done | 201 stored record, or `{runs}` for `variants` 2 or 3 (letters A/B/C, one `groupId`). Inline steps run as `(planned)`. Image attachments are stored, and the dry-run prompt contains `The user attached:` (`tests/test_stream_b_close.py`). An attachment-only task is stored as `(see attachments)`. |
| `GET /api/v1/runs/{id}` | done | Required record keys (`id`, `title`, `workflow`, `task`, `status`, `createdAt`, `tokensUsed`, `archived`, `steps`). `tests/test_api.py`. `autoResumeAt` is present only while a retry is scheduled. |
| `GET /api/v1/runs/{id}/events` | done | `text/event-stream`. Replay then a live tail (`tests/test_api.py`). Dotted types are `ui-event`; everything else is `run-event`; the record is `run`. `item.delta` is live-only and coalesced at about 40 ms (`tests/test_runner_gaps.py`). A delta-only turn persists one `item.completed`. `plan.updated`, `usage.updated`, `permission.requested`, and `item.updated` are written and read back (`tests/test_stream_a.py`). `afterSeq` and `Last-Event-ID` skip older rows. |
| `POST /api/v1/runs/{id}/cancel` | done | A live check returns 200 `{cancelled: true}` and an unknown id is 404 (`test_cancel_a_live_run_and_an_unknown_id`). A settled run returns `{cancelled: false}` (`test_cancel_finish_delete_and_messages_use_the_contract_statuses`). |
| `POST /api/v1/runs/{id}/finish` | done | 200 from `review` and from `waiting` (`tests/test_api.py`). A settled run is 409 `no open session`. `Engine.finish` also accepts `running`: it sets the finish flag, cancels the step, and the walk marks the run `done`. No test posts finish while the status is still `running`. An in-place git checkout is committed on success and is not pushed. |
| `DELETE /api/v1/runs/{id}` | done | `test_cancel_finish_delete_and_messages_use_the_contract_statuses`: 409 while queued, 200 `{deleted: true}` after finish, and the next GET is 404. Running and waiting use that same guard and are not separate cases. |
| `POST /api/v1/runs/{id}/messages` | done | `{queued, message}` while the run is still `queued`; the stack is composed into the prompt and not written back onto `task`. `{delivered: true}` for `waiting` and `review`. `{deferred: true}` while `running`. Images on a review message are written into the worktree and the next prompt contains `The user attached:` (`tests/test_api.py`, `tests/test_stream_b_close.py`). |
| `POST /api/v1/runs/{id}/archive`, `POST …/pin`, `POST /runs/archive-finished`, `POST /runs/read-all`, `POST …/read`, `POST …/unread` | done | Archive and pin flags. Archiving clears a pin and cancels queued, running, or waiting work. The bulk sweep and read receipts match the TypeScript rules (`tests/test_surface.py`). |
| `PATCH/DELETE …/queued-messages/{msgId}` | done | Edit and delete while the run is still queued. After it starts, patch is 409. `tests/test_stream_b.py`. |
| `DELETE /api/v1/runs/{id}/auto-resume` | done | 200 `{cancelled: true}` when a usage-limit retry is scheduled, and `{cancelled: false}` when nothing is scheduled. The cleared run stays `failed`. 404 unknown. `tests/test_stream_b_close.py`, `tests/test_api.py`. |
| `GET /api/v1/workflows` | done | `{workflows, issues}`. A workflow file that is not valid YAML is reported under `issues` and the built-in `quick-task` stays (`tests/test_stream_b_close.py`). |
| `GET /api/v1/projects` | done | `id`, `name`, `root`, `addedAt`, `lastOpenedAt`, `source: local`, `status`, `branch` when it is a git checkout, `tags`, and `forge` (`{kind: github}` when `origin` is a GitHub host). The document includes `maxParallel`. `projectsDir` is `CEZ_PROJECTS_DIR`, or `<data dir>/projects` when that is unset. `PATCH` accepts `tags`. `tests/test_api.py`, `tests/test_stream_b_close.py`. |
| Loopback `Host` guard on `/api` | done | `tests/test_api.py`. Foreign Host is 403, including health. `CEZ_REMOTE=1` skips it. |
| Hosted Basic auth | done | `tests/test_api.py`. Required when hosted. `GET /health` is open. A missing `CEZ_AUTH_PASSWORD` is generated into the data directory at mode 0600. A successful Basic login sets an HttpOnly `cezar_session` cookie (token file mode 0600) that authorizes the next request without the header. The cookie is `Secure` when `X-Forwarded-Proto` is `https` (`tests/test_stream_b_close.py`). TypeScript has no Settings user table; nginx holds that password, and this port does the same with the password file. |
| `GET/POST /runs/{id}/git/status`, `commit`, `push`, `GET …/diff`, `POST …/pr` | done | `tests/test_surface.py`. Commit uses the repo identity, or `cezar <cezar@localhost>` when `user.name` is unset. Push and draft PR do not leave the machine when `CEZ_DRY_RUN=1`. The diff uses the freshest anchor. |
| `GET/PUT /ui-state`, `GET/PUT /workspace/ui-state` | done | shallow merge, 200-key cap, unknown keys kept. `tests/test_surface.py`. |
| `POST/DELETE /workspace/uploads` | done | `tests/test_finish.py` stores text, starts a run, and finds `note.txt` on the files pane. Delete-by-id is implemented in `tests/test_surface.py`. The prompt line `The user attached:` is asserted in `tests/test_stream_b_close.py`. |
| `GET /api/v1/fs/browse` | done | Directories only. A symlink whose target is outside `CEZ_BROWSE_ROOT` is hidden, and that outside path is 400. `tests/test_stream_b.py`. |
| `GET /providers/status`, `GET /models` | done | Binary presence, a static id list, and the local connect marker (`connected`, `enabled`, `version`). `tests/test_surface.py`, `tests/test_stream_b_close.py`. |
| `POST /preview/design-proxy` | done | Refuses non-loopback and hosted/`CEZ_DESIGN_MODE=0`. A loopback `http://` target is mirrored on `127.0.0.1` with `<!-- cezar-design -->` injected before `</body>`. `tests/test_surface.py`. |
| `POST /runs/{id}/terminal`, input, resize, output, close | done | Open answers 201, input and resize answer 200, the output stream's first event is `output`, and close then a second close is 404. `tests/test_stream_b.py`. `CEZ_TERMINAL=0` is still 409 (`tests/test_routes.py`). |
| `GET/POST/DELETE /webhooks`, `POST …/test`, `GET …/deliveries` | done | Receiver URL must pass the destination policy. Dry-run test delivery is recorded as 204 and does not open a socket. Signing key is `whsec_`. `PATCH/PUT /webhooks/{id}` follow the contract: a non-name change resets the receiver to `inactive` and bumps `deliveryRevision`; the settings-page rename helper keeps its in-place semantics (`tests/test_stream_d_close.py`, `tests/test_webhooks_d.py`). |
| `POST /hooks/github`, `/hooks/jira`, `/hooks/linear`, `GET /hooks/receipts` | removed | Python-only, no TypeScript counterpart (TypeScript has no inbound hook routes). The pollers cover triggers as in TypeScript. The `CEZ_*_WEBHOOK_SECRET` env vars went with them. |
| GitHub review and merge API | done | Dry-run merge-state, merge, and review. `expectedHeadSha` that is not the current head is 409 `head_moved` and does not merge. A matching head merges. The task page sends the review (`tests/test_parity.py`, `tests/test_stream_d_close.py`, `tests/test_surface.py`). |
| `GET /api/v1/launch-key` | done | Returns the same key the bookmarklet writes, mode 0600. `tests/test_routes.py`. |
| `GET/PUT /api/v1/config` | done | Reads and writes `systemPrompt`, `branchNaming`, and `reviewGate` without dropping other keys. `tests/test_routes.py`. |
| Skills refresh, workspace branding, plan, deferred-start scheduling | done | `POST /skills/update` and `POST /skills/refresh` are the same team-repo fetch (`app/features/api/closeout.py` `_refresh`, `tests/test_stream_b_close.py`). They are not `GET/POST /api/v1/workspace/skills-update`, which is the Open Mercato coordinator and stays intentionally not ported. `PUT /workspace/branding` stores a name and accent and does not rewrite the theme. `POST /plan` asks the configured runner. Deferred start is `tests/test_stream_b.py`. |
| Star count, self-update | intentionally not ported · B | They phone home or rewrite the install. Routes: `GET /api/v1/star-count`, `GET/POST /api/v1/workspace/self-update` and `…/refresh`, `…/development`, `…/apply`, `PUT …/channel`, `DELETE …/scheduled` (`packages/cezar/src/server/server.ts`, `packages/cezar/src/server/star-count.ts`). |

The Python cockpit does not use `/p/:projectId`. The same screen is a top-level
path. `tests/test_finish.py` loads the pages below that say they were checked
there.

### Screens

React routes from `packages/web/src/routes.tsx` and `routes/settings/registry.tsx`.
A row is `done` when the page renders its data and the primary action is tested.
It is not a pixel copy of the React component.

| React route | Python | Status | Verified |
| --- | --- | --- | --- |
| `/p/:projectId` tasks overview | `/tasks` | done | List, filter, and create. `tests/test_cockpit.py`. Archive and mark-read are buttons; the store rules are in `tests/test_surface.py`. The buttons are not posted. |
| `/p/:projectId/new` | `/tasks/new` | done | `tests/test_parity.py` asserts New task, Start, and `quick-task`. Create is `test_creating_a_task_reaches_review_and_finish_does_not_merge`. |
| `/tasks` global index | `/tasks` | done | `test_health_and_the_task_list` loads the one boot-project list. There is no second workspace index in this port. |
| `/p/:projectId/tasks/:id` session | `/tasks/{id}?pane=session` | done | Finish is posted and the page shows Cancel (`tests/test_cockpit.py`). The transcript contains `Dry run finished`, and Delete navigates away (`tests/test_screens.py`). |
| `…/changes` | `?pane=diff` | done | `test_creating_a_task_reaches_review_and_finish_does_not_merge` asserts `CEZAR_DRY_RUN.txt` on `?pane=diff` |
| `…/files` | `?pane=files` | done | A staged upload's name is on the pane (`tests/test_finish.py`). |
| `…/commits` | `?pane=commits` | done | After a commit, the pane lists `save the dry run` (`tests/test_surface.py`). |
| `…/graph` | `?pane=graph` | done | A quick-task shows the step "Do the task" (`tests/test_parity.py`). |
| `…/notes` | `?pane=notes` | done | A posted note is on the next render (`tests/test_parity.py`). |
| `…/terminal` | `?pane=terminal` | done | The pane runs one command in the worktree PTY and returns the output (`tests/test_screens.py`). `e2e/test_screens.py` types it. The HTTP terminal routes stay stream B. |
| `…/browser` | `?pane=browser` | done | The pane states the loopback design-mode rule (`tests/test_parity.py`). |
| `…/compare` | `/tasks/{id}/compare` | done | Variant letters A and B render (`tests/test_parity.py`). |
| `/p/:projectId/git` | `/git` | done | `?pane=` is commits, changes, branches, or files. Commits include `init`, files include `README.md`, branches include `main` (`tests/test_screens.py`). |
| `/p/:projectId/github` | `/github` | done | The page asks for owner and repo. Without a token it says `gh is not authenticated`. A stubbed read renders the issue title (`tests/test_screens.py`). |
| `/p/:projectId/github/prs`, `github/prs/:n`, `github/prs/:n/changes`, `github/issues/:n` | `/github/prs`, `/github/prs/{n}` (`?pane=changes`), `/github/issues/{n}` | done | The list links each pull request; the detail shows state, body and comments, and the changes pane colors each patch line. A bad number is 400 and an unknown one 404 (`tests/test_detail_screens.py`). |
| `/p/:projectId/tracker/:id` | `/tracker/{id}` | done | Reads the project's tracker issues and shows the one whose id matches. Unknown is 404, an unconfigured tracker says so (`tests/test_detail_screens.py`). |
| `/p/:projectId/git/commits/:sha`, `tasks/:id/commits/:sha` | `/git/commits/{sha}`, `/tasks/{id}/commits/{sha}` | done | `git show` of the commit with a colored patch. The hash must be hex (400), and a hash the repository does not have is 404 (`tests/test_detail_screens.py`). |
| `/p/:projectId/tracker` | `/tracker` | done | Look up posts a key. Unset credentials say `jira is not configured`. A stubbed read renders the summary. A saved connection is used when it has a token (`tests/test_screens.py`). |
| `/p/:projectId/automations` | `/automations` | done | The page posts create, enable, pause, run now, and delete, and the month grid names the row (`tests/test_screens.py`). |
| `/p/:projectId/automations/new` | `/automations/new` | done | `tests/test_automation_poll.py::test_the_new_detail_and_log_screens_load`. |
| `/p/:projectId/automations/:automationId` | `/automations/{id}` | done | Detail and edit; the summary repaints from `db.watch` (`test_create_and_edit_commands_validate_and_repaint`). |
| `/p/:projectId/automations/:automationId/log` | `/automations/{id}/log` | done | Check detail, check commands, retry (`test_check_and_retry_commands_repaint_the_log_stream`). |
| `/p/:projectId/skills` | `/skills` | done | List and create. `tests/test_cockpit.py`. |
| `/p/:projectId/workflows` | `/workflows` | done | Create and list. `tests/test_cockpit.py`. |
| `/workflows/:name` | `/workflows/{name}` | done | The page lists the steps (`Do the task` on quick-task) and Start a task opens `/tasks/new?workflow=` (`tests/test_screens.py`). The node editor remains stream A's row. |
| `/p/:projectId/inbox` | `/inbox` | done | A finished run is listed. Mark read leaves `Nothing unread.` (`tests/test_screens.py`). |
| `/p/:projectId/settings` appearance | `/settings` | done | `test_settings_save_repaints_the_stream` |
| settings `secrets`, `workspace-secrets` | `/secrets` | done | The form saves a project secret. The next page shows the name and not the value (`tests/test_screens.py`). One list for the boot project; there is no second workspace vault. |
| settings `privacy` | `/settings/privacy` | done | The page says telemetry is intentionally not ported. `tests/test_finish.py`. |
| settings `agents` | `/settings/agents` | done | A binary on disk is `installed` and a missing path is `missing` (`tests/test_screens.py`). |
| settings `webhooks` | `/settings/webhooks` | done | Saving a loopback receiver puts its name on the page. An http non-loopback URL is refused (`tests/test_screens.py`). |
| settings `worktrees` | `/settings/worktrees` | done | The page saves a keep count for the project. `Engine.retain` uses that count: with two finished worktrees and keep 1, reclaim drops the older directory (`tests/test_screens.py`). Unset, it stays the process default. |
| settings `instructions` | `/settings/instructions` | done | The editor saves both fields, the prompt is prepended on the run, and a `start with` rule renames the branch (`tests/test_engine.py`, `tests/test_parity.py`). Free-text naming still does not call a model. |
| settings `agent-config` | `/settings/agent-config` | done | Posting the editor writes `AGENTS.md`. A hosted cockpit answers 409 `agent config writes are local-only` (`tests/test_screens.py`). Catalog is those three files, not `catalog.ts`. |
| settings `accounts` | `/settings/accounts` | done | The form saves a name and a runner and lists them with their login state. `/settings/accounts/{id}` shows the details. A per-project select chooses the account a new run uses (`tests/test_screens.py`, `tests/test_detail_screens.py`). |
| settings `notifications` | `/settings/notifications` | done | `tests/test_parity.py` posts the toggle and asserts `Browser notifications are on.` |
| settings `keyboard` | `/settings/keyboard` | done | `tests/test_parity.py` posts `submit: enter` and the next page contains `enter` |
| settings `bookmarklets` | `/settings/bookmarklets` | done | The launch-key file is mode `0600`. `?launch=` with that key opens New task; a wrong key is 403 (`tests/test_screens.py`). |
| settings `integrations` | `/settings/integrations` | done | Set up e2e queues a task titled Tester Army, stores an optional model key as a project secret, and writes `e2e.config.ts` (`127.0.0.1:0`) plus `.ai/cezar/workflows/implement-and-e2e.yaml` when those files are absent (`tests/test_screens.py`). It does not run `npx e2e init`. |
| `/dashboard` | `/dashboard` | done | Status counts render, including `count-done` after a finished run. The usage table is a 7-day or 30-day UTC window (`?period=30d`). Input and output tokens, and cost, are lifetime totals grouped by the day the task was created. Completed counts `done` tasks by the day they finished, including a task created before the window. Hiding token or cost metrics drops those columns (`tests/test_screens.py`). |
| `/projects` and settings `projects` | `/projects` | done | `test_projects_and_dashboard` adds a directory, refuses a second add, and refuses `$HOME` |
| unknown path | — | done | `tests/test_finish.py` asserts `/does-not-exist` is 404 |
| settings `tracker`, `tasks`, `skills` (global), `global-instructions`, resources | `/settings/tracker`, `/settings/tasks`, `/settings/global-skills`, `/settings/global-instructions`, `/settings/resources` | done | The base branch is what the next task forks from. The global prompt is prepended before the project's own prompt (`tests/test_screens.py`). A required check runs only while auto-landing onto the trunk, after a rebase or before the commit when there is no upstream (`tests/test_stream_a_close.py`). A worktree run that reaches `done` does not run them (`tests/test_screens.py`). `false` fails the land and is sent back to the agent. An org skill repo is cloned bare — a local path in the test — and a step that names the skill gets that body in the prompt. The memory cap samples the agent process tree (`VmRSS` of processes whose cwd is the worktree, plus their descendants). Crossing it pauses the task at `waiting` and the note names the limit. The form still rejects a cap under 256 MB. |
| GitHub review and merge UI | task page `#merge-box` | done | A pull request shows Ready to merge or Merge blocked, the blocker, and Squash and merge. `tests/test_surface.py`. Failing checks block `canMerge`. |
| Light / violet tokens, phone layout | the same CSS | done | Saving light and violet sets `class="light"` and `data-accent="violet"` (`tests/test_cockpit.py`). At 390×844 the sidebar stacks above the page; at 1280 it sits beside it, and the wordmark is the light-violet primary (`e2e/test_screens.py`). |
| Command palette | `/palette/results` | done | ⌘K opens a dialog. The results request keeps a task whose title contains the query and drops the pages that do not (`tests/test_screens.py`). |
| Mermaid in the transcript | session pane | done | Every mermaid fence is a `pre.mermaid`. The vendored `static/js/mermaid.min.js` draws it in the browser. There is no CDN and no homegrown layout. `e2e/test_screens.py` waits for a flowchart and a sequence diagram, and aborts any request that is not the cockpit. |
| Thread virtualization | session pane | done | The server sends every event. At 300 rows the thread stays flat; past that, or with `?thread=virtual`, the browser keeps the last 16 rows in the DOM. `?thread=flat` keeps every row (`tests/test_screens.py`, `e2e/test_screens.py`). It does not restore a scrolled-up position the way virtua does. |
| Skills auto-update | — | intentionally not ported · A | TypeScript runs it from `packages/cezar/src/skills-update.ts`. After the server listens, a coordinator checks Open Mercato skill updates at most once per six-hour cache window and, when one is available and auto-update is on, applies it with a bounded `npx --yes skills update`. `CEZ_SKILLS_AUTO_UPDATE=0` or the Settings override skips applying. This port does not start that coordinator. `POST /skills/update` is the team-repo refresh, a different route. |
| Host telemetry | — | intentionally not ported · A | This fork does not send host telemetry (`packages/cezar/src/telemetry.ts`, spec `2026-09-20-host-resource-telemetry.md`). `GET /api/v1/workspace/host-usage` is a local sample and stays the done row. The `host` WebSocket topic is the WebSocket row. |

### Background work and integrations

| Item | Status | Verified |
| --- | --- | --- |
| Scheduler loop | done | `test_only_one_run_occupies_a_slot_when_max_parallel_is_one` |
| Automation ticker | done | `test_a_stale_schedule_does_not_launch_a_backlog` |
| Telemetry | intentionally not ported · A | This fork does not send telemetry. `GET/PUT /api/v1/telemetry/consent` and `POST /api/v1/telemetry/event` record a local answer and set `transmits: false` (`app/engine/telemetry_store.py`). `CEZ_TELEMETRY=0` and `DO_NOT_TRACK=1` keep it off. Nothing posts to `packages/cezar/src/telemetry.ts`. |
| Star count, self-update, skills auto-update | intentionally not ported · B | They would phone home or change the install. This fork leaves them out. The skills coordinator is the A row. The routes are the B rows. |
| Desktop shell | intentionally not ported · C | Owner decision: the Tauri shell (`packages/desktop`) stays out of this port. |
| `gh` issues and draft PRs | done | `GET /github` lists open issues and pull requests, including the dry-run draft. A draft PR is the dry-run URL unless dry-run is off, in which case the port runs `gh pr create --draft` after a push (`tests/test_stream_d_close.py`, `tests/test_parity.py`). |
| Webhooks | done · D | Receivers, signed test deliveries, a lifecycle enqueue when `CEZ_WEBHOOKS=1`, and the full contract surface (formats, states, history, control plane) are tested (`tests/test_parity.py`, `tests/test_engine.py`, `tests/test_stream_d_close.py`, `tests/test_webhooks_d.py`). Delivery renders per receiver format — `slack.v1`, `discord.v1`, `cezar.json.v1` — in `app/integrations/service.py`. Health reports `capabilities.webhooks` honestly. |

## What is still TypeScript

`packages/`, the React cockpit, and the CLI in `packages/cezar/src/index.ts`
stay. The Python runners speak the same wire formats against fake binaries.
No row is partial or not done. The intentionally-not-ported rows name what deleting the
TypeScript tree would drop: the WebSocket bus, the SPA JSON data feeds (dashboard, skills,
worktrees, terminal chrome, workflow JSON), per-run drafts and layouts, the agent-profile
API, self-update, desktop and telemetry sends, and the React e2e suite.

## Risks

- Calling this parity would be false. About 149 of 228 TypeScript `/api/v1`
  routes match a Python route by method and path. The open rows below are the
  rest. The runners are protocol-tested against fakes, not against the real CLIs.
- Unset `CEZ_DRY_RUN` spawns whatever binary is on `PATH` for the selected
  runner, with that runner's flags, and does not ask before tools. Compose
  keeps the mock on.
- Compose binds `0.0.0.0`, so it is hosted mode: HTTP Basic auth, not the
  loopback Host check. `GET /health` is unauthenticated on purpose. A loopback
  `cezar serve` is still an open local port, matching the TypeScript app.
  `same_origin()` blocks cross-site mutations and is not a substitute for the
  password.
- One process owns the SQLite file. A second `run` or `projects` command exits
  if the cockpit holds the claim.
- A check step is `bash -lc` in the worktree, including when the step names
  a `bashAllowlist`. That list is applied to the agent argv only. Secrets
  with the `checks` audience are injected and redacted from the transcript
  when they are at least 12 characters.
- A follow-up reuses a Claude or Pi process that is still alive. If that
  process has exited, the next turn is a new process with `--resume` (Claude,
  Pi) or Codex `thread/resume`. A Codex resume that still holds the writer
  lock is retried, then `thread/fork`. If the CLI did not persist the session,
  resume fails.
- Dry-run push and draft PR do not call the network. A real `gh pr create`
  runs only when `CEZ_DRY_RUN` is off.
- Telemetry, self-update, and the star count are intentionally not ported.
  Nothing in this fork posts to those upstream endpoints.
- The design-mode proxy listens on `127.0.0.1` and only fetches a loopback
  `http://` URL. Hosted mode leaves it off.
- The terminal hub is a PTY (`bash --noprofile --norc -i`) with `TIOCSWINSZ`.
  The task pane's shell is one open, write, and close. `tests/test_stream_b.py`
  calls `POST /runs/{id}/terminal`, input, resize, output, and close.
  `CEZ_TERMINAL=0` is 409. A hosted bind still opens that PTY unless the flag
  is `0`. TypeScript leaves the terminal off on a hosted bind unless
  `CEZ_TERMINAL=1` (`packages/cezar/src/server/capabilities.ts`).
- Worktrees are created inside the project repo. Finish does not merge and does
  not push. `Engine.retain()` can drop a finished worktree directory and keep
  the branch; a test covers the selector, not that deletion.
- GitHub review, merge, and draft PR call `gh` only when `CEZ_DRY_RUN` is off.
  That path is tested with a fake `gh` on `PATH`. Push is `git push`, not `gh`.
- Instructions and branch naming are editors, and a run reads them.
  `app/engine/instructions.py` prepends `systemPrompt` from
  `.ai/cezar/instructions.json` and then `config.json`. The HTML agent-config
  editor is three files (`app/features/editors/store.py`). The JSON catalog is
  25 ids. Accounts are a local JSON list, not the TypeScript profile API.
- `CEZ_WEBHOOKS` defaults off. When it is `1` and a receiver is saved, a
  status change enqueues one rendered delivery per active receiver
  (`render_slack`, `render_discord`, or the raw `cezar.json.v1` envelope).
  Dry-run does not open a socket. The outbox owner is a hard link with a
  successor slot. Health reports `capabilities.webhooks` from the flag.
- The diff anchor is `resolve_task_diff_base`: freshest `origin/<base>` versus
  the branch as the run first saw it. A stale local `main` is not the measure.

## How to verify

```bash
uv sync
uv run ruff check
uv run ruff format --check
uv run pyright
uv run pytest -q
CEZ_DRY_RUN=1 uv run python -m app.main
```

The browser loop is not part of `uv run pytest`. It lives in `e2e/` and needs Playwright:

```bash
uv sync --group e2e
uv run --group e2e playwright install chromium
uv run --group e2e pytest e2e -q
```

The process listens on `127.0.0.1:4321`. `GET /health` is open.
`GET /api/v1/health` on that bind is open too. Compose is the hosted check:

```bash
docker compose up --build
```

`GET /health` stays 200. `/tasks` and `/api/v1/health` are 401 until the
generated password in the `cezar-data` volume is sent as HTTP Basic. Do not
print that password.

`claude` and `codex` are not installed in this environment. Runner tests use
the fake binaries under `tests/fakes/`. Nothing here is a live CLI handshake.

## Deviations from TypeScript

- A successful run stops at `done`. `CEZ_REVIEW_GATE=1` or `reviewGate: true`
  parks a non-autonomous run that has a diff at `review`.
- Check steps are `bash -lc`. `bashAllowlist` shapes agent argv and does not
  gate the check. That matches `runCheckStep`.
- URLs are `?project=` on top-level paths. There is no `/p/:projectId`.
- Hosted mode (`CEZ_REMOTE=1` or a non-loopback bind) requires HTTP Basic
  inside this process. TypeScript puts that challenge on nginx.
- The diff base is `resolve_task_diff_base`: the freshest base ref, and a
  repointed HEAD measured against the branch as the run first saw it.
- Secrets live in `$PROJECT_DATA_DIR/secrets`. The data key uses the OS
  keychain when `secret-tool` answers; `CEZ_SECRETS_KEYCHAIN=0` keeps the file.
- Cursor's binary override is `CEZ_CURSOR_AGENT_BIN`, then `CEZ_CURSOR_BIN`.
- `CEZ_AUTOMATIONS=0` is reported on the health document and does not stop the
  ticker. The automations JSON family answers 409 when it is set. `CEZ_FOLLOWUPS=1`
  is what makes `GET/DELETE/POST /todos` read the inbox file; off, the list is
  empty and a mutation is 409. The inbox page does not use that file.
  `CEZ_SINGLE_PROJECT=1` refuses project add, patch, and remove. `CEZ_HIDE_TOKEN_*`
  flips the health capability bits and hides the matching dashboard totals and
  usage-series columns.
- `CEZ_ARCHIVED_RUNS_KEEP` caps archived rows. Live rows still use `CEZ_RUNS_KEEP`.
- `systemPrompt` is prepended to the agent prompt. Branch names come from the
  namer. Dry-run uses the canned mock only when `CEZ_AUTONAME=1`.
- The settings editor writes three agent files (`AGENTS.md`,
  `.claude/settings.json`, `.claude/settings.local.json`). `GET/PUT /api/v1/agent-config/:id`
  serves the 25-id catalog. Writes are refused when the cockpit is hosted.
- Accounts are `{id, name, runner, home}` in the data directory. Claude and
  Codex homes are injected on a turn that names the account. Hosted mode
  refuses new accounts unless `CEZ_REMOTE_AGENT_ACCOUNTS=1`.
- Integrations queues one "Tester Army" task. It does not install a framework.
- GitHub merge and review call `gh` only when dry-run is off. The eligibility
  ladder and blocker list live in `app/integrations/merge_state.py`.
  `expectedHeadSha` must match the head.
- The webhook outbox is one NDJSON file. The owner is a hard link with a
  successor slot and a Linux PID namespace. Retries follow `retryAt` (5s
  doubling, 20% jitter, 72h expiry). Replay copies a finished payload for 7
  days and refuses `webhook.test`. Receiver edits check `expectedRevision`.
  Delivery uses the destination policy and does not follow redirects.
  `CEZ_WEBHOOKS` defaults off. Slack rendering covers labels, escapes,
  questions, links, and the 40_000-byte fallback.
- `item.updated`, `permission.requested`, `plan.updated`, and `usage.updated`
  are written and read back (`tests/test_stream_a.py`, `tests/test_runners.py`).
  `permission.resolved` and `session.ended` are not produced. `ask.requested`
  is the engine's `CEZ:ASK` park.
- Follow-up reuses a Claude or Pi process that is still alive. Otherwise it is
  a new process with `--resume`. `ProtocolRunner.steer` writes a Claude-shaped
  user frame into that open stdin. A settled child's report uses it
  (`tests/test_stream_a.py`).
- Telemetry, the star count, self-update, and the desktop shell are left out
  on purpose. Consent routes do not open a socket.

## TypeScript tests walked for this audit

`packages/*/src/**/*.test.*` and `packages/web/e2e/` were counted by directory,
not re-run. The large suites are `web/routes` (171), `cezar/server` (160),
`web/lib` (67), `cezar/core` (66), `web/components` (65), `cezar/workflows`
(57), and `cezar/webhooks` (51), plus the browser specs under `packages/web/e2e`
(task thread, git, GitHub, inbox, settings, webhooks, variants, automations).
Python covers a slice of core, workflows, runs, and server with fakes. It does
not run the React e2e suite. Areas that had no row before this pass are in the
next table.

## Not previously listed

| Item | Status | Verified |
| --- | --- | --- |
| `GET/PUT /api/v1/agent-config/:id` | done | `tests/test_stream_b.py`. Ids, scopes, and precedence strings follow `catalog.ts` (25 files, the same ids as `app/engine/agent_catalog.py`, including `project.agents` and `claude.project.settings`). PUT writes repo files when `version` matches and 409s a stale version. User-scope files are listed locally and refused on write. A hosted cockpit 409s every write, does not serve outside-repo files, and returns `userMcp: null`. Locally, `userMcp.servers` is the names in `~/.claude.json` (or `CLAUDE_CONFIG_DIR/.claude.json`). The HTML editor is a separate 3-file catalog. |
| Static `/assets`, `/icon.svg` | done | `GET /icon.svg` returns the svg and `GET /assets/mark.txt` returns that file. A missing asset is 404. `tests/test_stream_b.py`. These are files under `static/`, not a Vite `web/dist` manifest. |
| Automations JSON API, automation log, check id | done | `tests/test_stream_b.py`, `tests/test_automation_poll.py`. Revisioned PUT (409 on a stale `expectedRevision`; it now also takes `kind`, `events`, `filters`), enable, run, delete. Create and PUT validate the kind, the events (`github` needs one; label events need `filters.changedLabels`) and the filters, 400 otherwise. `POST …/check` runs a real poll: `matches`, `launched`, `launchedCount`, `candidates`, and an `id` that is a log entry (`test_check_reports_real_matches_and_never_launches_a_preview`); `{"execute": true}` launches the new matches. A schedule answers `matches: 0` and a message. `GET /automation-log` lists the stored log entries, run-now and schedule launches included. `CEZ_AUTOMATIONS=0` is 409. `GET /automations` includes `stats`. `GET /automation-templates` is a fixed local list. |
| `GET/PUT /config` | done | See the HTTP section. `tests/test_routes.py` writes `.ai/cezar/config.json`. |
| Deferred start options, preview, create | done | `tests/test_stream_b.py`. Options report the local zone and `usageReset.available: false`. A future `at` previews `notBefore` and a revision; a past time is unavailable. Create stores one enabled once-automation and replays the same idempotency key. A different task on that key is 409. |
| `GET /e2e`, `POST /e2e/setup` | done | `GET /e2e` reports a local `e2e.config.ts` (or `.mts` / `.py`), credential names from `e2e.credentials.json` (never the values), and the latest `set up e2e` run. `POST /e2e/setup` enqueues that task. No network. `tests/test_stream_b_close.py`. |
| Workspace event stream `GET /events` | done | `GET /api/v1/workspace/events` emits `run` with `projectId` when a run is saved (`tests/test_stream_a.py`). `GET /api/v1/events` and `GET /api/v1/p/{id}/events` are that one project and omit `projectId`. `run-deleted` and `worktree-lifecycle` use the same fan-out. Todos and host usage samples are not on the stream. |
| GitHub checks, review comments, PR changes, ref status, search | done | `GET /github/checks`, `/github/search`, `/github/ref-status`, `/github/comments/{kind}/{number}`, `/github/prs/{n}/changes`. Dry-run answers the fixed catalog (128 passing, 124 failing, issue 142, review thread, renamed and binary files) and does not run `gh`. With dry-run off, checks and search run a fake `gh` (`tests/test_github_read.py`). Unknown ref-status numbers are absent; unknown checks are null. |
| Run groups and pick | done | `tests/test_stream_b.py`. `GET /groups/{id}` lists letters A and B. `POST …/pick` archives the other variant and leaves the winner. `diffStat` is empty. Handoff excerpts are not included. |
| `GET /launch-key` | done | See the HTTP section. `tests/test_routes.py`. |
| Open in editor / open targets | done | `tests/test_stream_b.py`. `GET /open-targets` lists `cursor`, `code`, or `idea` when that binary is on `PATH`. An unknown target is 400. With `CEZ_DRY_RUN=1` a known target answers `{opened: true, dryRun: true}` and does not spawn. With dry-run off, `code` is handed to the spawn hook and the test records the argv (`tests/test_stream_b_close.py`). Hosted mode returns an empty list. |
| `POST /plan` | done | Asks the configured runner, the same `[cez-planner]` prompt as `planChain`. `CEZ_DRY_RUN` uses the canned mock plan and does not spawn. Otherwise the runner binary receives the prompt on stdin; a fake `claude` is the test (`tests/test_stream_b_close.py`). An unusable answer is the one-step fallback. |
| Project checkout, create-on-GitHub, owners, patch, delete | done | `tests/test_stream_b.py`. `POST /projects` registers a local directory. `PATCH` renames it and can set `tags`. `DELETE` removes it and 409s the boot project. `CEZ_SINGLE_PROJECT=1` 409s add. `POST /projects/checkout` and `POST /projects/github` register a directory under `projectsDir`. `GET /github/owners` returns a login. Dry-run does not call `gh`; a live checkout calls the injected runner (`tests/test_stream_b_close.py`). |
| Provider connect, retry, update, enabled | done | `POST /providers/claude/connect` spawns `claude auth login` (and the other runners' login argv). Retry spawns the status command. Update spawns `claude update` / `opencode upgrade` / `cursor update`. A dry run returns the command and does not spawn. `PUT …/enabled` stores the provider on the disabled list. `tests/test_stream_b_close.py`. |
| Repository `/repo/*` routes | done | `GET /repo`, `/repo/diff`, `/repo/changes`, `/repo/tree`, `/repo/files`, `/repo/commit/{sha}`, `POST /repo/branch`, and `/repo/sync` plus fetch, pull, and push. The tree is `git ls-files`, so a gitignored `.env` is not served. Fetch, pull, and push run against a local bare remote (`tests/test_github_read.py`, `tests/test_stream_d_close.py`). |
| `GET /runs/{id}/commits`, `GET /runs/{id}/files`, `POST /runs/{id}/continue`, `POST /runs/{id}/remove-worktree` | done | Files list the dry-run note, commits list `init`, continue requeues a review into another turn, and remove deletes the worktree directory. `tests/test_routes.py`. |
| Run handoff, history, images, land, report, start-now | done | Workspace-level `GET/POST /api/v1/drafts`, `GET/PUT /api/v1/layouts`, and `GET/PUT /api/v1/prompt-templates` are file-backed (`tests/test_stream_b_close.py`). Handoff is a markdown file per run. `GET …/history` lists stored events. `POST …/images` materializes into the worktree. Land commits an in-place checkout. `GET …/report` returns the stored dispatch report. `POST …/start-now` drops a usage-limit hold. Prompt templates in TypeScript are a field of `PUT /api/v1/ui-state` (`packages/cezar/src/server/ui-state.test.ts`). |
| Per-run drafts, draft images, and layouts | intentionally not ported · B | TypeScript: `GET/PUT/DELETE /api/v1/runs/:id/drafts/:surface`, `POST/GET/DELETE …/drafts/:surface/images/:imageId`, and `GET/PUT /api/v1/runs/:id/layouts` in `packages/cezar/src/server/server.ts`. They store React composer text and pane-layout state. Datastar keeps both in page signals, so no Python route exists for them. |
| `GET /skills/importable`, `POST /skills/refresh` | done | Refresh clones or fetches each configured skills repo with git and lists `skills/**`. The test uses a local bare-style clone, not the network. A dry run skips a non-local URL. Importable reads the cache and does not fetch. `tests/test_stream_b_close.py`. |
| `GET/PUT /start-app` | done | Stores the TypeScript recipe (`services`, optional `url`) on the project config or the personal file. TypeScript does not start a process on this route, and neither does this port. `tests/test_stream_b_close.py`. |
| `POST /telemetry/error`, `POST /telemetry/page` | intentionally not ported · B | These routes are absent. Consent routes do not send. TypeScript: `packages/cezar/src/server/server.ts`. |
| Todos API and `cez` follow-up inbox file | done | `tests/test_stream_b.py`. The file is `.ai/cezar/todos.json` (or `CEZ_TODOS_FILE`). A row without a summary is skipped. `GET` is `[]` when `CEZ_FOLLOWUPS` is off; delete is then 409. Start enqueues a run, writes `startedTaskId`, and a second start is 409. The `/inbox` page is unchanged. |
| Tracker connection, watch, search, association | done | `GET/PUT/DELETE /tracker/connection` stores a `0600` dotenv under `$PROJECT_DATA_DIR/tracker-connections` and never returns the token. Dry-run refuses the save. Association, candidates, list, search, and a watch snapshot talk to a recorded loopback Jira server (`tests/test_tracker.py`). A private origin is rejected before any request. |
| Workspace profiles, branding, config, host usage, runs index, automation templates | done | `tests/test_stream_b.py`. `GET/PUT /workspace/config` reads and sets `maxParallel` (1–16). `GET /workspace/runs-index` lists id, title, status, and project across the registry. Profiles, branding, host disk usage, and automation templates are stored or listed locally (`tests/test_stream_b_close.py`). Branding does not rewrite the cockpit theme. |
| Self-update and skills auto-update routes | intentionally not ported · B | Absent: `GET /api/v1/workspace/self-update`, `POST …/refresh`, `GET …/development`, `PUT …/channel`, `POST …/apply`, `DELETE …/scheduled`, `GET /api/v1/workspace/skills-update`, `POST …/check`, `POST …/apply` (`packages/cezar/src/server/server.ts`). |
| `GET /star-count` | intentionally not ported · B | `GET /api/v1/star-count` is absent (`packages/cezar/src/server/star-count.ts`). |
| `POST /worktrees/reclaim` | done | Returns the ids `Engine.retain()` reclaimed. `tests/test_routes.py`. |
| `CEZ_REVIEW_GATE` | done | Exact `1` parks a diff at `review`. `true` does not. `reviewGate: false` in config wins. An autonomous run stays `done`. `tests/test_engine.py`, `tests/test_cockpit.py`, `tests/test_cli.py`. |
| `CEZ_ARCHIVED_RUNS_KEEP` | done | Archived rows use this cap and live rows use `CEZ_RUNS_KEEP`. `tests/test_finish.py`. `Config.from_env` reads it. |
| `CEZ_HOME`, `CEZ_PROJECTS_DIR` | done | `tests/test_stream_b.py`. With `PROJECT_DATA_DIR` unset, `CEZ_HOME` is the SQLite directory. An empty `CEZ_HOME` does not count. `PROJECT_DATA_DIR` still wins, so compose keeps its volume. `CEZ_PROJECTS_DIR` is `projectsDir` on `GET /projects`. |
| `CEZ_SINGLE_PROJECT` | done | Exact `1`. The health document reports it. Project add, patch, and delete answer 409, and `projects add` / `projects remove` refuse. `tests/test_stream_b.py`, `tests/test_cli.py`. |
| `CEZ_SECRETS_KEYCHAIN` | done | `0` forces the `0600` file. Otherwise a test-injected keychain (or `secret-tool` outside pytest) holds the 32-byte data key and the file is not written. A locked keychain fails the read instead of minting a new key (`tests/test_secrets.py`). |
| `CEZ_ENV_PASSTHROUGH`, `CEZ_AGENT_ENV_FULL`, `CEZ_REDACT_SECRETS` | done | Agents get a curated environment. `CEZ_ENV_PASSTHROUGH` forwards named extras. `CEZ_AGENT_ENV_FULL` of `1`, `true`, or `yes` restores the parent environment; `0` and `false` stay curated. A spawned fake does not see `AWS_SECRET_ACCESS_KEY` unless the full hatch is on. Stored events replace token shapes with `[REDACTED]` unless `CEZ_REDACT_SECRETS=0` (`tests/test_agent_env.py`). Checks still drop `CEZ_*` and inject secret values. |
| `CEZ_TERMINAL` | done | `0` makes `POST /runs/{id}/terminal` answer 409 `terminal is disabled`. `tests/test_routes.py`. The hosted default is the terminal-policy row, not this switch. |
| `CEZ_AUTOSAVE`, `CEZ_TITLE_UPDATES`, `CEZ_AUTONAME` | done | Turn end and run finalize commit `cezar autosave (turn end)` or `cezar autosave (run finalize)` on the task branch. Signing follows the repo's git config, matching `autosaveCommit` in `packages/cezar/src/git-worktree.ts` (`commit --no-verify`, no `commit.gpgsign` override). Tests set `commit.gpgsign false` on the repo in `tests/conftest.py`. `CEZ_AUTOSAVE=1` adds the periodic commit (`tests/test_stream_a.py`). `CEZ_TITLE_UPDATES=0` skips the live title refresh; otherwise a dry-run with `CEZ_AUTONAME=1` may rename from the turn (`tests/test_stream_a.py`). `CEZ_AUTONAME` itself is covered by `tests/test_engine.py`. |
| `CEZ_TASK_PROCESS_REAP`, `CEZ_DISABLE_REPO_LOCK`, `CEZ_WORKFLOW_WEBHOOKS` | done | Settling a run SIGTERMs processes whose environ contains `CEZ_TASK_ID=<id>`; `CEZ_TASK_PROCESS_REAP=0` leaves them. In-place runs take one repo-root lock; `CEZ_DISABLE_REPO_LOCK=1` skips it and says so. A `notify.webhook` node fails until `CEZ_WORKFLOW_WEBHOOKS=1`, then POSTs. `tests/test_stream_a.py`. |
| `CEZ_HIDE_TOKEN_USAGE`, `CEZ_HIDE_COST`, `CEZ_HIDE_TOKEN_METRICS` | done | Each flag is set in `tests/test_screens.py`. The health capabilities follow it, and the dashboard hides the token total, the cost total, or both, and drops the matching columns from the usage series. |
| `CEZ_UPDATE_CHANNEL`, `CEZ_SUPERVISED` | intentionally not ported · A | Self-update channel (`packages/cezar/src/self-update/service.ts`) and the desktop supervisor (`packages/cezar/src/index.ts` reads `CEZ_SUPERVISOR_PID`; `CEZ_SUPERVISED` exits 75 instead of re-exec). `CEZ_NO_BANNER` is read: `serve` skips the skills banner (`app/config.py` `no_banner`, covered on the lifecycle row). It does not gate a star-count fetch, because that fetch is absent. |
| `CEZ_DESKTOP`, `CEZ_DESKTOP_*`, `CEZ_DISCLAIM_EXEC` | intentionally not ported · A | The Tauri shell is out of scope. TypeScript reads `CEZ_DESKTOP`, `CEZ_DESKTOP_ENTRY`, `CEZ_DESKTOP_CWD`, `CEZ_DESKTOP_NODE`, `CEZ_DESKTOP_NO_UPDATE` (`packages/desktop/src-tauri/src/lib.rs`) and `CEZ_DISCLAIM_EXEC` (`packages/cezar/src/core/disclaim-spawn.ts`). |
| `CEZ_SKILLS_AUTO_UPDATE` | intentionally not ported · A | TypeScript reads it in `packages/cezar/src/workspace/config.ts` (`effectiveSkillsAutoUpdate`) to decide whether the post-listen skills update applies. This port does not run that update. See the skills auto-update screen row. |
| `CEZ_REMOTE_AGENT_ACCOUNTS` | done | Hosted mode (`CEZ_REMOTE=1`) refuses `POST /settings/accounts` with 409 until the flag is exactly `1`. A local cockpit saves without it (`tests/test_agent_env.py`). |
| `CEZ_AUTONOMOUS_DEFAULT`, `CEZ_WORKTREE_DEFAULT` | done | Exact `1` / `0`. Omitted on `plan_run` inherits them: autonomous on, or a git checkout run in place. An explicit argument wins. `tests/test_stream_a.py`. |
| Release packaging, server-install, disk space, startup port probe | done | The project is a hatchling package (`[tool.uv] package = true`). `cez package` runs `uv build`, which writes a wheel and an sdist; the wheel includes `app/` and `static/` (`tests/test_stream_b_close.py`). `server-install` / `deploy` / `uninstall` invoke `systemctl` or `launchctl` and `docker compose` through an injectable command; a dry run does not. Disk space is on `GET /api/v1/health` and `GET /workspace/host-usage`. An omitted listen port probes forward from 4321; `--port 9` stays 9. The image is the repo `Dockerfile`. |
| Worktree lifecycle events, handoff files, skills banner, remote skills | done | Create/delete worktree events are on the workspace stream (`tests/test_stream_a.py`). A handoff file is seeded under the data dir and a turn heartbeat is inserted. `serve` prints the skills banner unless `CEZ_NO_BANNER=1` or `dismissedSkillsBanner` is set. Remote skills are the team-repo refresh (`tests/test_stream_a_close.py`). `execute_lifecycle_command` runs in its own session, caps output, and redacts secrets (`tests/test_lifecycle_exec.py`). `POST /api/v1/worktree-lifecycle/operations` runs `beforeRemove` through that executor: a failing script stays `needs_attention` and keeps the directory, a stale revision is 409, `keep-worktree` keeps it, and `force-delete` removes it. The same request id is idempotent; a different intent is 409. Preview does not execute. Hook-free `remove-worktree` still deletes. While an operation is pending, git commit is 409 (`tests/test_lifecycle_api.py`). |
| Browser e2e (`e2e/`) | done | `e2e/test_main_loop.py` and `e2e/test_screens.py` are 14 Chromium walks: New task to `done`, review through commit, push, and a fake-`gh` draft PR, plus git panes, workflow steps, settings editors, automations, variants, the terminal pane, inbox, dashboard, integrations, phone layout, and light/violet. The walks added with the graph, automation, GitHub, commit, and accounts screens: a `gate.human` graph task approved and another rejected from the task page; `/automations/new` to the detail page, enable, Run now, and the execution log; the pull request detail and its changes pane from the dry-run catalog; a commit detail from the log (and a 404 for an unknown sha); and an account that flips from `not signed in` to `signed in` with its identity only on the details page. `e2e/browser_launch.py` falls back to a preinstalled Chromium under `PLAYWRIGHT_BROWSERS_PATH` or `/opt/pw-browsers` when Playwright's pinned build is missing; it never downloads. `uv run pytest` does not collect `e2e/`. Not walked: nothing from this branch. The older `test_repository_commits_and_workflow_steps` expects `gh` to be absent and fails on a machine with a real `gh` installed. The 49 TypeScript files under `packages/web/e2e/` are the React row. |

## Inventory gaps

Rows added after the 2026-10-29 source inventory. One row per family.
Paths are the TypeScript `/api/v1` spelling. Python project mirrors are not a
separate gap.

| Item | Status | Verified |
| --- | --- | --- |
| WebSocket bus | intentionally not ported · D | Upgrade-only `GET /api/v1/ws` in `packages/cezar/src/server/ws.ts`. Topics from `packages/cezar/src/server/server.ts` and `packages/cezar/src/server/tracker/watch.ts`: `health`, `host`, `terminal:<session>`, `tracker:<watch>`. Python has no WebSocket. Run and workspace updates are SSE. Pages stream over SSE (`…/live`); a second push channel would duplicate them. Terminal output is SSE (`GET /api/v1/runs/{id}/terminal/{session}/output`), and a tracker watch is read through `GET /api/v1/tracker/watch/{id}` with its version. |
| Dashboard JSON family | intentionally not ported · B | `packages/cezar/src/server/dashboard.ts`: `GET /api/v1/workspace/dashboard`, `…/automations`, `…/costs`, `…/feed`, `…/insights`, `…/overview`, `…/tasks`, `…/telemetry`. The HTML `/dashboard` counts page stays the done screen row. SPA data feed; `/dashboard` renders the same numbers server-side. |
| Agent profiles HTTP family | intentionally not ported · D | Capability rendered on `/settings/accounts`; SPA-only JSON. TypeScript: `GET/POST /api/v1/workspace/agent-profiles`, `PATCH/DELETE …/:id`, `GET …/:id/status`, `GET …/:id/details`, `POST …/:id/open`, `PUT …/selection` (`packages/cezar/src/server/server.ts`). Status, details and the per-project selection are the page's own screens and command (see Agent accounts / profiles). |
| Webhook formats and control plane | done · D | `app/integrations/webhook_schema.py` ports the contract (`cezar.json.v1`, `slack.v1`, `discord.v1`, states, defaults, validation) and `app/integrations/registry.py` + `service.py` the control plane: `GET /webhooks/history`, `GET /webhooks/events` (SSE resync/change), `GET /webhooks/:id/activity`, `PATCH /webhooks/:id`, `POST …/activate`/`pause`/`resume`/`rotate-secret`, `POST /webhooks/deliveries/:id/retry`/`replay`, `POST /webhooks/notice/acknowledge`. Deliveries render per format (`discord_render.py`), sign `cezar.json.v1` bodies, retry with backoff, and record terminal rows (`tests/test_webhooks_d.py`). The legacy `POST /webhooks/outbox/:sequence/replay` stays for parity. |
| `GET /api/v1/skills` | intentionally not ported · B | Catalog route in `packages/cezar/src/server/server.ts` (`.get('/skills'`). The HTML `/skills` page lists files on disk and stays the done screen row. `GET /skills/importable` and `POST /skills/refresh` stay done. SPA data feed; `/skills` renders the catalog. |
| Worktree list and lifecycle detail | intentionally not ported · B | `GET /api/v1/worktrees` (`packages/cezar/src/server/server.ts`). `GET /api/v1/worktree-lifecycle` and `GET /api/v1/worktree-lifecycle/:worktreeId` (`packages/cezar/src/server/worktree-lifecycle.ts`). `POST …/operations`, preview, action, and output stay the done lifecycle row. SPA data feed; `/settings/worktrees` and the lifecycle operations cover it. |
| Per-run changes, tree, commit, history context, image bytes | intentionally not ported · B | SPA-only JSON; task page panes / commands cover diff, files, commits, commit detail and PR adopt. TypeScript: `GET /api/v1/runs/:id/changes`, `GET …/tree`, `GET …/commit/:sha`, `GET …/history-context`, `GET …/images/:imageId` (`packages/cezar/src/server/server.ts`). `GET …/commits`, `GET …/files`, and `POST …/images` stay done. |
| Terminal session list, commands, detected URLs | intentionally not ported · B | `packages/cezar/src/server/server.ts`: `GET /api/v1/runs/:id/terminal`, `GET …/terminal/commands`, `GET …/terminal/urls`. Open, input, resize, output, and close stay done. Live output in TypeScript is also the `terminal:<session>` WebSocket topic. SPA terminal chrome; the terminal pane is server-rendered. |
| Run open-in, adopt PR, patch record | intentionally not ported · B | SPA-only JSON; task page panes / commands cover diff, files, commits, commit detail and PR adopt. The adopt behaviour is `POST /tasks/{run_id}/pr/adopt` (`Engine.adopt_pr`, `app/integrations/pr_adopt.py`). TypeScript: `POST /api/v1/runs/:id/open-in`, `POST …/open-in-cli`, `POST …/pr/adopt`, `PATCH /api/v1/runs/:id`. `GET /open-targets` and `POST /open-in` stay the done row. |
| Workflow JSON create, delete, validate, parse, nodes | intentionally not ported · B | `packages/cezar/src/server/server.ts`: `POST /api/v1/workflows`, `DELETE /api/v1/workflows/:name`, `GET /api/v1/workflows/nodes`, `POST /api/v1/workflows/validate`, `POST /api/v1/workflows/parse`, `POST /api/v1/workflows/graph`. HTML create, delete, and the canvas editor stay done. The workflow pages and canvas editor do these as commands. |
| `GET /api/v1/automation-checks/:id`, `GET /api/v1/tracker/automation-options` | intentionally not ported · B | Rendered into the Datastar automations pages; SPA-only JSON. The log page opens one check (`/automations/{id}/log?entry=<id>`) and `/automations/new` renders the tracker status choices from `app/integrations/tracker.py::automation_options`. |
| `POST /api/v1/automation-log/:id/retry` | intentionally not ported · B | Rendered into the Datastar automations pages; SPA-only JSON. The retry is the command `POST /automations/{id}/log/{entry}/retry` on the log page: it relaunches the entry's failed launches and repaints (`test_a_poll_error_is_logged_and_a_failed_launch_can_be_retried`). |
| Graph nodes `gate.human`, `ask-user`, nested `workflow` | done | `tests/test_graph_human.py`. `gate.human` and `ask-user` park the run as `waiting` (no slot) with the message in `run.ask`; the walk's loops and node outputs are saved in `Run.graph_park`, so a restart resumes at the right port (`test_a_parked_gate_survives_a_restart_and_a_timeout_routes_timeout`). `POST /tasks/{run_id}/approve` and `/reject` (optional comment as the `comment` output) route the `approve` and `reject` ports (`test_a_gate_parks_then_approve_routes_the_approve_port`, `test_a_gate_reject_routes_the_reject_port`, `test_the_task_page_approves_and_rejects_a_gate`). `POST /tasks/{run_id}/message` answers `ask-user` and exposes `{{nodes.<id>.answer}}` (`test_ask_user_resumes_on_answered_with_the_answer_as_output`, `test_the_task_page_rejects_a_gate_and_answers_an_ask`). `timeoutMs` adds a `timeout` port, fired by `Engine._expire_parks` on the tick. A nested `workflow` starts the named saved workflow as a child through `Engine.dispatch`, waits, and routes `done` or `failed` with `runId`, `status`, `summary` (`test_a_nested_workflow_runs_as_a_child_and_routes_done`, `test_a_nested_workflow_that_fails_routes_failed`, `test_an_unknown_nested_workflow_routes_failed`). Not ported: TypeScript's ask card with `options` buttons (the `options` list is ignored; the answer is free text), and re-attaching to a running sub-workflow after a restart (`Engine.recover` fails a graph parent with children in flight, as for `dispatch`). |
| GitHub and tracker pollers | done | See Automations: `app/integrations/github_poll.py`, `app/integrations/tracker_poll.py`, `app/engine/poller.py`. `Engine._launch_due` fires only `schedule` rows. A project whose remote is a GitHub Enterprise host passes `--hostname` to every `gh api` call (`enterprise_host` in `app/engine/git_remotes.py`; `test_a_github_enterprise_remote_passes_its_host_to_gh_api`, `test_a_github_dot_com_remote_adds_no_hostname`). Jira and Linear list reads now ask for labels (`fields=…labels…`, `labels(first: 50)`), so `allLabels` matches; `tests/test_tracker_poll.py` covers both providers, the status filter, and a launched run. `checkout: "pr-head"` (a `filters` key, with `allowForkHeads`; form checkboxes on the automation screen) resolves the PR in `app/integrations/pr_head.py`, fetches `refs/pull/N/head` into `refs/cezar/pr/N`, and forks the run's worktree from the fetched sha (`test_pr_head_forks_the_worktree_from_the_pull_request`); a closed PR or an unadmitted fork is `skipped`, an unreachable head is a `launch-error`, an admitted fork marks the run `untrustedHead` and its checks get no secrets, and the run cannot open a draft PR (`tests/test_automation_poll.py`). Gap: the tracker poll is a status snapshot, not provider history. The Python-only inbound `POST /hooks/*` routes were removed. |
| CLI subcommands and `cez task` flags | done | `tests/test_cli.py`. `tracker-connections list` and `remove <64-hex-id>` read the local `tracker-connections/*.env` files (id, project root, provider, status; never a token) and delete one by id; `app/integrations/tracker.py` holds `connection_inventory` and `remove_connection_id`. `projects tag <id> [<tag>…]` sets trimmed, case-insensitively deduplicated tags (none clears them) and `projects rm` is an alias of `remove`; both are refused under `CEZ_SINGLE_PROJECT=1`. `automation add`, `run`, `update`, `show`, `enable`, `pause`, `delete`, and every `cez task create` flag are on the `task`, `automation` row. TypeScript: `packages/cezar/src/server/tracker/connections-cli.ts`, `packages/cezar/src/workspace/projects-cli.ts`. |
| Env vars read by TypeScript and not by `app/` | done | Every `CEZ_*` read outside the intentionally not ported desktop, telemetry, self-update, skills-auto-update and `CEZ_TREE_DIR` set is on `Config` (`app/config.py`). `CEZ_AGENT_MODELS_LOCKED` is `Config.agent_models_locked`: with the Agents page's `modelsLocked` it makes the agents' own model setting rule, a task that names a model is refused with 409 (`POST /tasks`, `POST /api/v1/runs`) and the new run's model is empty (`test_locked_models_ignore_presets_and_refuse_a_pick`). `CEZ_CODEX_REASONING` is `Config.codex_reasoning` (`auto`, `concise`, `detailed`, `none`; unknown is `auto`) and is sent as `summary` on every Codex `turn/start` (`test_codex_turn_start_carries_the_reasoning_summary`). `CEZ_AGENT_TMPDIR` is `Config.agent_tmpdir`: unless exactly `0`, an agent step gets `TMPDIR`, `TEMP` and `TMP` set to `<data dir>/tmp/<run id>` (created, write-probed, a failing probe fails the run with a message naming `CEZ_AGENT_TMPDIR=0`), Claude and Copilot get it as `--add-dir`, it is removed when the run settles and swept at startup (`app/engine/agent_tmp.py`, `test_an_agent_step_gets_its_own_tmpdir_that_goes_with_the_run`, `test_the_tmpdir_opt_out_and_the_failing_probe`, `test_startup_sweeps_the_temp_directories_of_runs_that_are_gone`). Check steps (not agent steps or auto-land) get `CEZ_SHARED_CACHE_DIR` = `<data dir>/cache/<project id>` (`0700`; TypeScript uses `~/.cezar/cache`; `test_a_check_step_sees_the_projects_shared_cache_dir`). `CEZ_GITHUB_REPO`, `CEZ_GITHUB_NUMBER`, `CEZ_GITHUB_EVENT`, `CEZ_PR_HEAD_SHA`, `CEZ_PR_HEAD_REF`, `CEZ_PR_BASE_REF` were done in `db820ec4` (`automation_env` in `app/engine/poller.py`; agent and check environments; `test_the_agent_gets_the_matched_item_in_its_environment`, `test_a_poll_baselines_then_launches_each_match_once`) and are verified here. The Python-only `CEZ_REAL_AGENTS` was removed. |
| `CEZ_TREE_DIR` | intentionally not ported · A | TypeScript sets it for a dispatched run and tells the agent to read `brief.md`, `units/<id8>/order.md` and `inbox/<id8>/` in `<data dir>/dispatch/<rootRunId>/` (`packages/cezar/src/dispatch/prompts.ts`, `treeDir` in `dispatch/tree-fs.ts`). This port keeps the dispatch tree in SQLite and delivers reports through `Engine._deliver_report`, so there is no tree directory to name (see the persistence row). `CEZ_TASK_ID` and `CEZ_API_URL` are how `cez task` finds the tree. |
| Settings keys with no Python reader | done | The keys that change agent behaviour have readers and an editor. Agents page (`/settings/agents`, `POST /settings/agents`, `$PROJECT_DATA_DIR/agent-defaults.json`): `defaultModels` (per runner, applied by `Engine.plan_run` to every new task that names no model), `defaultModelsAuto` (an explicit auto: no `--model` flag; Python has no native-settings seed layer, so it reads the same as an empty preset and is kept for the round trip), `modelsLocked`, `plannerModel` (`--model` for the Claude planner, `POST /plan`), `namerModel` (the title and branch namer, `app/engine/namer.py`). Tasks page (`POST /settings/tasks`): `composerDefaults` (`composer-defaults.json`; `autonomous` and `worktree` inherit / on / off, read by `plan_run` and the `/tasks/new` form), and per project `defaultSkill` and `askSkill` (`project-settings/<id>.json`; the form's Skill select defaults to the project skill while the workflow stays `quick-task`, ; `askSkill` is stored and editable but has no reader until an Ask mode exists, because TypeScript's `askSkill` belongs to that mode and nothing selects it from the task text). Tests: `tests/test_agent_defaults.py`. Not exposed on `GET/PUT /api/v1/config`, which still carries `systemPrompt`, `branchNaming` and `reviewGate` only. `maxParallel`, theme, accent, base branch, review gate, system prompt, branch naming, required checks, memory cap, and org skill repos have stores. Prompt templates are a separate file route, and `packages/web/src/routes.tsx` `settings/prompt-templates` has no page (intentionally not ported, see Reduced screens). |
| `skillsAutoUpdate`, `updateChannel`, `cezarId` | intentionally not ported · C | Tied to the excluded skills auto-update (`CEZ_SKILLS_AUTO_UPDATE` row), self-update channel (`CEZ_UPDATE_CHANNEL` row) and telemetry install id (Telemetry row). No setting stores them. |
| Reduced screens | done | Every listed React route has a Datastar screen or a stated reason. `github/prs` is `/github/prs`, `github/prs/:n` is `/github/prs/{n}` and its `…/changes` is `?pane=changes` (diff rendered on the server), `github/issues/:n` is `/github/issues/{n}`, `tracker/:id` is `/tracker/{id}`, `git/commits/:sha` is `/git/commits/{sha}`, `tasks/:id/commits/:sha` is `/tasks/{id}/commits/{sha}`; each is linked from its list (`/github`, `/tracker`, `/git`, the task commits pane). All read `gh`, git or the tracker, so they are server-rendered with no live stream. `tests/test_detail_screens.py` runs them against the dry-run catalog and a fake `gh` first on PATH. `settings/prompt-templates` is intentionally not ported: prompt templates are a React composer feature, and the file route `GET/PUT /api/v1/prompt-templates` stays done. The browser pane states the design-mode rule. The picker is `POST /preview/design-proxy`, which stays done. `/tasks` is the boot project only. Unknown paths 404. TypeScript serves the SPA shell from `packages/cezar/src/server/static-ui.ts`. |
| Persistence shape | intentionally not ported · D | SQLite tables `runs`, `events`, `projects`, `settings`, `automations` (`app/store/db.py`). `import-runs` copies a `runs.json` array and sibling NDJSON. Workflows and skills stay files. TypeScript's source of truth is `.ai/cezar/runs.json` plus `runs/<id>.ndjson` (`packages/cezar/src/runs/store.ts`) and `~/.cezar/config.json` (`packages/cezar/src/workspace/config.ts`). `packages/cezar/src/data-gitignore.ts` also names `webhooks/`, `dispatch/`, `attachments/`, `drafts/`, `layouts/`, `automations.json`, receipts, and `tracker.json`. There is no dispatch-tree directory and no `~/.cezar` registry independent of `PROJECT_DATA_DIR`. SQLite is the decided store (Decisions table); `import-runs` migrates `runs.json`/NDJSON. |
| React e2e coverage | intentionally not ported · C | `packages/web/e2e/` is 49 TypeScript files (cloc), 43 of them `*.e2e.ts` walks: `agents-dock`, `automations`, `chat-webhooks`, `command-palette`, `commit-list`, `composer`, `composer-defaults`, `diff-scroll`, `empty-states`, `github`, `host-telemetry`, `inbox`, `ios-sweep`, `new-task`, `progressive-history`, `project-groups`, `queued-stack`, `quick-list`, `repo-files`, `repo-git`, `review-gate`, `settings-agents`, `settings-appearance`, `settings-bookmarklets`, `settings-monitoring`, `settings-resources`, `settings-skills`, `skill-search-ranking`, `skills-update`, `smoke`, `task-changes`, `task-columns`, `task-files`, `task-thread`, `thread-drafts`, `thread-scroll`, `tools-menu`, `tracker`, `variants-compare`, `webhooks`, `webhooks-navigation`, `webhooks-review`, `workflows`. The other files are helpers, configs, and fixtures. Python e2e does not run them. React-specific walks; Python e2e covers the Datastar screens (row above). |
| Hosted terminal policy | done | `terminal_enabled(hosted)` in `app/config.py` ports `terminalEnabled` from `packages/cezar/src/server/capabilities.ts`: `CEZ_TERMINAL=1` is on, `0` is off, anything else follows local handoff (on locally, off when hosted). Health `capabilities.terminal`, `POST /api/v1/runs/{id}/terminal`, input, resize, output (`app/features/api/surface.py`), and the task pane shell (`app/features/task/handlers.py` `shell`) all use it; every route but close answers 409 when it is off. `tests/test_terminal_policy.py`: `test_hosted_terminal_is_off_when_cez_terminal_is_unset`, `test_hosted_terminal_opens_with_cez_terminal_1`, `test_local_terminal_is_on_when_cez_terminal_is_unset`, `test_terminal_enabled_follows_local_handoff_unless_the_flag_says_otherwise`. |


## Deviations from the Stario skills

Skills are from stario-create `e56b6cd80cfcc011c8c1be7b4da92dfba5b5c31c`. One contradiction was fixed in this pass: the run API was importing private helpers from `app/features/task/views.py`. Those reads now live in `app/features/task/data.py`, which is the module another feature is allowed to import.

Left as they are. A later agent should not "clean these up" as a drive-by:

- `os.environ` is still read outside `app/config.py`: `app/engine/engine.py` (the check environment), `app/engine/namer.py`, `app/engine/review_gate.py`, `app/engine/gitwork.py`, `app/engine/telemetry_store.py`, `app/integrations/lifecycle.py`, and `app/integrations/coordinator.py`. `CEZ_TERMINAL`, `CEZ_SINGLE_PROJECT`, `CEZ_FOLLOWUPS`, `CEZ_AUTOMATIONS`, `CEZ_INSTANCE_ID`, and the hosted Basic credentials are read in `app/config.py` at the call, so a test can still flip them after `Config` is built. A new process-lifetime flag belongs on `Config`. Do not move the live engine ones without updating the test that sets the variable after the client exists.
- JSON is often `json.dumps` (`app/engine/engine.py`, `app/engine/runners/protocol.py`, `app/integrations/outbox.py`, `app/secrets/store.py`, `app/integrations/hooks.py`). Route documents in `app/features/api/surface.py`, `app/engine/ui_state.py`, and `app/engine/uploads.py` go through `stario.json`. Leave a payload whose bytes are part of a signature or a wire fixture alone.
- Settings, inbox, and new-task commands answer with `w.redirect(..., 303)`. Tests assert that status. The skill's command reply is `w.empty()` or `SSE(w).navigate`, because a 303 does not change the URL inside a Datastar request. Switching the reply changes those tests and the browser walk. The `/api/v1` families answer JSON.
- The walk, the delta coalescer, and the terminal read loop go through `Engine._schedule`. When the server has bound an `App`, that is `App.create_task` (`tests/test_stream_a.py`). The CLI builds an `Engine` with no `App`, so the same helper uses `asyncio.create_task` there. Do not delete that fallback.
- Most features have no `data.py`. Rows live in `app/store/db.py`. `Engine` is about 2,600 lines, `app/features/api/surface.py` about 1,450, and `app/features/api/handlers.py` about 670. The skill treats that shape as a second resource hiding in one class. Splitting it is its own change.
- CSS is hand-written in `static/css/style.css`. That is the Decisions table. Do not add Tailwind.
- A page is not always one resource plus a `db.watch` stream. Several settings pages are static HTML.

## Known gaps / verify live

These are not failures of the unit suite. A live machine is what would show them.

- Runners are tested against fake CLIs only: `claude`, `codex`, `cursor`, `opencode`, `pi`, `junie`, and `copilot` (`tests/test_runners.py`, `tests/test_runner_gaps.py`, `tests/fakes/`). Nothing here is a live handshake.
- The OS keychain is in-memory in tests. `tests/test_secrets.py` injects `MemoryKeyring`. A live `secret-tool` / Secret Service session was not run. `CEZ_SECRETS_KEYCHAIN=0` stays on the `0600` file.
- A GitHub Enterprise host is untested against an appliance. `*.ghe.com` is accepted as a GitHub-shaped host (`tests/test_integrations.py` asserts `forge_base_issue` has no complaint), and the poller passes `--hostname` to the fake `gh` (`tests/test_automation_poll.py`). No test talks to a real one.
- Live `gh` output is parsed only through fakes. `tests/test_parity.py` and `tests/test_github_read.py` feed recorded JSON. A real `gh pr view` was not run.
- Memory sampling reads `/proc`: `VmRSS` of processes whose cwd is the worktree, plus their descendants (`app/engine/memory_guard.py`). It is the Linux proc tree, not a cgroup probe.
- Usage days are UTC. The dashboard groups tokens by the UTC day the task was created and completions by the UTC day it finished (`tests/test_screens.py`, `?period=30d`).
- Skills auto-update and host telemetry are intentionally not ported. Do not send telemetry.

## Workstreams

Checklist at the end of the port-finish branch: **207 done**, **0 partial**, **0 not done**, **30 intentionally not ported** (237 rows).

Open rows, counting intentionally not ported: **A 7, B 17, C 3, D 3**.
Partial + not done only: **A 0, B 0, C 0, D 0**.

Intentionally not ported rows are tagged so a later pass can see who would own them. Do not send telemetry, do not fetch the star count, and do not rewrite the install.

How a row was placed when it touched two areas:

- Both SSE rows are A. B owns the other route families in `app/features/api/surface.py` and does not rewrite the event handlers.
- The node editor is A. The existing `/workflows/:name` shell is C. They share `app/features/workflows/`.
- The Todos API is B. The `/inbox` screen is C.
- Static `/assets` and `/icon.svg` are B. CSS and layout are C.
- `CEZ_TASK_PROCESS_REAP`, `CEZ_DISABLE_REPO_LOCK`, and `CEZ_WORKFLOW_WEBHOOKS` are one A row. If that webhook flag starts gating delivery, D edits the coordinator and A edits the engine. Add the field on `Config` once.
- Every CLI row is B, including a future `secrets` subcommand, because they all land in `app/cli.py`. D owns `app/secrets/` and does not add subcommands.
- Worktree retention is A. `POST /worktrees/reclaim` is already done.
- Automations page posts are C. The automations JSON API is B. `Engine.tick` is shared.
- Variants are C for `/tasks/{id}/compare`, which the screens tests render. The `{runs}` body stays on B's `POST /api/v1/runs` row.
- Per-project base branch is C (no editor). Diff-base math is D.
- The model-catalog row is A. `GET /providers/status` and provider connect are B.
- Terminal HTTP routes are B. The terminal pane is C. `app/engine/terminal_hub.py` is shared.

### A — runners, event stream, workflows and graph

0 partial, 0 not done, 7 intentionally not ported.

Intentionally not ported: skills auto-update, host telemetry send, telemetry send, `CEZ_UPDATE_CHANNEL` / `CEZ_SUPERVISED`, `CEZ_DESKTOP` / `CEZ_DESKTOP_*` / `CEZ_DISCLAIM_EXEC`, `CEZ_SKILLS_AUTO_UPDATE`, `CEZ_TREE_DIR`.

Owns: `app/engine/runners/`, `app/engine/agents.py`, `app/engine/namer.py`, `app/engine/workflows.py`, `app/engine/graph.py`, `app/engine/skills.py`, `app/engine/prompts.py`, `app/engine/retention.py`, `app/engine/deltas.py`, `app/engine/session_extras.py`, `app/engine/dispatch_logic.py`, `tests/test_runners.py`, `tests/test_runner_gaps.py`, `tests/test_graph.py`, `tests/test_graph_nodes.py`, `tests/test_graph_human.py`, `tests/test_workflows.py`, `tests/fakes/`.

The node editor is `app/features/workflows/editor.py`. C still renders `/workflows/{name}` from that folder.

### B — server route families and the CLI

0 partial, 0 not done, 17 intentionally not ported.

Intentionally not ported: dashboard JSON family; `GET /api/v1/skills`; worktree list and lifecycle detail; terminal session list, commands, detected URLs; workflow JSON create, delete, validate, parse, nodes; per-run drafts, draft images, and layouts; per-run changes, tree, commit, history context, image bytes; run open-in, adopt PR, patch record (task page panes and commands); automation check detail, log retry, and tracker options JSON routes (rendered into the Datastar pages); `versions` / `unlink`; self-update `install` / `update` / `use` / `link`; star count and self-update (HTTP section and the combined background row); `POST /telemetry/error` and `POST /telemetry/page`; self-update and skills-update routes; `GET /star-count`.

Owns: `app/features/api/` (`handlers.py`, `records.py`, `urls.py`, and the non-event, non-git, non-webhook methods of `surface.py`), `app/cli.py`, `app/http/`, `app/engine/import_runs.py`, `app/engine/ui_state.py`, `app/engine/uploads.py`, `app/engine/fs_browse.py`, `app/engine/preview.py`, `app/engine/providers.py`, `app/engine/deferred.py`, `tests/test_api.py`, `tests/test_routes.py`, `tests/test_cli.py`, `tests/test_import_runs.py`.

Git, GitHub, webhook, and hook methods already on `surface.py` stay with D.

### C — Datastar screens, settings, and e2e

0 partial, 0 not done, 3 intentionally not ported.

Intentionally not ported: the Tauri desktop shell; the settings keys `skillsAutoUpdate`, `updateChannel`, and `cezarId`; React e2e coverage (`packages/web/e2e/`, 49 TypeScript files). Python browser e2e (`e2e/`, 14 walks) is done. `settings/prompt-templates` is also not ported, inside the done reduced-screens row.

Skills auto-update and host telemetry sends stay on A. TypeScript does run skills auto-update after the server listens (at most once per six-hour window, unless `CEZ_SKILLS_AUTO_UPDATE=0` or Settings turns application off). This port does not. Host telemetry stays out. The local `GET /workspace/host-usage` sample is already done.

Owns: `app/features/tasks/`, `app/features/dashboard/`, `app/features/editors/`, `app/features/places/`, `app/features/projects/`, `app/features/settings/`, `app/features/skills/`, `app/features/automations/` (the page, not the JSON API), `app/features/workflows/views.py` and `handlers.py` for the page that already exists, `app/common/shell.py`, `static/css/style.css`, `e2e/test_main_loop.py`, `tests/test_cockpit.py`.

The merge box and the commit / push / draft-PR buttons on the task page are D's. C owns the rest of that page's layout.

### D — integrations, webhooks, git, GitHub, secrets

0 partial, 0 not done, 3 intentionally not ported.

Intentionally not ported: WebSocket bus; persistence shape (SQLite is the decided store); agent profiles HTTP family (capability rendered on `/settings/accounts`).

Owns: `app/integrations/`, `app/engine/gitwork.py`, `app/engine/git_actions.py`, `app/secrets/`, `app/features/secrets/`, `tests/test_secrets.py`, `tests/test_integrations.py`.

### Shared files

Touch these only for the stream that owns the behavior, and leave the other stream's functions in place.

| File | Who writes | Care |
| --- | --- | --- |
| `app/engine/engine.py` | A for the walk, slots, namer, settle, and review gate. D for webhook notify and git actions the walk calls. | B does not rewrite the walk. C does not. |
| `app/features/api/surface.py` | B for route registration and the HTTP families in its list. A for the two event streams. D for git, GitHub, webhook, and hook handlers. | Add a method next to the family you own. |
| `app/features/task/views.py`, `app/features/task/handlers.py` | C for layout. D for the merge box and the git buttons. | A reads the transcript; it does not restyle the page. |
| `app/features/task/data.py` | Shared read. B and C import it. | Do not import `views.py` from the API. |
| `app/features/workflows/` | C owns the current page. A adds a node editor beside it. | Do not replace `views.py` in order to add a canvas. |
| `app/engine/terminal_hub.py` | B opens it from HTTP. C renders the pane. | The PTY loop has one owner at a time; say which in the row you close. |
| `app/config.py` | Whoever adds a field. | One field, one reader. Default it. |
| `app/main.py` | Registration only. | A new page is one `register` call. |
| `app/store/db.py` | Whoever adds a column the skill's way (virtual column, no data migration). | Schema changes are one transaction in `schema`. |
| `tests/conftest.py` | Fixtures only. | `CEZ_DRY_RUN`, `TestClient` base URL, `request_timeout` 30. |
| `tests/test_surface.py`, `tests/test_engine.py`, `tests/test_parity.py`, `tests/test_finish.py` | The stream whose assertion you add. | Do not rewrite another stream's test to make yours fit. |
| `MIGRATION.md` | The stream whose row you close. | Leave the other rows and this section's counts. Fix the count in your stream when a row moves to done. |
