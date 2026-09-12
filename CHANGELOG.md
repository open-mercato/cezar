# 0.10.1 (2026-09-04)

## Highlights
The cockpit gets easier to live in on a phone and harder to be wrong about. Pinned tasks keep the two or three you're actively working on at the top of the list, a follow-up can be sent to a different Claude login than the one that started it, and the composer now takes PDF, TXT and MD files the same way it's always taken a screenshot. The Claude model picker reads from your own CLI instead of a hand-written list, and a run's reference chips get several correctness passes: a conflicting PR now says so, a task can no longer borrow another repository's pull request as its own, and a stale review request or an "Update branch" click can no longer paint over a real rejection.

## ✨ Features
- ✨ Pin the two or three tasks you are actually living in — a per-project Pinned group above `Needs you` (fixes #935). (#938) *(@piotrchabros)*
- ✨ Continue a task on another agent account, not just another agent. (#924) *(@patzick)*
- ✨ The composer takes a PDF, TXT or MD file the same way it already takes a screenshot (fixes #950). (#951) *(@pat-lewczuk)*

## 🐛 Fixes
- 🐛 A question one closing brace short is now a card, not a wall of JSON (fixes #936). (#937) *(@piotrchabros)*
- 🐛 A pull request with merge conflicts no longer reads "ready to merge", and carries a Resolve conflicts button. (#904) *(@patzick)*
- 🐛 A task that opens its own PR keeps the chip for the PR it was working on. (#901) *(@patzick)*
- 🐛 A task can no longer be credited with a PR it only read about. (#901) *(@patzick)*
- 🐛 A reference chip on a task's own page links, in every project. (#901) *(@patzick)*
- 🐛 A pull request's own repository decides whether cezar trusts it, not just the URL (fixes #945). (#946) *(@pat-lewczuk)*
- 🐛 A stale review request, and GitHub's own "Update branch" merge, can no longer clear a real rejection. (#909) *(@patzick)*
- 🐛 Opening another project's task from All tasks or the sidebar no longer 404s until you reload. (#905) *(@patzick)*
- 🐛 The Changes tab's file tree scrolls on its own. (#918) *(@piotrchabros)*
- 🐛 The composer's skill picker can be cleared, and no longer haunts the next task. (#919) *(@pat-lewczuk)*
- 🐛 A resumed session keeps the tools its step was actually granted. (#928) *(@AGmakonts)*
- 🐛 Typing a Polish letter in the composer no longer sends a canned reply. (#943) *(@matgren)*
- 🐛 The Claude model picker lists what your own CLI actually offers (fixes #784). (#841) *(@wojciechszyjka)*
- 🐛 The GitHub tab's search finds an issue or PR whatever its state (fixes #730). (#732) *(@wojciechszyjka)*
- 🐛 Mobile task history reclaims the screen space its chrome was taking. (#764) *(@blabbler78)*
- 🐛 The run header's metadata row collapses behind a disclosure on phones, not the whole page (fixes #765). (#873) *(@pat-lewczuk)*
- 🐛 A fresh task started with a `/skill` command actually runs it. (#947) *(@matgren)*

## 🚀 CI/CD & Infrastructure
- 🚀 A CI re-run no longer fails the packaged-CLI e2e regardless of the diff. (#911) *(@wojciechszyjka)*

## 👥 Contributors

- @pat-lewczuk
- @wojciechszyjka
- @piotrchabros
- @blabbler78
- @matgren
- @AGmakonts
- @patzick

# 0.10.0 (2026-08-14)

## Highlights
The cockpit stops being one-project-at-a-time: All tasks shows every registered repo's work in a single filterable table, grouped by tags you give your repositories, and every PR or issue chip in cezar now says where that PR or issue stands. Alongside that, agent accounts let one project run on your work login and another on your personal one, `pi` joins claude, codex and opencode as a runner, and a task killed by a provider usage limit resumes itself when the window reopens.

## ⚠️ Breaking
- ⚠️ GitHub Automations are now opt-in via `CEZ_AUTOMATIONS=1` — they used to run for any project with a GitHub remote with no way to switch them off, and are off by default now, so every automations route answers `409` and `GET /api/v1/health` reports the new required `capabilities.automations` (fixes #801). (#802) *(@pat-lewczuk)*

## ✨ Features
- ✨ All tasks: one table for every project, grouped by the repository tags you give them. (#845) *(@patzick)*
- ✨ A task's PR or issue chip now says where that PR or issue stands. (#871) *(@patzick)*
- ✨ Agent accounts: run one project on your work login and another on your personal one.
- ✨ Handing an issue or PR to the agent can pick which account runs it. (#878) *(@patzick)*
- ✨ `pi` is a fourth agent backend. (#470) *(@pat-lewczuk)*
- ✨ A task killed by a provider usage limit resumes itself when the window reopens. (#778) *(@patzick)*
- ✨ Long sessions load progressively. (#739) *(@pkarw)*
- ✨ Foldable task table columns. (#743) *(@pkarw)*
- ✨ A General page for the project you are inside (`/p/<id>/settings`). (#772) *(@patzick)*
- ✨ Readable task names in the sidebar quick-list. (#789) *(@pat-lewczuk)*
- ✨ The agent badge shows the canonical model identity (fixes #546). (#833) *(@pat-lewczuk)*
- ✨ Toasts animate in and out from the top right. (#820) *(@pat-lewczuk)*
- ✨ Advanced users can opt out of repository-root run serialization with `CEZ_DISABLE_REPO_LOCK=1`. (#762) *(@dominikpalatynski)*

## 🐛 Fixes
- 🐛 `npx cezar-cli` starts again (fixes #851). (#852) *(@wojciechszyjka)*
- 🐛 Killing a run really kills it — the SIGKILL escalation no longer trusts `ChildProcess.killed` (fixes #844, #858). (#857, #867) *(@wojciechszyjka)*
- 🐛 The sidebar's Tools dot is green when cezar can actually start a task. (#884) *(@pat-lewczuk)*
- 🐛 The settings gear and the theme toggle stay inside the sidebar on a nightly build. (#879) *(@patzick)*
- 🐛 A malformed history response degrades instead of throwing mid-render (fixes #827). (#863) *(@wojciechszyjka)*
- 🐛 A task's diff stat means something again — it is anchored at the freshest base instead of a drifting branch name. (#782) *(@pat-lewczuk)*
- 🐛 The global Tasks page reacts to work happening in other projects.
- 🐛 A reference's status is shared across every surface again.
- 🐛 Opening the cockpit on your phone no longer rearranges it on your desktop. (#786) *(@patzick)*
- 🐛 Each task gets its own `TMPDIR`, preflighted (fixes #785). (#787) *(@pkarw)*
- 🐛 The composer reads git state from the project, not the folder cezar booted in (fixes #791). (#792) *(@sapersky)*
- 🐛 The `/new` header follows the run mode the composer resolved (fixes #793). (#835) *(@pat-lewczuk)*
- 🐛 A `CEZ:MONITORING` run resumes on its own again, and `/skill` expands on continuations (fixes #810, #811). (#812) *(@pat-lewczuk)*
- 🐛 "Mark all read" no longer stamps a run that is waiting out a usage limit (fixes #803). (#834) *(@pat-lewczuk)*
- 🐛 A legacy `claude-cli` runner id in `runs.json` stays parseable (fixes #547). (#832) *(@pat-lewczuk)*
- 🐛 OpenCode models are discovered, not hard-coded. (#799) *(@pat-lewczuk)*
- 🐛 Answers to an Ask reach the agent through idle teardown. (#758) *(@pkarw)*
- 🐛 `server-install` refuses to uninstall a registered project again (fixes #535). (#790) *(@andrzejewsky)*
- 🐛 `npm test` no longer opens a real Terminal window (fixes #824). (#825) *(@pat-lewczuk)*

## 🔧 Changed
- 🔧 Dropped the unused `KNOWN_PROVIDERS` export (fixes #548). (#831) *(@pat-lewczuk)*

## 🚀 CI/CD & Infrastructure
- 🚀 `npx cezar-cli@nightly` is always the trunk. (#876) *(@patzick)*
- 🚀 Allow releasing from `release/*` branches. (#780) *(@pat-lewczuk)*
- 🚀 Synchronize the repository-root lease test instead of racing a timer (fixes #797). (#800) *(@pat-lewczuk)*
- 🚀 Stop the JetBrains launcher case racing a real process (fixes #823). (#862) *(@wojciechszyjka)*
- 🚀 Give the health-topic probe waits a realistic budget (fixes #701). (#733) *(@wojciechszyjka)*

## 📝 Specs & Documentation
- 📝 Design spec for publishable Cezar React components. (#710) *(@andrzejewsky)*
- 📝 Spec for linked-PR chips on the GitHub Issues list. (#816) *(@sheeerth)*
- 📝 Disambiguate cezar (OSS) from the hosted team SaaS. (#883) *(@pat-lewczuk)*
- 📝 Add the missing root `LICENSE` file (MIT). (#796) *(@pat-lewczuk)*

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
- ⚠️ The HTTP API moved to `/api/v1` (`/api/v1/p/<projectId>/…` when project-scoped, `/api/v1/ws` for the WebSocket bus) and the unversioned `/api/*` spelling is gone — the bundled cockpit ships in lockstep, so only a script calling the API directly needs the `/v1`.

## ✨ Features
- ✨ The two mixed-format routes do real HTTP content negotiation — `GET /api/v1/repo/commit/:sha` and `GET /api/v1/runs/:id/files` honour `Accept` and answer `Vary: Accept`, additively, so every current caller's answer is byte-identical.
- ✨ Finished tasks now carry a read/unread marker, with an unread count on the Tasks nav item and a "Mark all read" sweep. (#767) *(@pat-lewczuk)*
- ✨ ⌘K searches the whole workspace — every project and every project's tasks — backed by the new `GET /api/v1/workspace/runs-index`.

## 🔧 Changed
- 🔧 Every mutating route is now visible to the typed client, `POST /api/v1/todos/:id/start` included.
- 🔧 Validation errors (`400 {error}`) are worded differently and now name the field; the `{ error: string }` shape and the 400 status are unchanged.
- 🔧 Every mutating route validates its body as route middleware rather than inside the handler, and 17 more routes validate their query and path params — behaviour unchanged by design.

## 🐛 Fixes
- 🐛 Running the test suite no longer wipes your project registry.
- 🐛 The registry survives a lost config file — a `config.json.bak` snapshot is restored when the config is missing, empty or corrupt.
- 🐛 Structured questions render as a form, not raw JSON (fixes #754). (#757) *(@pkarw)*
- 🐛 Subagent sessions render like the main thread (fixes #557). (#756) *(@pkarw)*
- 🐛 The task diff stat stops counting a repointed HEAD's branch (fixes #751).

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
- ⚡ Settings → Agent accounts opens instantly — logins are warmed once at boot instead of probed per listing (2.5s → 12ms), and a disconnected answer is still re-checked within seconds.
- ✨ An added agent account can now be signed in from cezar — the row grows Connect and Check again, aimed at that account's own config dir.
- ✨ A task now says which agent, account and model produced it (`claude · Klaudiusz · opus`), naming the account its step actually spawned under.
- ✨ Settings → Agent accounts now sets the default agent, account and models once, not per repo — a project that has already chosen is never moved by it.
- ✨ Settings → Agents picks the default agent and its account in one flat list — `claude · Default`, `claude · Klaudiusz`, `codex`.
- ✨ The composer's runner pill now lists agents and logins as one flat list, so which subscription a task will bill is readable without opening anything.
- ⚡ `GET /api/v1/providers/status` no longer stalls for ~1–3s whenever its cache lapses — reads are stale-while-revalidate and the run gate re-checks a provider before refusing to start (817ms → 1–7ms).
- 🐛 `CLAUDE_CONFIG_DIR` is honoured by the Agent config pane, and the MCP listing reads `~/.claude.json` from the right place under an override.
- 🐛 `CEZ_CLAUDE_BIN` counts as "installed", so a host whose only Claude install is at a custom path is no longer reported as missing it.
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
