# Unreleased

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
- ✨ **Agent accounts: run one project on your work login and another on your personal one.**
  The same CLI logged in twice — `CLAUDE_CONFIG_DIR=~/.claude-klaudiusz claude`, or `CODEX_HOME` for
  Codex — is now something cezar can address. Add the extra config folder under **Settings → Agent
  accounts**, pick which account each project uses in **Settings → Agents**, and override it for a
  single task from the composer. Each account reports its own connection state and gets its own
  **Connect**, and "Open in → Claude CLI" hands the terminal the account that actually ran the
  work, so `--resume` lands on the right conversation instead of silently starting a fresh one.
  Each agent gets its own tab, showing whether it is installed, its version, and its logins.
  **Show details** on a login reveals the email, organization and plan it is signed in as, and
  opens any of that account's own config files — `settings.json`, `CLAUDE.md`, `config.toml`,
  `AGENTS.md` — resolved inside *that* folder rather than the default account's, through the same
  **Open in…** menu the task thread uses, so you can pick the system default or any editor the
  machine has. Identity is opt-in
  by construction: it has its own request, made only when you expand a row, so nothing carries an
  email until you ask.
  Zero-config is untouched: with one login there is no new control anywhere, and no new variable in
  any spawned process. Accounts live in their own `~/.cezar/agent-accounts.json` rather than a key
  in `config.json`, so switching to an older cezar and back cannot lose them — a version that has
  never heard of accounts does not open that file. cezar does not go looking for accounts (a folder
  is one because you said so, and you can type a path that does not exist yet), and it never
  silently falls back to another account when the one you chose is unavailable,
  because that would bill the wrong subscription while the UI said otherwise. OpenCode is not
  supported yet: it keeps credentials outside its config folder, so a second folder would change
  settings without changing the account. Spec: `.ai/specs/2026-07-29-agent-profiles.md`.
- ✨ **The two mixed-format routes do real HTTP content negotiation.** `GET /api/v1/repo/commit/:sha`
  (legacy text blob or structured commit payload) and `GET /api/v1/runs/:id/files` (JSON listing or
  an image's raw bytes) now honour the request's `Accept` header, answer `Vary: Accept`, and set a
  `Content-Type` confirming what they actually sent. Purely additive: the `?structured=`/`?raw=`
  flags still decide whenever the request carries one, `*/*` (what `fetch` and `curl` send) is read
  as "no preference" and keeps each route's existing default, so every current caller's answer is
  byte-identical. What is new is that a client that really does ask — an `<img>`, a browser
  navigation — gets the other representation without the flag, under the same allowlist, size cap
  and sandbox CSP as before.

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
