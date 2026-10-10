# cezar web cockpit — deep code map

Repo: the repo root (branch `main`). Frontend: `web/index.html` (110 ln), `web/app.js` (3755 ln, vanilla JS, zero deps, no build step), `web/style.css` (1862 ln). Server: `src/server/server.ts` (Hono, 859 ln), served at `127.0.0.1:<port>` (default **4321**; bookmarklets scan 4321–4330). Data dir: `<repo>/.ai/cezar/` (runs.json, `runs/<id>.ndjson`, `<id>.handoff.md`, `<id>-images/`, `todos.json`, `config.json`, `ui-state.json`, `workflows/*.yaml`, launch-key).

---

## 1. UI inventory — every user-facing feature (must-keep list for redesign)

### 1.1 Layout skeleton
- **Persistent left sidebar (318px fixed)**: brand row (open-mercato logo + "cezar" + repo chip), new-task composer, nav tabs, run list (with its own Active/Archived sub-tabs), footer (env chips + theme toggle).
- **Main pane**: one `.view` section per tab: `#view-runs` (contains `#detail` AND the swap-in `#runs-table`), `#view-workflows`, `#view-inbox`, `#view-github`, `#view-repo`, `#view-skills`.
- **`#plan-overlay`**: full-main-area overlay for the proposed chain (moved out of sidebar after 2026-07-11 feedback: "too cramped").
- Narrow-screen media query exists (sidebar shrinks, splits stack) but no real mobile layout (open issue #354).

### 1.2 New-task composer (sidebar; issue #386 wants it full-screen)
- Auto-growing `<textarea>` (40px → 92px on focus → up to 220px, animated), placeholder "Describe a task for the agent…".
- **⌘/Ctrl+Enter submits**; run button is an up-arrow icon with tooltip "Run the task (⌘↵)".
- **Attachments**: 📎 button + `⌘V` paste + drag-drop text; up to 4 images, 5 MB each; thumbnails (`#task-thumbs`) with click-to-remove; base64'd client-side, delivered as image blocks in the first agent message.
- **Source pill** (`#src-pill`, one pill for chains AND skills): opens a menu with a search box + Workflows|Skills tabs (opens on Skills by default, per feedback/#344); Enter picks first match; empty-state hint "No skills yet — drop Markdown files into .ai/skills/".
- **Runner pill** (`#runner-pill`): hidden unless >1 backend installed; claude / codex / opencode (detected via /api/health checks).
- **Model pill** (`#model-pill`): per-runner presets, `''` = auto. Claude: opus/sonnet/haiku aliases + pinned ids; Codex: gpt-5.1-codex family; OpenCode: `provider/model` ids. Collapses to just "auto" when the runner CLI is absent.
- **Plan button** (star icon): POST /api/plan → plan overlay ("Planning…" busy state). Issue #383: the Plan button has no selected/active-mode state.
- Inline `#form-error` line.
- **Deep-link / bookmarklet path**: `/new?skill=…&ref=…&auto=1&key=…` — auto-start with valid launch key, otherwise prefills form + toast + focuses Run.
- Last-used source persisted server-side in `ui-state.json` (`lastTask`), restored on boot.
- Variants ×1/×2/×3: **UI control was retired** — `state.variants` still wired to POST body; server path fully alive.

### 1.3 Nav tabs (sidebar)
Runs (bolt icon), Inbox (+ live count badge), Repo, GitHub, Skills, Workflows.

### 1.4 Run list (sidebar, below tabs)
- Sub-tabs: **Active N** (dot when something needs you) | **Archived N** | archive-all-finished button (icon + count) | **list/table view toggle** (#348).
- Grouped buckets in order: **Needs you** (waiting/review) → **Working** (running/queued) → **Recent** (terminal) → **Archived**. Sort: status priority then recency.
- Row: colored status dot (pulsing for waiting/review/running), title, optional `PR↗` link, compact age ("2m") or queue position (`#2`).
- **Variant groups** (spec 010): runs sharing groupId collapse into one tile with ▸/▾ expander, per-variant status dots, `N×` count, and a `⚖` **Compare** button once all variants are terminal.
- Empty states: "No runs yet — describe a task above." / "Nothing archived yet."

### 1.5 Runs table view ("task manager", #348)
- Full-width main pane table; columns: Status pill, Task (title, task-text tooltip), Skill/workflow (smart label — `(planned)`/`(inbox)` show the first agent step's name), PR link, Tokens, Cost, **live CPU% / Mem / Procs** (from the `usage` SSE stream, ~2 s ticks; finished runs show persisted peaks dimmed with "peak" tooltip), Started (+ duration).
- Row click → back to list mode + run detail. Choice persisted in ui-state (`runsView`).

### 1.6 Run detail (thread view)
- **Header**: meta line (workflow · tokens · cost · started/finished ago · runner (if not claude) · model · branch · PR link), serif `<h1>` title (task tooltip), status pill (with queue position), **steps rail** (`✓/●/✗/○ name ×iterations → …` with tooltips: kind/status/tokens/error/sessionId), error box, resume-hint line (`take over interactively: cd <worktree> && claude --resume <id>`).
- **Action bar** (icon+label text buttons, context-dependent):
  - `✓ Finish` (waiting → close session; review → accept without PR)
  - `▶ Continue` (reopen finished session in-process) + `Terminal` (open-in-cli; on failure copies the resume command to clipboard)
  - `Diff` (toggle diff panel; only when worktree exists)
  - `Notes` (toggle handoff-notes panel, markdown-rendered)
  - `Remove worktree` (archived runs w/ worktree)
  - `Archive`/`Unarchive`, `Cancel` (active) / `Delete` (terminal, with confirm)
- **Slide-down panels**: `#review-panel`, `#diff-panel` ("What this task changed"), `#notes-panel` ("Handoff notes").
- **Review gate** (status `review`, spec 009): full colored diff (collapsible per-file `<details>`), notes textarea, `↩ Send back` (feedback → continue same session) + `Draft PR` (or, if the agent already opened a PR, a "PR ↗ open on GitHub" link instead), manual-fallback line (`git merge <branch>`) on PR failure. Diff reloads on each re-entry into review.
- **Transcript** (`#log`): NDJSON replay + live SSE, dedup by `seq`; auto-scroll with near-bottom detection + "↓ jump to bottom" button.
  - `text` → markdown-rendered assistant prose (custom escape-first renderer #346: headings, tables, task lists, nested lists, blockquotes, fenced code, emphasis, links/autolinks).
  - `tool-call` → chip "✓ <verb> `<primary arg>`" (verb map: Bash→Ran, Edit→Accepted edits to, Write→Created…; never raw JSON).
  - `tool-result` → one-liner or collapsible `<details>` (first 140 chars + "show" → `<pre>` capped 10 000 chars). Issue #381 wants these Claude/Codex-style.
  - **Tool streaks**: consecutive tool calls/results collapse — last 3 visible, older fold under "▸ N earlier tool calls".
  - `check-output` → command card with pass/fail pill + output `<pre>`.
  - `image` → screenshot card (lazy `<img>`, filename footer, click → lightbox).
  - `step-start` → labeled divider ("name · attempt N"); `step-end` shown only when failed.
  - `note`/`lifecycle` → dim "· message" lines; `user-message` → right-side bubble (+ "[2 images]" count); `error` → red ✗ line.
  - `token-usage`/`cost`/`turn-end`/`done` → suppressed (reflected in header).
  - **Queued placeholder** (#351): animated 3-dot state, "Waiting for a free agent slot — #N in queue".
- **Composer** (bottom message bar): textarea (Enter sends, Shift+Enter newline), 📎 attach + paste screenshots (4×5 MB), thumbnails, disabled when session closed ("Session closed — Continue to reopen."), "The agent is paused, waiting for your reply" pulsing note in `waiting`.
- **Hotkeys**: Alt+A → sends "Yes, approved.", Alt+C → "Continue." into the selected run.

### 1.7 Plan overlay (spec 008)
Proposed chain: task line, fallback note ("planner unavailable — single-step plan"), rationale, numbered draggable step cards (grip, name, skill badge / check badge, prompt/command hint, ✕ remove), HTML5 drag-reorder, actions: `▶ Start` (POST /api/runs with inline steps) / `Save as chain` (prompt() for name → POST /api/workflows) / `Discard`.

### 1.8 Variants compare view (spec 010)
`⚖ <title>` header, column per variant: letter, status pill, tokens/cost, `git diff --stat` `<pre>`, handoff Progress excerpt, `✔ Pick this one`. Below: per-variant collapsible full diffs. Pick → winner lands on review gate; losers cancelled/archived/worktrees removed.

### 1.9 Inbox (spec 007)
Cards from `.ai/cezar/todos.json` (agent-appended follow-ups): summary, age, action, "source task" link (or "source task deleted"), PR link, suggested skill; buttons `▶ Run` (starts a task — one-step suggested-skill workflow or quick-task; entry then hidden but kept as audit trail) and `Dismiss` (delete). Live updates via fs.watch → SSE `todos`. Badge on nav tab. Issue #355 (closed): actionability.

### 1.10 GitHub tab
- Split view: left list (Issues · N / Pull requests · N sub-tabs, count shows `30+` until the background full fetch of up to 1000 lands; "synced Xm ago" refresh button), right detail.
- Rows: kind icon (issue green / PR accent), title, #number, author, age, "↗ run queued" flag. **Rows are draggable into the task box** (prefills the same prompt).
- Detail: meta line (number, kind, author, age, comments, +adds −dels, "open on GitHub ↗"), title, label chips, checks badge (✓ passing / ✗ failing / ○ pending), markdown body, **"Hand this to the agent"** panel: workflow chip row (toggle; click again deselects), skill chips (filter input appears when >10; toggled chips never filtered out — issue #385 wants a searchable dropdown like the composer instead), `▶ Run agent on this issue/PR` + "✓ queued / View in Runs →".
- Unavailable state: friendly card with reason + "⟳ Try again" (needs `gh` logged in + GitHub remote; "Everything else in cezar works without it").

### 1.11 Repo tab
- Header: root · branch · remote (mono).
- **Agent base branch picker** (`<select>` of local+origin branches, deduped, `cez/*` filtered) → PUT /api/config; hint text re: worktrees + PR target.
- **Working tree**: changed-file rows (2-char status badge colored add/delete), "clean"; collapsible "Diff vs HEAD" (rendered diff, capped 400 kB).
- **Recent commits** (20): rows expand inline to `git show` (message/stat `<pre>` + rendered patch, capped 200 kB) + "View on GitHub ↗" when remote is github. Issues #390 (git look-and-feel) and #360 target this pane.

### 1.12 Skills tab
- Split view: left filterable list (name, source tag `cezar|ai|agents|global|team`, description), pinned bottom row "Run from GitHub (bookmarklets)". ⟳ Refresh → POST /api/skills/refresh (git-fetch team repos).
- Detail: name + source tag, path (+ team repo origin), description, "Used by" (workflows referencing the skill), full skill body `<pre>`.
- **Bookmarklet panel** (spec 011): explanation, "One-click launch (auto-submit)" checkbox, generic launcher ("prefills the form — nothing starts by itself"), filterable per-skill `⚡ /skill-name` draggable `javascript:` links + Copy buttons; launch key lazy-fetched.
- Issues: #377 (project skills first + bold, global after unbolded), #384 (list scroll loses selection), #380 (skills autocomplete in every prompt box).

### 1.13 Workflows tab — builder (spec 012)
- Header: h1, Delete (file workflows only), ⬆ Import (YAML paste → POST /api/workflows/parse), ⬇ Export (download .yaml), ✓ Save (POST /api/workflows; 409+confirm overwrite flow).
- Name pill input, live step/skill count, "edit" chip row of existing workflows + "+ new".
- **Canvas**: numbered step cards (grip, icon, name, description, badges `check`/`prompt`/`unknown`, × remove), drop-gap targets between cards ("drop to insert"), "runs top to bottom" note, empty-state big drop slot.
- **Right aside**: skill palette (drag-in, filter, "already in flow" checkmarks), live `workflow.yaml` preview (compact `skills:` form when the flow is a pure skill stack, else full `steps:`) + Copy, portability note.
- Max 8 steps (server limit mirrored).

### 1.14 Chrome / global
- **Repo chip** (top of sidebar): `repo / branch`, links to forge when the remote is browsable (#366); "no git — tasks run in place". (Issue #369: should live-update on branch switch.)
- **Env chips** (footer): version chip (amber pulse + `⬆ x.y.z` when npm registry has newer, #368) + one LED chip per check (claude/codex/opencode/gh/git) with hints.
- **Theme toggle**: mono text button "LIGHT ☼"/"DARK ☾", persists to localStorage `cez-theme`, pre-paint script prevents flash. Issue #378: it's visually cut in half in the footer.
- **Toast** (`#toast`, 4 s) and **lightbox** (click-anywhere-to-close image zoom).
- SSE resilience: global stream re-syncs full run list on every (re)connect and on tab-visibility flip; per-run stream dedups replay by `seq`.

---

## 2. Server API surface (all same-origin except /api/health CORS `*`)

Static: `GET /`, `GET /new` (same SPA), `GET /app.js`, `GET /style.css`, `GET /open-mercato.svg` (read per request — live dev iteration).

| Method & path | Purpose / request → response |
|---|---|
| `GET /api/health` | CORS `*` + OPTIONS preflight (bookmarklet port scan). → `{version, latestVersion?, repoRoot, repo:{root,branch,remote?}\|null, checks:[{name,available,version?,hint?}], defaultRunner}` |
| `GET /api/launch-key` | `{key}` — bookmarklet auto-start secret (file `.ai/cezar/launch-key`) |
| `GET /api/skills` | `Skill[]` `{name, description?, body, path, source:'ai'\|'cezar'\|'agents'\|'global'\|'team', team?}` |
| `POST /api/skills/refresh` | clone/fetch team skills repos, → merged catalog |
| `GET /api/ui-state` / `PUT /api/ui-state` | GUI prefs in `.ai/cezar/ui-state.json`; schema `{lastTask?:{source:'workflow'\|'skill',ref}, runsView?:'list'\|'table'}` `.passthrough()` — merged, unknown keys survive |
| `GET /api/workflows` | `{workflows: WorkflowDef[]}` (built-ins + `.ai/cezar/workflows/*.yaml`) |
| `POST /api/workflows` | `{name, description?, steps?\|skills? (XOR), overwrite?}` → 201 `{path,name}`; 409 `{error, exists:true}` when file exists w/o overwrite |
| `DELETE /api/workflows/:name` | file workflows only; path-traversal guarded |
| `POST /api/workflows/parse` | `{yaml}` → normalized `{name, description?, steps}` (server owns YAML parsing; GUI stays dep-free) |
| `POST /api/plan` | `{task}` → `{steps: WorkflowStepDef[], rationale, fallback:bool}` — one cheap runner call, degrades to 1-step quick-task plan, never errors |
| `GET /api/runs` | `RunRecord[]` each with additive live `usage?:{cpuPct,rssBytes,procCount}` |
| `POST /api/runs` | `{workflow?\|steps? (XOR, 1–8), task, model?, runner?, variants?(1–3), images?(≤4, ≤~5MB ea)}` → 201 RunRecord, or `{runs:[...]}` for variants. Variants w/o git → 400 with explanation |
| `POST /api/runs/archive-finished` | → `{archived:n}` |
| `POST /api/runs/:id/archive` | `{archived?:bool}` (default true) → RunRecord |
| `GET /api/runs/:id` | RunRecord (+usage) |
| `POST /api/runs/:id/cancel` | → `{cancelled}` |
| `POST /api/runs/:id/messages` | `{text≤100k, images[]}` (needs one of them) → `{delivered:true}`; 409 `session closed` |
| `POST /api/runs/:id/finish` | gracefully close waiting session / accept review → `{finished:true}`; 409 no open session |
| `POST /api/runs/:id/continue` | `{text?}` reopen finished session in-process (resume) → `{continued:true}`; 409 with reason |
| `POST /api/runs/:id/open-in-cli` | spawn terminal in worktree with per-backend resume cmd (`claude --resume` / `codex resume` / `opencode --session`) → `{opened,command}`; 409 `{error, command}` (GUI copies to clipboard) |
| `GET /api/runs/:id/handoff` | handoff.md as `text/markdown` ('' when not seeded) |
| `GET /api/runs/:id/images/:file` | persisted agent screenshots (png/jpg/webp/gif), immutable cache headers, basename-pinned |
| `GET /api/runs/:id/diff` | text; worktree vs baseBranch, or "(no worktree — ran in the repo working tree)" |
| `POST /api/runs/:id/pr` | review gate → autosave commit → push → `gh pr create --draft` → 201 `{url,dryRun}`; run flips to done. Failures 409 `{error, manual:'git merge <branch>'}`. CEZ_DRY_RUN=1 fakes URL |
| `POST /api/runs/:id/remove-worktree` | explicit cleanup → `{removed:true}` |
| `DELETE /api/runs/:id` | run + ndjson + handoff + images + worktree/branch |
| `GET /api/groups/:groupId` | variants compare data: per run `{id,variant,title,status,archived,tokensUsed,costUsd,diffStat,handoffExcerpt}` |
| `POST /api/groups/:groupId/pick` | `{runId}` → winner to `review` (if non-empty diff), losers cancelled+archived+worktrees removed → `{winner}` |
| `GET /api/todos` / `DELETE /api/todos/:id` / `POST /api/todos/:id/start` | inbox read / check-off / turn into run (409 already started) |
| `GET /api/runs/:id/events` | **SSE**: full NDJSON replay then live; events `run-event` (RunEvent JSON), `run` (RunRecord), `ping` every 15 s. Replay-race-safe (buffer + seq dedup) |
| `GET /api/events` | **SSE** global: `run` (summary updates), `run-deleted` `{id}`, `todos` (full array), `usage` (runId→{cpuPct,rssBytes,procCount} map, ~2 s while runs live, never persisted), `ping` 15 s |
| `GET /api/github?refresh=1&limit=n` | via `gh` CLI, 60 s cache; → `{available, reason?, repo?, syncedAt?, issues:GithubItem[], prs:GithubItem[]}` |
| `GET /api/repo` | `{info\|null, status[], log[], branches[], baseBranch}` |
| `PUT /api/config` | `{baseBranch?:string\|null, defaultRunner?}` merged into raw `.ai/cezar/config.json` (user keys survive) |
| `GET /api/repo/diff` | working-tree diff vs HEAD (text, 400 kB cap) |
| `GET /api/repo/commit/:sha` | `git show --stat --patch` text (200 kB cap; sha regex-validated) |

Config file (`.ai/cezar/config.json`, zod, degrade-to-default): `skillsRepos` (default `open-mercato/skills`), `maxParallel` (default 2; non-git = 1), `defaultRunner` (claude), `plannerModel` (sonnet), `baseBranch?`.

---

## 3. Internal normalized event model (THE existing schema — reuse it)

### 3.1 `AgentEvent` (src/core/agent-runner.ts — what backends emit)
```ts
type AgentEvent =
  | { type: 'text'; text: string }                                  // streamed assistant text (deltas)
  | { type: 'tool-call'; id: string; tool: string; input: unknown }
  | { type: 'tool-result'; toolCallId: string; result: string; isError: boolean }
  | { type: 'image'; mediaType: string; data: string }              // raw base64 (from tool results)
  | { type: 'token-usage'; tokensUsed: number }                     // cumulative, cost-weighted
  | { type: 'cost'; usd: number }
  | { type: 'session'; sessionId: string }                          // backend's real session/thread id
  | { type: 'turn-end' }
  | { type: 'note'; message: string }
  | { type: 'done' }
  | { type: 'error'; message: string };
```
`ContentBlock` (user → agent): `{type:'text',text}` | `{type:'image',source:{type:'base64',media_type,data}}` (Anthropic wire format verbatim).

### 3.2 Persisted `RunEvent` (NDJSON lines, `.ai/cezar/runs/<id>.ndjson`)
`{ seq:number, ts:ISO, stepId?:string, type:string, ...fields }` — `type` mirrors AgentEvent **plus engine lifecycle types** appended by RunManager (src/workflows/run.ts):
- `lifecycle` `{message}` — run started/cancelled/failed, "goal achieved — session closed", restart notes, variant pick/archive, review accepted.
- `note` `{message}` — worktree ready/failed, `$ command` echoes, degradations.
- `step-start` `{stepId,name,kind:'agent'|'check',iteration}` / `step-end` `{stepId,status,error?}`.
- `check-output` `{stepId, command, exitCode, text}` (check steps).
- `user-message` `{stepId?, text, imageCount}`.
- `image` `{stepId, url, name}` — the manager persists raw base64 to `<id>-images/` and **re-emits with URL** (`/api/runs/:id/images/<file>`) instead of data.
- `text` events are flushed/aggregated per turn by the manager (`{type:'text', text, stepId}`).
- `token-usage`/`cost`/`turn-end`/`done`/`error` pass through with stepId.
GUI renders unknown types as raw JSON note (forward-compatible).

### 3.3 `RunRecord` / `StepState` (src/runs/store.ts, runs.json)
```
RunRecord: id, title, workflow, task, model?, runner?('claude'|'codex'|'opencode'),
  status: 'queued'|'running'|'waiting'|'review'|'done'|'failed'|'cancelled',
  createdAt, startedAt?, finishedAt?, tokensUsed, costUsd?,
  pullRequestUrl? (regex-sniffed from transcript — "the janitor trick"),
  worktreePath?, branch? ('cez/<id8>'), baseBranch?,
  groupId?, variant?('A'|'B'|'C'), peakRssBytes?, peakProcCount?,
  archived, archivedAt?, currentStepId?, error?, steps: StepState[], workflowDef? (for post-restart re-queue #367)
StepState: id, name, kind('agent'|'check'), status(+ 'pending'|'skipped'), iterations,
  tokensUsed, startedAt?, finishedAt?, error?, sessionId?, costUsd?
```
Store: atomic tmp+rename `runs.json` (debounced 300 ms), append-only NDJSON per run (sync appendFileSync), EventEmitter bus (`run`, `event`, `deleted`) feeding the SSE endpoints. Prune: 300 active / 500 archived. On open without `keepLive`, live-looking runs are marked failed ("interrupted"); `review` survives restarts by design (pure data, no live process).

### 3.4 Backend → normalized mapping
- **Claude** (`claude --input-format stream-json --output-format stream-json --verbose --permission-mode acceptEdits`, `--session-id`/`--resume`, `--append-system-prompt`, `--allowedTools` incl. `Bash(prefix:*)` narrowing, `--add-dir`): `assistant.content[]` text/tool_use → text/tool-call; `user.content[] tool_result` → tool-result + image events; `result` msg → fallback text, cost, turn-end; usage cost-weighted via `costWeightedTokens`. EOF-hang watchdog (SIGTERM 8 s → SIGKILL 4 s); 30-min default timeout (0 = interactive/off). CEZ_DRY_RUN=1 swaps in `scripts/mock-claude.mjs`.
- **Codex** (`codex app-server`, JSON-RPC 2.0 JSONL over stdio; `initialize` → `thread/start`/`thread/resume` → `turn/start`/`turn/steer`/`turn/interrupt`; sandbox `workspace-write`, approvalPolicy `never`): `item/agentMessage/delta` → text; `item/started`/`item/completed` (non-message item types) → tool-call/tool-result; `thread/tokenUsage/updated` → token-usage; `turn/completed` → turn-end; thread id → session event. No tool allowlist (spec.allowedTools ignored); system prompt prepended to first user message.
- **OpenCode** (`opencode serve --hostname 127.0.0.1 --port <random 40000–59999>`, bound URL read from stdout, HTTP + `/event` SSE; `POST /session`, `POST /session/:id/message`, `/abort`): `message.part.updated` text parts → per-part-cursor text deltas (assistant-role-filtered); tool parts → tool-call once + tool-result on completed/error; message info tokens/cost → token-usage/cost deltas; model as `provider/model`.
- Session seam identical across backends: `AgentSession {result, pid, sendMessage, end, interrupt, open}`; `SessionOptions.autoEndAfterFirstTurn` (250 ms reopen window) distinguishes one-shot steps from interactive.
- **CEZ:DONE** marker (handoff contract): a turn whose text ends with `CEZ:DONE` → manager strips it, closes session, marks done (frees the maxParallel slot; #347). Otherwise turn-end → status `waiting` (needs you).

---

## 4. CSS token system & fonts

- **Fonts** (Google Fonts `<link>`, quiet offline fallback): `--serif: "Source Serif 4"` (h1s/brand, opsz 8..60 wght 420/500/600), `--sans: "Instrument Sans"` (body, 400/500/600), `--mono: "JetBrains Mono"` (400/500/600). Body 14px/1.5.
- **Tokens** (`:root` dark default; `[data-theme="light"]` overrides; toggle stamps `data-theme` pre-paint from localStorage):
  - Surfaces: `--bg #111116`, `--panel #16161c`, `--panel2 #20202a`, `--card #17171e`; lines `--line`/`--line2` (alpha whites); light theme is warm paper (`#faf9f6`/`#f2f0eb`/…).
  - Text scale: `--text`, `--text2`, `--text3`.
  - Buttons: `--btn`/`--btn-text` (inverted-pill primary).
  - Accents in **oklch**: `--accent` (violet 295), `--green` (155), `--amber` (78), `--red` (25); derived `--accent-soft`, `--accent-line` via `color-mix(in oklab …)` — status tints everywhere are `color-mix(… 10–13%, transparent)`.
  - `--shadow-sm`; pill radius 99px everywhere; `cz-pulse` keyframe for live dots.
- **Component classes**: `.btn-dark` (solid pill) / `.btn-ghost` (outline pill) / `.btn-text` (bare) / `.chip-toggle`; `.pill` + `.dot` status colors; `[data-tip]` pure-CSS tooltips (+ `.tip-right`); `.pill-select` dropdown pattern; `.split`/`.split-list`/`.split-rows`/`.split-detail` master-detail; `.detail-panel` slide-downs; `.md` markdown scope; diff classes `.diff-file/.diff-add/.diff-del/.diff-hunk/.diff-meta`; `.wb-*` builder; `.rt-*` runs table; thin custom scrollbars.
- No CSS reset lib, no utility framework; ~1862 lines hand-rolled. One `@media` breakpoint for narrow screens.

---

## 5. git / gh degradation model (the "never a hard error" rule)

- **No git at all** (`getRepoInfo` → null): health `repo:null` → chip "no git — tasks run in place"; tasks run in the repo working dir, `maxParallel` forced to 1; variants POST → clear 400; `/api/repo` → `{info:null,…}` and Repo tab shows a one-line explanation; run diff endpoint returns the "(no worktree…)" sentence.
- **git present, worktree creation fails**: run continues in the repo working tree with a `note` event.
- **No origin remote**: repo chip stays plain text; draft-PR → `{ok:false, error:'no git remote — add one … or merge the branch locally'}` (409 + `manual: git merge <branch>` shown by the GUI).
- **gh missing/logged-out/offline**: `fetchGithub` catches everything → `{available:false, reason}` (ENOENT → "gh CLI not found — install it and run `gh auth login`"); GitHub tab renders a hint card, never an error; env chip goes red with hint. Draft PR: ENOENT → "gh not found — install the GitHub CLI…", auth-looking stderr appends "(try `gh auth login`)". PR base: `origin/x` normalized, raw-sha base dropped (gh falls back to default branch). Open issue #372 asks to also *disable* the GitHub pane and gh-dependent features proactively.
- **Terminal absent** (open-in-cli): 409 with the exact shell command; GUI copies it to clipboard.
- **CEZ_DRY_RUN=1**: mock claude binary, mock GitHub catalog, fake PR URL — whole cockpit demoable offline/tokenless.
- Planner, todos watch, team-skills refresh, ui-state writes: all best-effort/fallback, never block.

---

## 6. Pain points the current markup/CSS cause (issues ~377–390 + adjacent)

1. **#386 — composer cramped**: the whole new-task surface (textarea + 4 pills + plan + attach) is squeezed into the 318px sidebar. Wants a full-screen "New task/session" à la Claude/Codex desktop, leaving only an entry point in the nav. Root cause: composer is structurally welded into `#sidebar` in index.html.
2. **#378 — theme toggle cut in half**: `#side-foot` flex row; when env chips wrap, the mono text button gets clipped. Symptom of the footer's ad-hoc flex + text-as-icon toggle.
3. **#377 / #384 — skills list ordering & scroll**: catalog is a flat name-sorted list; wants project skills first (bold) and global after (plain); clicking a skill re-renders the whole split (`renderSkills()` rebuilds innerHTML) so `.split-rows` scroll resets and the selection scrolls out of view. General pattern: full-innerHTML re-renders lose scroll/focus (GitHub view already hand-patches scrollTop; skills view doesn't).
4. **#385 — GitHub hand-off chips don't scale**: long skill catalogs render as a chip wall + a filter input; wants the composer's searchable-dropdown pattern reused. (Chip row + workflow chips have no search UX parity with `#src-pill`.)
5. **#383 — Plan button lacks a selected state**: no pressed/active styling; plan mode is invisible until the overlay appears.
6. **#379 — chat text formatting glitches**: hand-rolled markdown renderer (mdBlocks/mdInline) mis-renders some agent output (soft-wrap paragraph joining, emphasis edge cases). It's escape-first-safe but not CommonMark.
7. **#381 — tool results display**: current `↳ first-line… show` collapsible is considered inferior; wants Claude Code/Codex-style rendering (diffs for edits, syntax, per-tool layouts). Current markup renders every result as a flat string.
8. **#382 — TODO/plan checkbox lists**: agents' TodoWrite/plan items are invisible (TodoWrite is just a "Updated the todo list" chip); wants live checkbox-list rendering — needs a new normalized event or tool-call-aware rendering.
9. **#380 — skills autocomplete**: no `/skill` or @-mention autocomplete in any prompt textarea (composer, message bar, review notes).
10. **#389 — task list management**: titles are truncated task text, not editable; wants auto-summary titles (editable) + git +/− stats in list and table. RunRecord has no `diffStat` summary field today.
11. **#390 / #360 — git integration look**: Repo pane is plain rows + `<pre>` diffs; wants a proper git UI (screenshot-driven). #365 wants image previews inside diffs + open-in-system links. #359 PR checkout, #358 label filtering, #356 issues view — GitHub pane growth.
12. **#369 — repo chip is boot-time-static** (health fetched once in `init()`); branch switches outside cezar never reflect.
13. **Inline-style sprawl**: ~40 `style="…"` attributes in app.js templates (spacing, font sizes) — fights any token-driven redesign.
14. **#354 — no real mobile layout**; single breakpoint only.
15. General architecture friction for a redesign: all views are innerHTML-string templates re-rendered wholesale with per-view scroll/focus hand-fixes; state is one global mutable object; pill/pills/chips/menus are three separate hand-rolled dropdown systems (`.pill-select`, `.chip-toggle` walls, native `<select>` in Repo).

---

## 7. Key files
- UI: `web/index.html`, `web/app.js`, `web/style.css`
- Server: `src/server/server.ts`, `git.ts`, `github.ts`, `pr.ts`, `launch-key.ts`, `open-in-terminal.ts`
- Engine: `src/workflows/run.ts` (RunManager: queue/slots, worktrees, review gate, CEZ:DONE, persistImage), `src/workflows/types.ts`, `src/runs/store.ts`
- Backends: `src/core/agent-runner.ts` (the seam), `claude-cli-runner.ts`, `codex-app-server-runner.ts`, `opencode-server-runner.ts`, `backend-detect.ts`, `process-usage.ts`, `usage.ts`, `runner-factory.ts`, `ndjson.ts`
- Aux: `src/planner.ts`, `src/todos.ts`, `src/handoff.ts`, `src/skills.ts`, `src/skills-remote.ts`, `src/config.ts`, `src/git-worktree.ts`, `src/index.ts` (CLI, port 4321)
