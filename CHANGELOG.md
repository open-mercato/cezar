# Unreleased

# 0.9.3 (2026-08-09)

Maintenance release on top of 0.9.2. Everything here is a cherry-pick from `main`; the larger
0.9.x features (per-project agent accounts, workspace-wide ⌘K search, auto-resume after a usage
limit, the project General settings page) stay on `main` for the next minor.

## ✨ Features
- ✨ **Advanced users can opt out of repository-root run serialization.** Set the exact value
  `CEZ_DISABLE_REPO_LOCK=1` to let runs executing in the shared checkout overlap, including
  explicit `worktree=false` runs, non-Git degradation, and continuations whose worktree cannot be
  restored. The safe default is unchanged and isolated worktree runs are unaffected. This escape
  hatch is intentionally dangerous: concurrent agents can overwrite each other's files or Git
  state, so cezar emits a visible unsafe-mode note whenever it is active. (#762)
- ✨ **GitHub Automations are now opt-in behind `CEZ_AUTOMATIONS=1`.** They shipped gated only by
  forge availability, so any project with a GitHub remote had them on with no way to switch them
  off. Off — the new default — nothing polls GitHub and no run is ever launched on your behalf:
  the workspace scheduler never starts, every automations route answers `409` naming the flag, the
  nav item drops out of the sidebar, the mobile drawer, ⌘K and every project group, the
  `/automations*` routes render a disabled state instead of an editor whose requests would fail,
  and the GitHub tab's "Set up automations" shortcut is gone. A task launched while automations
  were on keeps its provenance chip forever; it just stops being a link. Nothing is destroyed —
  definitions, receipts and high-watermarks are untouched, so setting the flag and restarting
  brings the feature back exactly as it was. `GET /api/v1/health` gained
  `capabilities.automations` so the cockpit and the server can never disagree about it. (#801,
  #802)
- ✨ **The sidebar quick-list reads like task names, not run ids.** Recent tasks in the sidebar
  show the same readable title the Tasks table does, so you can find the run you mean without
  opening it. (#789)

## 🐛 Fixes
- 🐛 **A task that parked on `monitoring` now re-checks its own work instead of waiting for you.**
  A run that ended a turn with `CEZ:MONITORING` — waiting on CI, a long test command, a sub-agent —
  had no timer at all: 0.9.2 removed the 15-minute idle timeout that used to bound a parked monitor
  and replaced it with a re-check cadence that shipped switched off. Since cezar has no
  process-exit callback, no CI webhook and no sub-agent-completion event, nothing could resume the
  run, and tasks sat in `monitoring` for hours until someone typed into them. The cadence now
  defaults to **5 minutes**, bounded by the existing 40-wakeup safety cap. Settings → Resources →
  *Monitoring wake-up* → **Park until resumed** restores the old behaviour explicitly, and a
  workspace that already chose it keeps it. (#810)
- 🐛 **`/skill` typed into a finished task's reply box works again.** Registry slash skills were
  expanded only for messages delivered into a live session, so a Reply into a finished run — and
  every restart recovery, which takes the same path — handed the raw `/om-...` to the agent CLI,
  which answered "Unknown skill". It looked intermittent because starting a new task worked. Both
  the continuation's opening message and its follow-ups now expand against the same registry. (#811)
- 🐛 **The composer follows the project you are in, not the folder cezar was started from.**
  Launched from an umbrella workspace directory or any non-Git folder, every registered project
  silently lost worktree isolation: the Worktree chip disappeared, parallel variants were stuck at
  ×1, runs executed in the working tree, and Push went dark on the Changes tab — while the
  `base:` pill in the same row listed the project's branches correctly. (#791, #792)
- 🐛 **A task's diff stat counts that task's work again.** The number is now anchored at the
  freshest base *and* at the branch the run found, so a review or QA run that repoints its
  worktree onto the branch under review no longer attributes that whole branch's history to the
  task. (#782)
- 🐛 **A task about another repository no longer links its issue into the project you are viewing.**
  A run whose subject lives elsewhere — an `om-auto-fix-pr` started in one project for a PR in
  another — picked up that repository's issue number from its own transcript, and the header chip
  rebuilt it against the project on screen: `Issue #4143` pointed at `…/cezar/issues/4143`, an
  issue that does not exist. The chip is now omitted when the number demonstrably belongs to
  another repository; a wrong link is worse than none. The PR chip was always correct. (#819)
- 🐛 **Opening the cockpit on your phone no longer rearranges it on your desktop.** Which sidebar
  project groups are collapsed, and which page a bare `/` restores, were stored workspace-wide in
  `~/.cezar/ui-state.json` — so every open cockpit shared one answer: the last client to navigate
  decided where the next launch landed on every other client, and a group collapsed on a narrow
  screen collapsed everywhere. Both now live in each browser's own storage, which is also what they
  always described. Each toggle costs zero requests, the sidebar paints its real state on the first
  frame instead of after a fetch, and the bare-root restore no longer waits on the UI-state read.
  The server keys stay accepted and round-tripped for older cockpits; existing collapse state and a
  remembered location are workspace-wide values with no per-browser answer yet, so each browser
  starts from the defaults once and remembers from there. (#786)

## 🧹 Internal
- The repository ships a root `LICENSE` file (MIT). Every manifest named the license but the repo
  root had no license text; the published `@open-mercato/cezar` tarball already carried its own
  copy and is unaffected. (#796)
- Two run-lifecycle tests synchronize on the transition they are about instead of racing a timer:
  the repository-root lease test (#800) and the continuation model-identity test, which polled for
  a terminal status that the run still carried for a tick after Continue was pressed.

## 👥 Contributors

- @pat-lewczuk
- @dominikpalatynski
- @patzick
- @sapersky

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
