# Unreleased

## ✨ Features
- ✨ **Continue a task on another agent account, not just another agent.** The thread's Continue
  carried a runner pill that could switch `claude → codex` but never offered the second Claude
  login the new-task composer has offered since accounts landed — so "finish this one on my other
  account" was sayable only when a task was created. It is the same flat control now, in both
  places: `claude · Default`, `claude · Klaudiusz`, `codex` — one row per thing that can actually
  run the work, each naming the folder it resolves to. The row selected until you pick another is
  the account this run is ON (the step that spawned recorded it), not the project's current
  setting, so switching a project's account never relabels work it did not do. Picking another
  login starts a fresh session rather than resuming: a session id only resolves inside the config
  dir that created it, and `claude --resume` under a different login would silently open an empty
  conversation. A host with one agent and one login sees exactly the composer it always saw.
  `POST /api/v1/runs/:id/continue` gained an optional `agentProfile`; an id that no longer exists
  is a 400, matching `POST /api/v1/runs`. Spec: `.ai/specs/2026-07-29-agent-profiles.md`.

## 🐛 Fixes
- 🐛 **A pull request with merge conflicts no longer reads "ready to merge".** The chip's status
  answers *whose move is it* — `ready` means open, checks green, nobody waited on — and every word
  of that stays true of a branch GitHub is refusing to merge, so a conflicted PR sat there in
  ready-green with nothing on screen saying otherwise. Mergeability is now carried as its own axis
  (it rides the same batched GraphQL query, so it costs no extra request) and paints the chip that
  links to the PR in its own colour: orange, not the red that already means "checks failed" and
  "changes requested", with a warning glyph and a panel that leads with the conflict and still
  spells out the status underneath. Only a forge that actually answers `CONFLICTING` paints it —
  GitHub's still-computing `UNKNOWN`, an unreachable forge and a server too old to send the field
  all leave the chip exactly as it was, because none of them is an answer — and `UNKNOWN`, which
  is what GitHub says for the first seconds after every push while it computes the merge base, is
  now cached as the non-answer it is: such a reference is re-asked within seconds instead of being
  held for the usual minute, so a conflict shows up on its own rather than on a page reload. A
  push made through cezar drops what the forge told us about that task's pull requests for the
  same reason — it is the event that changes the answer. Every reference chip everywhere now opens
  the SAME panel — a popover driven by our own hover intent, so it can hold a control without
  costing the chip the tap and tab order a link is owed — and a conflicting one carries a
  **Resolve conflicts** button that sends the agent `Merge head branch and resolve
  conflicts in PR number N` on whichever seam the task's state allows — a live message, or a
  continue for a task parked at review, which is where a conflicting PR usually hangs. The number
  is in the words because a task can point at several pull requests, and each chip's button names
  its own. Offered on the task page, the Tasks table and cards, the sidebar, and the cross-project
  All tasks page alike — that last one fetches the task's record when the panel opens (its index
  row is deliberately too slim to say whether a finished task can be reopened) and sends through
  the run's OWN project rather than whichever one the page happens to be standing in.
- 🐛 **A task that opens its own PR keeps the chip for the PR it was working on.** A task started
  on someone else's PR that pushed a follow-up of its own showed only the new one: the agent
  re-declares `CEZ:PR` with the number it just opened, as the marker contract asks it to, and
  that declaration was applied to the *referenced* tier — which clears the chip when no candidate
  matches the declared number. A declaration naming the PR the run itself created is now read as
  what it is, a statement about the created PR (`pullRequestUrl` already carries it), so the PR
  the task is about survives it, as does the number the task came in with. Records already
  written this way heal when they are next read — no migration. The run header now paints every
  PR the task points at, too, instead of only the strongest one — including a PR known only by
  number, which it used to drop whenever it had no repository to build a link from. (#901)
- 🐛 **A task can no longer be credited with a PR it only read about.** cezar decides a task
  opened a PR by spotting `gh pr create` (or "opened a pull request") near a PR link — and it
  scanned tool *output* for that phrase, so a task that printed a log, a stored transcript, or a
  test fixture containing someone else's creation line adopted their PR as its own, in a
  different repository, permanently: the first PR adopted wins, so the real one that followed was
  never looked at. The phrase is now believed only from the agent's own words or from the command
  cezar saw run — the link itself may still come from the command's output, which is where `gh`
  prints it. And when a task declares a PR (`CEZ:PR`) that no scraped link corroborates, that
  declaration now leads the chips — so a PR picked up by mistake can no longer push the one the
  task actually named out of the single-chip surfaces. (#901)
- 🐛 **A reference chip on a task's own page links, in every project.** A PR or issue known only
  by number was a live link on All tasks and dead text on the task's page whenever the project
  was not the one cezar booted in: that page synthesized links from `/health`, which always
  reports the boot project's repository, so it refused to guess rather than point at the wrong
  repo (#526). It now reads the project registry's own per-project repository — the same source
  All tasks uses — and falls back to health only for the boot project. (#901)

# 0.10.0 (2026-08-14)

## Highlights
The cockpit stops being one-project-at-a-time: **All tasks** shows every registered repo's work
in a single filterable table, grouped by tags you give your repositories, and every PR or issue
chip in cezar now says where that PR or issue stands. Alongside that, **agent accounts** let one
project run on your work login and another on your personal one, `pi` joins claude, codex and
opencode as a runner, and a task killed by a provider usage limit resumes itself when the window
reopens.

## ⚠️ Breaking
- **GitHub Automations are now opt-in via `CEZ_AUTOMATIONS=1`.** They previously ran for any
  project with a GitHub remote, with no way to switch them off. Off — the default — every
  automations route answers `409` naming the flag and the scheduler never starts, so nothing
  polls GitHub and no run is launched on your behalf. `GET /api/v1/health` reports the new
  required `capabilities.automations`. (#801, #802)

## ✨ Features
- ✨ **All tasks: one table for every project, grouped by the repos that belong together.** Tag
  your repositories in **Settings → Projects** (`storefront`, `infra`, `client-acme`; the field
  autocompletes from tags already in use), then open **All tasks** — the new top sidebar item,
  `/tasks`, or `⌘K → All tasks` — to see every registered project's work in one table with its
  PR/issue chip and an archive button. Filter by tag, status and workflow (multi-select, ORed
  inside a facet and ANDed across, each option showing how many tasks it would leave), group by
  tag, and share the view: filters, grouping and the Active/Archived tab live in the URL. Tags
  are stored in `~/.cezar/config.json`, deduplicated case-insensitively, and read by nothing else
  in cezar — a tag is a lens, not a permission or a routing rule. `PATCH /api/v1/projects/:id`
  gained an optional `tags`; over ssh, `cezar projects tag <id> [<tag>…]` does the same thing.
  Spec: `.ai/specs/2026-08-10-global-tasks-and-project-tags.md`. (#845)
- ✨ **A task's PR or issue chip now says where that PR or issue stands.** Every reference chip
  in the cockpit — sidebar rows, the per-project Tasks table, All tasks, the run header — carries
  the state of the thing it points at in three channels: colour (violet done, green fine, blue
  waiting on a reviewer, amber for a running build, red for anything wrong), a GitHub-vocabulary
  icon, and a tooltip that spells it out; the status reaches the chip's accessible name too. A PR
  reads as merged, closed, draft, changes requested, checks failing, checks running, waiting for
  review, or ready to merge — decided by *whose move it is*, which is what the colour encodes.
  "Changes requested" turns blue once the author has answered (cezar reads the pending
  re-request and the head commit's date) instead of blaming them for edits they already made.
  References resolve by number, so a `#774` filed as a PR still gets the right answer if it is an
  issue. Statuses are batched per project, cached server-side, remembered per reference for the
  tab's lifetime and across reloads, refreshed at a cadence the server sets (a merged PR is never
  re-asked; a hidden tab polls nothing), and dropped the moment cezar merges a PR itself. When
  there is nothing to show the chip stays neutral and says which kind of nothing on hover.
  Additive route: `GET /api/v1/github/ref-status?prs=&issues=`.
  Spec: `.ai/specs/2026-08-11-reference-status-chips.md`. (#871)
- ✨ **Agent accounts: run one project on your work login and another on your personal one.** The
  same CLI logged in twice (`CLAUDE_CONFIG_DIR=~/.claude-klaudiusz claude`, or `CODEX_HOME` for
  Codex) is now something cezar can address. Add the config folder under **Settings → Agent
  accounts**, pick which account each project uses under **Settings → Agents**, and override it
  per task from the composer. Each account reports its own connection state and **Connect**, and
  "Open in → Claude CLI" hands the terminal the account that actually ran the work so `--resume`
  lands on the right conversation. **Show details** reveals the email, organization and plan, and
  opens that account's own `settings.json` / `CLAUDE.md` / `config.toml` / `AGENTS.md`. Identity
  is opt-in: nothing fetches an email until you expand a row. Zero-config is untouched — with one
  login there is no new control anywhere. Accounts live in `~/.cezar/agent-accounts.json`, so
  downgrading and upgrading cezar cannot lose them, and cezar never silently falls back to
  another account when the chosen one is unavailable. OpenCode is not supported yet: it keeps
  credentials outside its config folder. Spec: `.ai/specs/2026-07-29-agent-profiles.md`.
- ✨ **Handing an issue or PR to the agent can pick which account runs it.** The GitHub tab's
  "Hand this to the agent" panel was the one start surface the agent-accounts work missed, so
  delegating an issue always ran on whatever the project's selection resolved to. It now offers
  the same runner/login rows as the composer, under the composer's rules: switching the agent
  drops the account and the model pin rather than carrying a foreign login along, switching only
  the account keeps the model, and an untouched pill still follows the project's selection
  instead of pinning it. One agent with one login sees no pill and sends exactly what it sent
  before. The Inbox card's ▶ Run is deliberately unchanged — its endpoint cannot carry an account
  yet, and offering a choice the server would drop is worse than not offering one. (#878)
- ✨ **`pi` is a fourth agent backend.** It drives a Claude-compatible headless stream-json
  session, so it reuses the proven session machinery (multi-turn stdin, EOF watchdog, wall-clock
  kill switch, normalized events) and differs only in the binary it spawns. Like opencode, it
  selects models with the canonical `provider/model` identity and has no default provider, so a
  bare model id fails loudly rather than silently defaulting. (#470)
- ✨ **A task killed by a provider usage limit resumes itself.** cezar reads the reset instant
  from the provider's own marker, parks the run with `autoResumeAt` = reset + 30s, and resumes it
  through the ordinary queued-continuation path — durable across restarts and self-healing if a
  timer is lost. With no instant to read, nothing is scheduled: guessing a window is a retry loop
  against a provider still refusing. (#778)
- ✨ **Long sessions load progressively.** History is paged from the server with bounded reads and
  hydrated as you scroll, instead of a long transcript blocking the thread on one giant payload.
  (#739)
- ✨ **Foldable task table columns.** Choose which columns the Tasks table shows; the choice is
  persisted per workspace. (#743)
- ✨ **A General page for the project you are inside** (`/p/<id>/settings`). Where the checkout
  is (with Copy and "Open with" for this machine's editors, file manager and terminal), what
  state its folder is in, how many of its tasks may run at once, and how to remove it — the last
  two previously reachable only from the global registry table in another settings area. (#772)
- ✨ **Readable task names in the sidebar quick-list.** The reference number is painted once, as a
  leading PR/issue chip that is itself the link, and the title has a width floor — metadata drops
  before the title truncates. (#789)
- ✨ **The agent badge shows the canonical model identity.** The normalized `provider/model` a run
  actually resolved to is now readable in the session header's agent disclosure, next to runner
  and account, and only when it says something the plain model name does not. (#546, #833)
- ✨ **Toasts animate in and out from the top right.** They no longer land on the thread's action
  row, and dismissal is two-phase so the exit transition actually runs. (#820)
- ✨ **Advanced users can opt out of repository-root run serialization.** Set the exact value
  `CEZ_DISABLE_REPO_LOCK=1` to let runs in the shared checkout overlap, including explicit
  `worktree=false` runs, non-Git degradation, and continuations whose worktree cannot be
  restored. The safe default is unchanged and isolated worktree runs are unaffected. This escape
  hatch is intentionally dangerous — concurrent agents can overwrite each other's files or Git
  state — so cezar shows a visible unsafe-mode note whenever it is active. (#762)

## 🐛 Fixes
- 🐛 **`npx cezar-cli` starts again.** The alias imported a subpath the scoped package's exports
  map does not expose, so Node rejected it with `ERR_PACKAGE_PATH_NOT_EXPORTED` and every launch
  died on startup. It imports the bare specifier now. (#851, #852)
- 🐛 **Killing a run really kills it.** `ChildProcess.killed` reports that a signal was
  *delivered*, not that the child died, and every agent CLI installs its own SIGTERM handler — so
  the SIGKILL escalation, gated on `!child.killed`, was skipped for exactly the child it exists
  for, and the process outlived teardown. Fixed in the agent-runner watchdogs and in OpenCode's.
  (#844, #857, #858, #867)
- 🐛 **The sidebar's Tools dot is green when cezar can actually start a task.** It went amber
  whenever any probed tool was missing, so a healthy host with only the optional codex/opencode
  runners absent looked permanently degraded and the tooltip asked for attention to tools nobody
  wanted. Amber now means no agent CLI at all, or the configured `defaultRunner` is the missing
  one; anything else is a choice not taken, which the per-row dot in the open menu already says.
  (#884)
- 🐛 **The settings gear and the theme toggle stay inside the sidebar on a nightly build.** A
  nightly's version string is long (`v0.9.2-nightly.20260813.1` against a release's `v0.9.2`) and
  the footer chip refused to give up a pixel, pushing the two buttons beside it out of the
  sidebar and over the page. The chip now yields: it shows as much of the version as fits and the
  whole of it on hover. (#879)
- 🐛 **A malformed history response degrades instead of throwing mid-render.** The two history
  fetchers returned an unvalidated body typed as if the server had been checked, so a 200 with an
  unexpected shape reached the hook, which iterated `page.events` and threw an uncaught
  `TypeError` — the documented full-replay fallback only fires on a rejected query, so it never
  ran. Both calls now validate at the client boundary. (#827, #863)
- 🐛 **A task's diff stat means something again.** The base was a branch *name* resolved once at
  worktree creation, which drifted, producing five-figure diffs for small changes
  (`+59514 −12160 / 927 files` for an 18-file change). It is now anchored at the freshest base
  and at the branch the task actually found. (#782)
- 🐛 **The global Tasks page reacts to work happening in other projects.** Events from other
  projects were dropped before reaching any cache, so `/tasks` — the one page that spans every
  project — ran on its 15-second poll alone, and that poll does not tick in a hidden tab. Those
  events now refresh the cross-project index (debounced), a reconnect reconciles it, and
  returning to the tab refetches. Scoped caches are untouched: another project's run still never
  lands in this project's list.
- 🐛 **A reference's status is shared across every surface again.** All tasks keyed each chip by
  its run's real project id while the sidebar, run header and per-project table used the
  `default` alias, so one pull request was remembered under two names. Every surface now names
  the project the same way.
- 🐛 **Opening the cockpit on your phone no longer rearranges it on your desktop.** Sidebar group
  collapse and the page a bare `/` restores were stored workspace-wide in `~/.cezar/ui-state.json`,
  so every open cockpit shared one answer. Both now live in each browser's own storage — zero
  requests per toggle, and the sidebar paints its real state on the first frame. The server keys
  stay accepted and round-tripped for older cockpits. (#786)
- 🐛 **Each task gets its own `TMPDIR`, preflighted.** Every agent inherited the host's temp
  directory, so all runs on a machine shared one — and when it stopped accepting writes the
  failure was silent (under `EDQUOT` the inode is allocated while the write fails, so a Bash
  command runs, lands its side effects, and the agent reads back nothing). (#785, #787)
- 🐛 **The composer reads git state from the project, not the folder cezar booted in.** Booting
  outside a git repo reported `repo: null` for every registered project: the Worktree chip
  vanished, variants were pinned to 1, every run posted `worktree: false`, and Push went dark.
  (#791, #792)
- 🐛 **The `/new` header follows the run mode the composer resolved**, instead of always claiming
  the run happens in an isolated worktree. (#793, #835)
- 🐛 **A `CEZ:MONITORING` run resumes on its own again**, and `/skill` expands on continuations.
  (#810, #811, #812)
- 🐛 **"Mark all read" no longer stamps a run that is waiting out a usage limit**, so the count it
  returns is the number the unread badge was showing. (#803, #834)
- 🐛 **A legacy `claude-cli` runner id in `runs.json` stays parseable.** The persisted enum had
  dropped it, and because the loader validates the whole array, one legacy record would have
  dropped every run in the file — the exact failure `BACKWARD_COMPATIBILITY.md` §3 warns about.
  (#547, #832)
- 🐛 **OpenCode models are discovered, not hard-coded.** cezar parses `opencode models` — strict
  `provider/model` matching so a banner never becomes a picker entry, an empty listing meaning
  "no provider configured" rather than a failure, and bounded output, size and deadline. (#799)
- 🐛 **Answers to an Ask reach the agent through idle teardown.** (#758)
- 🐛 **`server-install` refuses to uninstall a registered project again.** (#535, #790)
- 🐛 **`npm test` no longer opens a real Terminal window.** Every launcher now goes through its
  injectable seam. (#824, #825)

## 🔧 Changed
- Dropped the unused `KNOWN_PROVIDERS` export. (#548, #831)

## 🚀 CI/CD & Infrastructure
- 🚀 **`npx cezar-cli@nightly` is always the trunk.** A nightly workflow verifies main (typecheck,
  unit suites, build, packaged-CLI e2e) at 03:17 UTC and publishes it under the `nightly`
  dist-tag; a scheduled run skips itself when main has not moved in 24h. The channel is reachable
  only by asking for it by name, and only from main. (#876)
- 🚀 Allow releasing from `release/*` branches. (#780)
- 🚀 Synchronize the repository-root lease test instead of racing a timer. (#797, #800)
- 🚀 Stop the JetBrains launcher case racing a real process. (#823, #862)
- 🚀 Give the health-topic probe waits a realistic budget. (#701, #733)

## 📝 Specs & Documentation
- 📝 Design spec for publishable Cezar React components. (#710)
- 📝 Spec for linked-PR chips on the GitHub Issues list. (#816)
- 📝 Disambiguate cezar (OSS) from the hosted team SaaS. (#883)
- 📝 Add the missing root `LICENSE` file (MIT). (#796)

## 👥 Contributors

- @pat-lewczuk
- @patzick
- @pkarw
- @wojciechszyjka
- @andrzejewsky
- @sheeerth
- @sapersky
- @dominikpalatynski

# 0.9.2 (2026-08-04)

## ⚠️ Breaking
- **The HTTP API moved to `/api/v1`.** Every route answers under `/api/v1/…` (project-scoped:
  `/api/v1/p/<projectId>/…`) and the WebSocket bus is `/api/v1/ws`; the unversioned `/api/*`
  spelling is gone. The bundled cockpit ships in lockstep, so a normal upgrade needs nothing from
  you — this only matters if you script the API directly, where the fix is adding `/v1`.
  `GET /api/v1/health` is still the CORS-open discovery endpoint, historical run transcripts keep
  rendering (old image URLs are upgraded when read), and saved bookmarklets are unaffected.
  Versioning is what lets the typed client describe the whole surface and makes a future `v2` an
  additive mount rather than an edit to every route.

## ✨ Features
- ✨ **The two mixed-format routes do real HTTP content negotiation.** `GET /api/v1/repo/commit/:sha`
  (legacy text blob or structured commit payload) and `GET /api/v1/runs/:id/files` (JSON listing or
  an image's raw bytes) now honour the request's `Accept` header, answer `Vary: Accept`, and set a
  `Content-Type` confirming what they actually sent. Purely additive: the `?structured=`/`?raw=`
  flags still decide whenever the request carries one, `*/*` (what `fetch` and `curl` send) is read
  as "no preference" and keeps each route's existing default, so every current caller's answer is
  byte-identical. What is new is that a client that really does ask — an `<img>`, a browser
  navigation — gets the other representation without the flag, under the same allowlist, size cap
  and sandbox CSP as before.
- ✨ **Finished tasks now carry a read/unread marker (#767).** A done or failed run you have not
  opened since it finished reads as *unread* — its row is promoted (brighter, semibold) and wears a
  small trailing violet dot — while everything you have already seen dims back. The Tasks nav item
  shows how many are unread, opening a task's thread clears it, and a "Mark all read" sweep clears
  the lot. Unread is a deliberately separate channel from the status dot, which keeps saying
  done/failed, so "what happened" and "have I seen it" never collapse into one signal.

- ✨ **⌘K searches the whole workspace, not just the project you are standing in.** The palette
  now lists your **projects** — recency-ordered like the sidebar, the active one last — so
  switching is a keystroke, and it finds **tasks in any project**, each row labelled with the
  project it belongs to. That is backed by one new workspace-level route,
  `GET /api/v1/workspace/runs-index`, which answers a deliberately slim row per run instead of the
  full record: it never builds a project context, so reading it cannot prune worktrees or resume
  interrupted runs — typing in a search box must not restart agents. Projects this process has
  never opened are read straight off `runs.json`, sharing `RunStore`'s own reconciliation so a
  crashed process's `running` row reads as interrupted here exactly as it would once opened.
  The palette also opens on **New task** (one row now, not three scattered copies) followed by
  **Recently finished** — the tasks you have not opened since they finished, the same signal
  behind the Tasks badge. Ranking is substring-based rather than cmdk's fuzzy subsequence, because
  a run id is a uuid and typing a task number used to match stray digits inside unrelated ids
  ahead of the task actually named that; searching also folds the sections into one ranked list so
  a near-miss can never sit above an exact hit. The dialog is wider on wider screens, taller on
  taller ones, and anchored near the top so it no longer jumps as results come and go.

## 🔧 Changed
- Every mutating route is now visible to the typed client, `POST /api/v1/todos/:id/start` included.
  Its body used to be parsed inside the handler to keep "unknown id 404s before the body is
  validated"; a small existence guard registered *before* the body validator keeps that status
  order while the body becomes part of the route type. A bodyless POST still 201s and a malformed
  one still 400s.
- **Validation errors (`400 {error}`) are worded differently and now name the field.** Two causes:
  zod 4 rewrote its default messages (`Required` → `Invalid input: expected string, received
  undefined`), and each issue is now prefixed with its path — `task: must be at most 100000
  characters` where it used to be `task must be at most 100000 characters` for a handful of fields
  and an unattributed sentence for the rest. **The `{ error: string }` shape and the 400 status are
  unchanged**, and the message was never a pinned contract (BACKWARD_COMPATIBILITY.md §2 pins the
  shape, not the text) — but a script matching on the exact wording will need updating, and the
  cockpit shows the new text verbatim in its toasts.
- Every mutating route now validates its body as route middleware rather than inside the handler,
  and the query string / path params of 17 more routes are validated too. Behaviour is unchanged
  by design, including the tolerant cases (a body sent without a JSON content-type, a malformed
  body, and a repeated query key such as `?refresh=1&refresh=1`, which still takes the first
  value). The point is that the typed client can now check request bodies, params and queries at
  compile time.

## 🐛 Fixes
- 🐛 **Running the test suite no longer wipes your project registry.** A merge-write resolved
  `~/.cezar/config.json` twice — once to read, once to write, after the `await` — and
  `cezarHomeDir()` re-reads `CEZ_HOME` on every call, so a test that lost its sandbox pin
  mid-flight (a timeout was enough) read the temp home and wrote the real one, replacing every
  project with the fixture's. The path is now resolved once per merge-write, the whole server
  suite runs with `CEZ_HOME` pinned to a per-worker sandbox, and a write into the real `~/.cezar`
  from a vitest process is refused outright. The same one-path fix lands in the `ui-state.json` twin.
- 🐛 **The registry survives a lost config file.** Every merge-write that leaves projects behind
  also writes `~/.cezar/config.json.bak`, and cezar restores from that snapshot when the config
  file is missing, empty, or corrupt. Removing `~/.cezar` still resets cezar completely; removing
  only `config.json` no longer loses the project list. A config that parses and is simply empty is
  left alone — that is a user who removed their last project, not a lost registry.
- 🐛 **Structured questions render as a form, not raw JSON (#757).** When an agent asked a
  structured question, the Ask card could fall back to printing the raw JSON payload; it now renders
  the real question with its options, and long question text wraps instead of overflowing.
- 🐛 **Subagent sessions render like the main thread (#756).** A subagent's transcript now goes
  through the same session renderer as the top-level thread, so its messages, tools and reasoning
  look identical instead of a stripped-down variant.
- 🐛 **The task diff stat stops counting a repointed HEAD's branch (#751).** When a task's worktree
  HEAD was repointed onto another branch, the ± diff stat folded in that branch's whole history; it
  is now anchored at HEAD so it counts only the task's own changes, and the Changes tab says so when
  a repointed HEAD has narrowed what it shows.

## 👥 Contributors

- @pkarw
- @pat-lewczuk
- @patzick
- @andrzejewsky
- @sheeerth
- @wojciechszyjka

# 0.9.1 (2026-07-24)

## Highlights
A stabilization release that hardens single-project mode and sharpens the cockpit. Project edits and the registry are now correctly gated and isolated when `CEZ_SINGLE_PROJECT` is set (#625, #626), the diff and task commit list are virtualized for snappier scrolling on large runs (#599), and browser tabs finally carry project-aware titles (#543). Codex sessions read more clearly with labeled image-view tool calls and context compaction (#593, #596), while streamed deltas coalesce into whole text events (#633). A batch of run-fidelity fixes keeps task titles, issue-number provenance, and tool issue links accurate (#623, #539, #538).

## ✨ Features
- ✨ Project-aware browser page titles (fixes #543). (#592) *(@pkarw)*

## 🐛 Fixes
- ⚡ **Settings → Agent accounts opens instantly.** The account listing used to probe every agent's
  login while you waited — one CLI shell-out per agent plus one per account, 2.5s on a machine with
  four accounts. Which login an agent uses is operating knowledge that changes only when you run
  `claude auth login`, so cezar now warms every account — extra logins included — once at boot and
  keeps it in memory instead of re-probing every few seconds; the listing serves what it holds and never spawns anything (the rule
  `/api/v1/health` already follows). A *disconnected* answer is still re-checked within seconds,
  because that one blocks starting a run — so logging in from a terminal is not punished with a
  ten-minute wait. Same machine, same accounts: 2.5s → 12ms.
- **An added agent account can now be signed in from cezar.** The account row grows Connect and
  Check again; Connect opens a terminal aimed at that account's config dir rather than the default
  one. Previously the pane pointed at a Connect button that did not exist.
- **A task now says which agent, account and model produced it**, as text in the header
  (`claude · Klaudiusz · opus`) rather than hidden behind an icon; the account is the one the step actually spawned under, so a resumed
  task reports the login that owns its session rather than whatever the project is set to now.
- ✨ **Settings → Agent accounts now sets the default agent, account and models once, not per repo.**
  A project that has chosen nothing now follows the machine-wide default — and a project that HAS
  chosen is never moved by changing it, so a global tweak cannot quietly re-point work you already
  configured. Models merge per agent, so pinning one repo's Claude model keeps the machine's Codex
  preset.
- **Settings → Agents picks the default agent and its account in one click.** "Default runner" and
  the separate account picker were two fields answering one question; they are now a single flat
  list — `claude · Default`, `claude · Klaudiusz`, `codex` — matching the composer. The runner still
  goes to the repo's committable config and the account to your machine only, so a teammate keeps
  their own. With no extra logins it is the control it always was.
- **The composer's runner pill now lists agents and logins as one flat list** — `claude · Default`,
  `claude · Klaudiusz`, `codex` — instead of a separate account pill beside it. Every row is a
  concrete thing that can run the task, so which subscription it will bill is readable without
  opening anything. It starts on whatever the repo is set to and any row overrides it for that task
  alone. An agent with one login stays one row, so a machine with no extra accounts sees the list it
  always saw.
- **fix(server): `GET /api/v1/providers/status` no longer stalls for ~1–3s whenever its cache
  lapses.** It shares the same knowledge as the accounts listing and had the same problem from the
  other side: any provider you are not signed into pulled the whole response onto a five-second
  window, so one reader in every five seconds paid for three CLI spawns. Reads are now
  stale-while-revalidate (what `/api/v1/health` already does) and the run gate re-checks a provider
  before refusing to start a run, instead of the cache being kept young to protect it. Measured on
  the built server: reads that alternated between 3ms and 817ms are now 1–7ms across every cache
  window, while "Check again" (`?refresh=1`) still blocks for the real answer.
- 🐛 **`CLAUDE_CONFIG_DIR` is honoured.** A host that relocates Claude Code's config folder was
  invisible to the Agent config pane, which kept showing `~/.claude`. Related: the MCP listing read
  `~/.claude.json` from the wrong place under an override — that file is a *sibling* of the default
  folder but lives *inside* a relocated one.
- 🐛 **`CEZ_CLAUDE_BIN` counts as "installed".** The environment probe hardcoded a bare `claude`,
  unlike every other call site, so a host whose only install is at a custom path reported Claude as
  missing — dropping it from the composer and the installer's dependency step even though runs
  would have worked.
- ⚡ Virtualize the diff and the task commit list. (#599) *(@patzick)*
- 🐛 Repair concatenated task titles (fixes #623). (#627) *(@pkarw)*
- 🐛 Prevent single-project registry leak (fixes #626). (#629) *(@pkarw)*
- 🔐 Gate project edits in single-project mode (fixes #625). (#630) *(@pkarw)*
- 🐛 Label Codex image view tool calls (fixes #593). (#631) *(@pkarw)*
- 🐛 Keep the composer's runner and model aligned. (#632) *(@pkarw)*
- 🔄 Coalesce codex/opencode streamed deltas into whole v1 text events. (#633) *(@pkarw)*
- 🐛 Link per-project resource limits (fixes #634). (#635) *(@pkarw)*
- 🐛 Preserve task title message boundaries. (#636) *(@pkarw)*
- 🐛 Label Codex context compaction (fixes #596). (#639) *(@pkarw)*
- 🐛 Avoid boot slug collisions (fixes #558). (#641) *(@pkarw)*
- 🐛 Track issue number provenance (fixes #539). (#642) *(@pkarw)*
- 🐛 Keep tool issue links display-only (fixes #538). (#643) *(@pkarw)*
- 🐛 Auto-refresh the team-repo cache so codex reviews use current skills. (#644) *(@pkarw)*

## 📝 Specs & Documentation
- 📝 Document `CEZ_SINGLE_PROJECT` mode. (#597) *(@pkarw)*

## 🚀 CI/CD & Infrastructure
- 🚀 Pin `CEZ_HOME` in specs that boot their own server. (#619) *(@pat-lewczuk)*
- 🚀 Cover detached launcher lifecycle (fixes #574). (#640) *(@pkarw)*

## 👥 Contributors

- @pkarw
- @patzick
- @pat-lewczuk

# 0.9.0 (2026-07-21)

## Highlights
<!-- TODO: Highlights — auto-update-changelog leaves this blank for the human author to fill in. -->

## ✨ Features
- ✨ Edit the coding agents' own config files (global vs local, raw + highlighted). (#418) *(@pkarw)*
- ✨ Canonical provider/model identity shared across runners (fixes #405). (#466) *(@pat-lewczuk)*
- ✨ Runner + model selection for the Continue flow (fixes #401). (#468) *(@pat-lewczuk)*
- ✨ AskUser structured questions across claude, codex & opencode (fixes #473). (#502) *(@pkarw)*
- ✨ Multi-project workspace — per-user registry, project-scoped cockpit, config migrations (fixes #520). (#521) *(@pkarw)*
- ✨ Discover PR/issue refs from skill report lines and GitHub links. (#534) *(@pkarw)*
- ✨ Grouped sub-agent display — Agents dock + drill-down sheet (fixes #474). (#550) *(@pkarw)*
- ✨ Render full timeline (commits, labels, merges) with per-commit CI markers (fixes #525). (#552) *(@pkarw)*
- ✨ Stack, edit and remove prompt messages on a queued run (fixes #472). (#553) *(@pkarw)*
- ✨ Link clone root to project settings (fixes #561). (#571) *(@pkarw)*
- ✨ Separate browse and checkout roots. (#572) *(@pkarw)*

## 🔒 Security
- 🔒 Guard the localhost API against CSRF and DNS rebinding (fixes #426). (#467) *(@pat-lewczuk)*

## 🐛 Fixes
- 📦 Never push a release commit to protected main. (#514) *(@pat-lewczuk)*
- 🔄 Stop GitHub nav item flickering — stale-while-revalidate forge probe. (#516) *(@pat-lewczuk)*
- 🔄 Resolve a stale local base ref to `origin/<base>` to stop phantom diffs. (#518) *(@pat-lewczuk)*
- 🐛 Skill pickers order most-used → project → global (fixes #519). (#523) *(@pkarw)*
- 🐛 Label Skill and Agent tool rows in the Session tab (fixes #529). (#532) *(@pkarw)*
- 🐛 Name the autosave trigger in the commit subject + refuse conflicted trees (#471). (#533) *(@pkarw)*
- 🐛 Keep reasoning text alive across replay and drop empty "Thinking" rows (fixes #528). (#536) *(@pkarw)*
- 🐛 A custom hand-off prompt extends the item context instead of replacing it (fixes #524). (#541) *(@pkarw)*
- 🐛 Preserve thinking across resumed steps (fixes #556). (#564) *(@pkarw)*
- 🐛 Isolate cross-backend continuation sessions (fixes #562). (#566) *(@pkarw)*
- 🔐 Default to full permissions (fixes #563). (#568) *(@pkarw)*
- 🔄 Refresh checkout root after save (fixes #567). (#569) *(@pkarw)*
- 🐛 Make picker tiers deterministic (fixes #555). (#570) *(@pkarw)*
- 🐛 Render reasoning snapshot arrays. (#573) *(@pkarw)*
- 🐛 Show queued task references immediately (fixes #554). (#578) *(@pkarw)*
- 🐛 Bridge subagents and native questions (fixes #565). (#579) *(@pkarw)*
- 🐛 Scope subtasks by session id (fixes #551). (#587) *(@pkarw)*

## 📝 Specs & Documentation
- 📝 Multi-project workspace — per-user `~/.cezar` registry, project-scoped cockpit, config migrations. (#517) *(@pkarw)*
- 📝 Grouped sub-agent display within a single session. (#522) *(@pkarw)*
- 📝 GitHub tab timeline events (commits, labels, merges) + per-commit CI markers. (#527) *(@pkarw)*
- 📝 Worktree file editing from the Files tab (#530). (#531) *(@pkarw)*
- 📝 Stack, edit and remove prompt messages on a queued run. (#537) *(@pkarw)*
- 📝 Correct the linting constraint — oxlint, not typescript-eslint. (#560) *(@patzick)*
- 📝 Discover latest Codex models. (#585) *(@pkarw)*

## 🚀 CI/CD & Infrastructure
- 🚀 Migrate to TypeScript 7 (native compiler). (#559) *(@patzick)*

## 👥 Contributors

- @pkarw
- @pat-lewczuk
- @patzick
