# Cockpit UI redesign (React + shadcn/ui)

Status: proposed
Run plan: `.ai/runs/2026-07-14-cockpit-ui-redesign-spec.md`
Research: `.ai/analysis/cockpit-ui-redesign/` (7 studies: cezar code map, agent-desktop-apps UX, agent event protocols, opencode web UI, paseo, mercato-sandboxes visuals, diff/highlighting tech)
Mockups: `docs/mockups/` (HTML, shadcn-styled, real cezar data) — screenshots in `docs/mockups/screenshots/`

## TLDR

Rebuild cezar's cockpit (`web/`) as a React + Vite + Tailwind + shadcn/ui app with the look, feel and interaction quality of today's leading coding-agent desktop apps — while keeping **every** feature cezar has today (runs, variants, review gate, plan overlay, workflows builder, multi-agent backends, skills, GitHub tab, inbox, repo view, bookmarklets). The redesign is powered by a **normalized agent-event protocol v2** (ACP-aligned; mapped from Claude Code stream-json, Codex app-server, and OpenCode SSE) so tool calls, todo/plan checklists, statuses, diffs and token usage render first-class regardless of backend. It adds a per-session **git view** (Changes/Files tabs, superb diffs and syntax highlighting, commit/push/branch, View PR) behind a **forge-driver seam** (GitHub now, GitLab-ready), a **Settings** tab (skills now; MCP and more later — coding-agent-agnostic), a full-screen **new-task** experience, handoff actions (terminal, VS Code), a dictation-labeled mic in the composer, and per-task system-prompt support. Mobile-first: great on an iPhone. Simplicity stays the product's core value: one command, zero config, everything degrades gracefully.

## Decisions (resolved with the user, 2026-07-14)

1. **Full React + Vite + Tailwind + shadcn/ui rewrite** of `web/`, compiled to static assets served by the existing Hono server. End users still get zero-config `npx cezar-cli` (no Node runtime deps added for them; the build runs at publish time).
2. **One master spec**, phased; the protocol layer, git GUI + drivers, and Settings are phases within it.
3. **Git GUI depth: review + ship actions** — diffs, changes/files, commit, push, branch switch/create, View PR / Create PR via driver. No hunk-staging, no rebase/merge-conflict UI. GitHub-only driver now; forge features hidden when unavailable.

## Problem Statement

The current cockpit is a single 3.8k-line vanilla-JS file with hand-rolled markdown, dropdowns, diff rendering and 1.9k lines of bespoke CSS. It works, but it has hit its ceiling — a dozen open issues (#354, #377–#390) are all UI/UX symptoms of the same root causes:

- **Composer welded into a 318px sidebar** (#386) — the richest surface in the app (task, attachments, workflow/skill picker, runner, model, plan) is the most cramped.
- **Tool calls and results render as flat text chips** (#381); TODO/plan lists from agents are invisible (#382); plan mode has no selected state (#383). The internal event model (`tool-call`/`tool-result`, 2 states, no plan/reasoning/diff events) can't express what the agent vendors' own GUIs show.
- **Git integration looks like a log dump** (#390): `<pre>` diffs, no file tree, no commit/push/branch actions, no PR affordance beyond a link.
- **Full-innerHTML re-renders** lose scroll and selection (#384), lists can't express ordering/emphasis (#377), chip-walls don't scale (#385), no autocomplete anywhere (#380), footer clips the theme toggle (#378), task titles aren't editable and carry no git stats (#389).
- **No real mobile layout** (#354) — one narrow-screen breakpoint.

Fixing these piecemeal inside string-template rendering means re-implementing React badly. The framework move and the visual redesign are one project.

## Research (condensed — full notes in `.ai/analysis/cockpit-ui-redesign/`)

- **Agent desktop apps** (`agent-desktop-apps-ux.md`): the leading desktop cockpits use a three-region layout (sidebar → thread → tabbed workbench: Files / Review / Terminal / Browser / side chat). Turns render as **collapsed activity groups** ("Edited 3 files, ran 2 commands") with edited files and commands visible, output/searches collapsed. Live plan checklist (pending/in_progress/completed). Review pane with git-state tabs, file tree, animated ±stats, hunk actions, open-in-editor. Home = **centered full-screen composer** with project/model/permission pickers. Sans-only typography (serif is marketing-only), pill controls, sparse accent, shimmer + smooth expand/collapse motion. Their stack: React + Radix + Shiki + cmdk + Framer Motion — validating ours.
- **Agent event protocols** (`agent-event-protocols.md`): Claude stream-json, Codex app-server (thread→turn→item), OpenCode SSE (message→part) and ACP have all converged on: an **item with explicit lifecycle** as the atomic UI unit, a small tool-status enum, **full-replacement plan checklists**, and blocking permission asks. ACP is the industry-neutral articulation; cezar's v2 schema below is ACP-aligned. cezar's current normalization drops thinking, plans, structured diffs, tool lifecycle and sub-agent attribution — all recoverable without changing backends.
- **opencode web** (`opencode-web-ui.md`): the single most copyable pattern is a **CSS-variable Shiki theme** (highlight once, retheme instantly); also: tool cards with `{icon,title,subtitle,args}` trigger + shimmer while running, context-grouping of consecutive read/search calls, **todo dock above the composer** (todos hidden from thread), streaming markdown with stable-block caching, virtualized timeline with per-session measurement cache, `@pierre/diffs`.
- **paseo** (`paseo-ui.md`): panel-registry architecture; tool-call display model computed in a shared protocol layer (not components); **dictation UX** (mic next to send, tooltip "Dictation", overlay with meter/partial transcript, cancel / insert / insert-and-send); git action **policy object** (state → primary/secondary/menu with self-explaining disabled reasons); attention model (permission > error > running > attention) driving status dots; "timeline sync doctrine" (streams for immediacy, fetch is authoritative). Anti-lesson: don't adopt React Native for a web-first product; don't hand-roll primitives.
- **mercato-sandboxes** (`mercato-visuals.md`): the brand direction. Tailwind v4 + shadcn "new-york", neutral ramp `#0d0d0d…#ffffff`, **lime `#a8f372` primary + violet `#8f86e8` secondary**, brand gradient lime→yellow→violet, Inter-only, radius 8/10/12/16, restrained shadows, grain/twinkle textures on hero/empty states only, status-dot pill grammar (color lives in the dot, 12% tint fills), quiet motion (`transition-colors`, pulse, no custom keyframes), design-guardian static test.
- **Tech picks** (`diff-highlight-tech.md`): Shiki fine-grained core + JS regex engine (no WASM, ~100–250 KB gz lazy) with CSS-variable dual themes; **Streamdown** for streaming markdown; **`@pierre/diffs`** for diff rendering (split+unified, word-level, virtualized, Shiki-shared) with `@git-diff-view/react` as fallback; **virtua** for thread virtualization; **AI Elements** (shadcn registry) as chat scaffolding, internals replaced; the 5-decision iOS checklist (`100dvh` grid, visualViewport keyboard var, safe-areas, ≥16px inputs, 44pt targets).

## Proposed Solution

One product, four moves:

1. **Replatform** `web/` to React 19 + Vite + Tailwind v4 + shadcn/ui, served exactly as today (static files from the Hono server; `web/dist` built at publish time, so `npx cezar-cli` stays zero-config and offline-capable).
2. **Normalize the wire** with an event protocol v2 (`item.*`, `plan.updated`, `turn.*`, `usage.updated`, reserved `permission.*`) computed in the runner layer, so the UI renders Claude/Codex/OpenCode identically and a future ACP backend is a transcription. v1 events remain derivable — the NDJSON files and existing GUI keep working during migration.
3. **Redesign every view** to desktop-app interaction quality with the Mercato visual language (details per view below), closing all ten issues by design rather than by patch.
4. **Extend capability where the redesign demands it**: session git view + forge drivers, Settings tab, system-prompt support, dictation, handoff actions, editable auto-summary titles.

Alternatives considered: (a) restyle the vanilla app with shadcn-like tokens — rejected: cannot deliver tool cards, virtualized threads, plan docks, or the git view without rebuilding React primitives by hand; (b) SolidJS like opencode — rejected: shadcn/Radix/AI-Elements ecosystem is React, team familiarity favors React; (c) adopt ACP as the internal wire verbatim — rejected: cezar needs run/step/check/variant semantics ACP lacks; we align vocabulary instead.

## Architecture

### Frontend

```
web/
  src/
    main.tsx, app.tsx            # react-router with REAL URLs (deep-linkable, see Routing)
    protocol/                    # UiEvent v2 types + per-backend display model (tool titles, icons, verbs)
    api/                         # typed client for /api/*, SSE hooks (global + per-run), TanStack Query
    stores/                      # small zustand stores: ui prefs, composer drafts, panel state
    components/ui/               # shadcn/ui primitives (generated, committed)
    components/                  # app primitives: StatusPill, DiffStat, ToolCard, PlanDock, Markdown, Diff facade
    views/
      runs/       (list, table, thread, review-gate, variants-compare)
      new-task/   (full-screen composer)
      git/        (session Changes/Files + repo view)
      github/     (forge tab)
      skills/  workflows/  inbox/  settings/
  dist/                          # vite build output — served by Hono, committed? NO: built on prepublish, shipped in npm tarball
  index.html                     # vite entry
```

- **Stack**: React 19, Vite, Tailwind v4 (CSS-first `@theme`), shadcn/ui (new-york, neutral base), Radix, lucide-react, TanStack Query, zustand, virtua, Streamdown, Shiki (fine-grained core + JS engine, CSS-variable dual theme), `@pierre/diffs` behind a local `<Diff>` facade, cmdk for palette/autocomplete.
- **Serving**: `src/server/server.ts` serves `web/dist/*` (falls back to a "run `npm run build:web`" page in dev when dist is missing). `npm run dev:web` = vite dev server proxying `/api` to the Hono port. `files` in package.json ships `web/dist` instead of raw `web/`; `prepublishOnly` runs both builds. Google-Fonts `<link>` is replaced by **self-hosted Inter + JetBrains Mono woff2** (offline parity, no CDN flash).
- **State/sync doctrine** (from paseo): SSE streams are for immediacy; `GET /api/runs` / `GET /api/runs/:id` are authoritative; reducers dedup by `seq`; on reconnect or tab-visibility flip, refetch and reconcile. Per-session thread cache keeps scroll position and open-tool-card state.
- **The old `web/app.js` is deleted only at the end** (Phase R7); until then both UIs ship and `?legacy=1` serves the old one as an escape hatch during the migration phases.

### Normalized agent-event protocol v2

Full schema and per-backend mapping tables: `.ai/analysis/cockpit-ui-redesign/agent-event-protocols.md` §7 (authoritative). Summary:

```ts
type ToolStatus = 'pending' | 'running' | 'completed' | 'failed' | 'declined';
type ToolKind   = 'read'|'edit'|'delete'|'move'|'search'|'execute'|'think'|'fetch'|'task'|'plan'|'other';
type StopReason = 'end_turn'|'max_tokens'|'refusal'|'cancelled'|'timeout'|'error';

type UiEvent =
  | { type:'session.started'; sessionId; backend; model?; cwd?; tools?[] }
  | { type:'session.ended'; reason:StopReason; message? }
  | { type:'session.error'; message; fatal:boolean }
  | { type:'turn.started'; turnId } | { type:'turn.completed'; turnId; stopReason; usage?; costUsd? }
  | { type:'item.started'|'item.updated'|'item.completed'; item:UiItem }
  | { type:'item.delta'; itemId; field:'text'|'reasoning'|'output'; delta:string }
  | { type:'plan.updated'; entries:{content; status:'pending'|'in_progress'|'completed'|'cancelled'; priority?; activeForm?}[] }
  | { type:'permission.requested'|'permission.resolved'; ... }   // reserved; wired when auto-approve becomes optional
  | { type:'usage.updated'; usage:TokenUsage; costUsd? }         // raw counts + contextWindow, never pre-weighted
  | { type:'image'; itemId?; mediaType; data };

type UiItem =
  | { kind:'message'; id; role; text; phase?; parentItemId? }
  | { kind:'reasoning'; id; text; parentItemId? }
  | { kind:'tool'; id; name; toolKind:ToolKind; title:string; status:ToolStatus;
      input?; output?; error?; diffs?:FileDiff[]; locations?; exitCode?; parentItemId? };
```

- Emitted by the runners (`src/core/*-runner.ts`) alongside v1 events; the RunManager persists v2 to the same NDJSON stream (new `type` values — the current GUI already renders unknown types as dim notes, so mixed files are safe).
- **Key mappings**: Claude `TodoWrite` (or the `TaskCreate`/`TaskUpdate` fold) / Codex `turn/plan/updated` (NOT an item — the app-server `ThreadItem` union has no todo variant) / OpenCode `todowrite` → `plan.updated` (full-replacement, identical semantics); Claude `thinking` blocks / Codex `reasoning` items / OpenCode `reasoning` parts → reasoning items; Codex `item/commandExecution/outputDelta` → `item.delta{field:'output'}` (live command output); Claude `Edit` input & Codex `fileChange.changes` & OpenCode `patch` parts → structured `FileDiff`s; Claude `parent_tool_use_id` / OpenCode `subtask` → `parentItemId` (sub-agent nesting); OpenCode turn-end switches to `session.idle`.
- The **tool display model** (title/verb/icon per tool name + `toolKind`) lives in `web/src/protocol/` next to the types — computed once, used by thread, activity groups and notifications (paseo's pattern).
- **Performance guardrails**: the RunManager **coalesces `item.delta` events** (~30–50 ms flush per item) before SSE fan-out, and **persists item snapshots, not raw deltas**, so NDJSON write frequency stays at today's level and replay needs no delta reduction. Rationale and the full SSE/replay/render analysis: `.ai/analysis/cockpit-ui-redesign/protocol-rationale-and-performance.md`.
- **System prompt**: `AgentRunSpec` already carries `systemPrompt` per backend (`--append-system-prompt` for claude; codex and opencode prepend it to the first user message). v2 adds it end-to-end: the system prompt is configured in **Settings → Agents** (`config.json: systemPrompt?`) and applied to every run; `POST /api/runs` keeps an optional `systemPrompt?` override for programmatic callers (bookmarklets, scripts) — it is deliberately NOT part of the new-task composer UI. Works with every backend because it rides the existing seam — coding-agent-agnostic by construction.

### Backend parity requirement (hard rule)

Every UI capability in this spec MUST work with **all coding agents cezar supports — claude, codex, and opencode — from day one of the feature**, and with any backend added later through the same seam. No view may be built against one backend's quirks: the UI consumes only protocol-v2 events, and each runner owes the full mapping. Parity matrix (source events per backend):

| UI capability | claude | codex | opencode |
|---|---|---|---|
| Plan/todo dock (#382) | `TodoWrite` input, or `TaskCreate`/`TaskUpdate`/`TaskList` results folded into a snapshot | `turn/plan/updated` notification | `todowrite` tool |
| Tool cards + statuses (#381) | `tool_use`/`tool_result` | typed items + status | tool parts + state |
| Reasoning line | `thinking` blocks | `reasoning` items/deltas | `reasoning` parts |
| Live command output | — (result only; card fills on completion) | `outputDelta` | running-state `metadata` |
| Structured diffs in edit cards | `Edit`/`Write` input | `fileChange.changes` | `patch` parts |
| Sub-agent nesting | `parent_tool_use_id` | review-mode items | `subtask` parts |
| Usage/context gauge | `usage` + `total_cost_usd` | `tokenUsage` (no USD) | `tokens` + `cost` |
| System prompt | `--append-system-prompt` | prepended first message | prepended first message |
| Plan mode / turn end / stop reasons | `result` | `turn/completed|failed` | `session.idle` |

Where a backend genuinely lacks a signal (e.g. claude has no live command output), the UI degrades per-capability (the card fills when the result arrives) — never per-backend (no "works best with X" features). **Acceptance per implementation step: the golden-fixture suite passes for all three backends**, and the phase's QA pass exercises each backend at least once (CEZ_DRY_RUN mock counts for claude in CI).

### Testing strategy (mandatory — every step ships unit tests)

The repo has no test runner today; R1 step 1 introduces **vitest** (server: node environment; web: happy-dom + React Testing Library) and adds `npm test` to `validation.commands` in `.ai/agentic.config.json`. From then on, **no implementation step of this spec merges without unit tests for what it built**:

- **Protocol v2** (the highest-value target): golden-fixture tests — recorded real NDJSON/JSON-RPC/SSE transcripts per backend (claude, codex, opencode) replayed through each runner's mapper, asserting the exact `UiEvent` sequence (tool lifecycle, plan.updated replacement semantics, parentItemId nesting, stop reasons, usage). Fixtures live in `src/core/__fixtures__/`.
- **Server**: every new endpoint (changes/files/git-commit/push/branch/PATCH title/open-in-editor) gets request/response tests via Hono's `app.request()` — zod rejection cases, degradation 409s (no git / no remote / hosted mode), path-traversal guards.
- **Pure logic**: git action policy object, `deriveAttention`, title summarizer, diffStat parser, forge driver detection — table-driven unit tests (these are pure functions by design so they're trivially testable).
- **Web components**: RTL tests for behavior-bearing components (tool card status rendering, plan dock state math, composer autocomplete triggering, route ↔ tab mapping, capability/forge gating hides the right buttons); no snapshot-only tests.
- **Design guardian**: the mercato static-scan vitest (no raw hex outside tokens, no amber text, no native `confirm()`) runs in the same `npm test`.
- E2E (Playwright, `om-integration-tests`) stays the QA layer per phase; unit tests are the merge gate.

### Forge-driver seam (GitHub now, GitLab later)

```
src/server/forge/
  types.ts     # ForgeDriver: detect(), listIssues(), listPRs(), createPR(draft), prStatus(branch), viewUrl(kind,ref)
  github.ts    # current gh-CLI logic from github.ts/pr.ts moved behind the interface
  index.ts     # resolveForge(repoInfo): remote host → driver | null
```

- `GET /api/health` gains `forge: {kind:'github', available:boolean, reason?} | null` and `capabilities: {localHandoff: boolean}`. The UI shows forge features (GitHub tab, Create/View PR, PR links, checks badges) only when `forge.available`; plain-git features (diffs, commit, push, branches) need only git. This formalizes today's behavior (#372) and is the extension point for GitLab — one new driver file, no UI changes.
- Existing `/api/github` response shape is kept (BACKWARD_COMPATIBILITY) and marked as the GitHub driver's serialization.

### Git/session API additions

New endpoints (all zod-validated, all degrade with 409 + human reason, never HTML errors):

| Endpoint | Purpose |
|---|---|
| `GET  /api/runs/:id/changes` | structured diff for the session worktree vs base: `{files:[{path,status,adds,dels,patch}], stat:{adds,dels,files}}` (replaces text-blob `/diff` for the new UI; `/diff` stays) |
| `GET  /api/runs/:id/files?path=` | worktree file tree / file content (size-capped) for the Files tab |
| `POST /api/runs/:id/git/commit` | `{message}` — commit -A in the worktree |
| `POST /api/runs/:id/git/push` | push branch (sets upstream) |
| `GET  /api/repo/changes` | same structured shape for the main repo working tree |
| `POST /api/repo/branch` | `{name, from?}` create/switch (repo view's branch actions) |
| `PATCH /api/runs/:id` | `{title?}` — editable titles (#389) |

- **Auto-summary titles** (#389): after the first agent turn, the RunManager derives a title (first assistant sentence, capped; planner model summarization only when configured) and sets `RunRecord.titleSummary`; `title` stays the raw task. UI shows `titleSummary ?? title`, editable inline (PATCH).
- **Diff stats in lists** (#389): RunManager computes `diffStat {adds,dels,files}` on turn-end (cheap `git diff --shortstat`) and stores it additively on RunRecord.

### Deployment modes — local vs hosted

cezar's default stays exactly `npx cezar-cli` in a repo: zero config, zero flags, cockpit on localhost. But the same server can run on a VPS/remote box, where "open a terminal on my machine" makes no sense. This becomes explicit:

- **`CEZ_REMOTE=1`** (env flag; auto-implied when the server binds a non-loopback host) switches the server to hosted mode: `capabilities.localHandoff:false` in `/api/health`.
- When `localHandoff` is false the UI **completely hides** (not disables) every local-machine affordance: the Terminal button, `Open in VS Code` / open-in-editor, "Open in Finder"-style actions, and the copy-resume-command hints switch to plain "resume with: `claude --resume <id>`" text (still copyable — the user runs it wherever they have the checkout).
- Everything else (thread, git view, commit/push, PR, settings, dictation) is location-independent and stays.
- Server-side, the `open-in-cli`/`open-in-editor` endpoints return 409 with a reason in hosted mode — defense in depth, the UI never shows them anyway.

### Settings

New nav tab, registry-driven so sections grow without layout changes:

- **Skills** (now): the current skills catalog + refresh move here, with project-first ordering (#377).
- **Bookmarklets** (now): the generic launcher and the available per-skill bookmarklets get a dedicated, discoverable Settings subpage; the former Skills deep link remains compatible.
- **Appearance** (now): theme light/dark/system, accent choice (lime default), UI density. Persisted in `ui-state.json` (additive keys).
- **Agents** (now): default runner, per-runner model presets, **the system prompt** (the single place it is edited), base branch — today's scattered `PUT /api/config` knobs in one place. Coding-agent-agnostic: sections describe capabilities (`runner`, `model`, `system prompt`), never vendor-specific config formats.
- **MCP, notifications, keyboard** (later): placeholder sections listed in the registry but hidden until implemented.

## Design system

- **Tokens**: Mercato sheet verbatim (`mercato-visuals.md` §1) — neutral ramp, lime `#a8f372` primary (near-black ink on it), violet `#8f86e8` secondary, `--danger #ef4444`, emerald/amber status colors (amber never as text), radius `8/10/12/16`, shadow-xs/sm/md/modal, dark `#0d0d0d` canvas with `#171717` cards and invisible borders (elevation via surface steps), light = white cards + `#ebebeb` borders. shadcn variables mapped, not duplicated.
- **Brand**: gradient tile logo (lime→yellow→violet, dark glyph — cezar's ⚡ glyph in the Mercato construction); grain + twinkle canvas textures **only** on hero/empty/lifecycle surfaces (new-task screen, empty states, review-accepted moment) — data-dense screens stay flat; the `CenteredState` template (72px tinted icon tile + title + subtitle + actions) for every empty/loading/error state.
- **Typography**: Inter only for UI (400/500/600; hierarchy by weight and color, not size — paseo's rule), JetBrains Mono for code/commands/paths/branches/diff-stats, `tabular-nums` for numbers. The current Source Serif 4 h1s are retired (per the desktop-apps research: serif belongs to marketing surfaces only). Self-hosted woff2.
- **Status grammar**: one canonical `deriveAttention(run)` function (permission > error > waiting/review > running > unseen) driving a single 7px dot per row — pulsing while transitioning; pills = `bg-muted` neutral or 12% tinted fills. Same function feeds future notifications.
- **Motion**: `transition-colors` as the workhorse; card hover-lift (150ms translate + shadow); `animate-pulse` skeletons/dots; text shimmer on running tool titles; spring height on tool-card expand (350ms, no bounce); animated ± diff-stat counters; `prefers-reduced-motion` renders static everywhere.
- **Copy rules** (paseo constitution): sentence case, imperative buttons, states described not editorialized, one accent CTA per surface, destructive red only inside confirm dialogs. Terminology fixed: **Task** (a run), **Session** (the agent conversation), **Workflow**, **Skill**, **Changes** (the diff).
- **Design guardian**: port mercato's static-scan test (no raw hex outside tokens/brand files, no amber text, no `bg-white/black` outside primitives, no native `confirm()`) as a vitest run in the validation gate.

## UI/UX — view by view

### Routing — every surface is a URL

Deep-linkable, pasteable, refresh-safe navigation (react-router; the Hono server serves `index.html` for every non-`/api` GET so any URL cold-loads):

```
/                      → tasks overview — the full-width table (PR #392 behavior)
/new                   → new task (existing ?skill=&ref=&auto=&key= bookmarklet params unchanged)
/tasks/:id             → thread   /tasks/:id/changes  /tasks/:id/files   (tab in the path)
/compare/:groupId      → variants compare
/git                   /github    /github/issues/:n   /github/prs/:n
/inbox                 /workflows /workflows/:name
/settings              /settings/skills  /settings/bookmarklets  /settings/appearance  /settings/agents
```

Selected run, active tab, review-gate state — all restorable from the URL; sharing a `/tasks/:id/changes` link drops a teammate (same machine/tailnet, or hosted mode) exactly where you are. Unknown routes → CenteredState 404 with a "Back to tasks" action. The legacy `/new` contract and launch-key auto-start keep working verbatim.

### App shell & navigation

- **Desktop**: shadcn sidebar (icon-collapsible) — brand lockup + repo/branch chip (live-updating via SSE health refresh, fixes #369), **"New task" primary button** (replaces the embedded composer, #386), nav (Tasks, Inbox·badge, Git, GitHub·hidden-when-no-forge, Skills, Workflows, Settings), then the task quick-list (grouped: Needs you / Working / Recent / Archived; variant groups collapse with per-variant dots; `⌘K` palette for everything). Footer: **Tools dropdown** replacing the env-chip row — one compact trigger (aggregate status dot + "Tools"; hover tooltip shows the cezar version and any tool needing attention) opening a menu that lists every installed/configured tool (claude, codex, opencode, gh, git, …) with its status dot and **version number**, a per-tool setup link when unavailable (the hint from `/api/health` checks, e.g. "install gh and run `gh auth login`"), and a footer row with a **cog icon → Settings → Agents**. Plus the cezar version chip (update pulse, #368) and the theme toggle as a proper icon button (fixes #378).
- **Mobile (<md)**: bottom-sheet-first. Sidebar becomes an overlay drawer (one-position state machine, backdrop, swipe); a slim top bar (menu, title, status dot, kebab); the composer is a docked bottom bar with safe-area padding. Layout is a `100dvh` grid (`auto 1fr auto`), only the thread scrolls, visualViewport keyboard variable lifts the composer, all inputs ≥16px, touch targets ≥44pt.
- Every list keeps scroll/selection across updates (React keyed rendering fixes #384 by construction).

### New task (full-screen, #386)

- Route `/new` (also the `/new?skill=…` bookmarklet target, unchanged contract). **Centered composer** on a grain+twinkle hero surface, agent-desktop home style: big textarea ("Describe a task for the agent…"), then a pill row: **Workflow/Skill picker** (cmdk searchable dropdown — project skills first and bold, global after, #377/#385 pattern), **Runner** (hidden unless >1 installed), **Model**, **Variants ×1/×2/×3** (control returns — server path never left), **Base branch**. (The system prompt is a Settings → Agents concern, not a per-task composer control.)
- **Plan mode is a toggle, not a button** (#383): segmented `Start | Plan first` control with a clearly selected state; in plan mode, submit produces the plan review (below) instead of running.
- Attachments: paperclip + paste, thumbnail row with remove; drag-drop anywhere on the surface.
- Composer intelligence (shared component with thread composer): `/` opens skill autocomplete (#380) inserting `/skill-name` refs; `@` mentions files (worktree-aware, fuzzy); **mic button labeled "Dictation"** (tooltip + aria) using the Web Speech API when available — recording state swaps the footer for an overlay with timer + partial transcript + cancel / insert / insert-and-send (paseo's exact pattern); hidden with a "not supported in this browser" hint otherwise.
- ⌘N from anywhere; **⌘↵ and Ctrl+↵ both submit — in every prompting surface** (new-task composer, thread reply, review notes, plan-mode refinement): one shared `useSubmitShortcut` hook, macOS and Windows/Linux modifiers always registered together, kbd hints render the platform's symbol. Queued form state survives navigation (draft store).

### Task thread (the chat view)

- **Turn grouping**: user message (right-aligned bubble) starts a turn; the agent's work renders as a stream of items. Consecutive read/search/list tool items collapse into **context groups** ("Explored 4 files · 2 searches", expandable); edits and commands stay visible as individual cards (the desktop-apps research consensus: edits and commands visible, output collapsed).
- **Tool cards** (#381): shadcn Collapsible with the `{icon, title, subtitle, args}` trigger — `Bash` → "Ran `npm test`" with live-streaming output (v2 `item.delta{output}`) and exit-code badge; `Edit/Write` → file path + inline `<Diff>` (word-level, expandable context); `WebFetch/Search` → labeled query/url; MCP/unknown tools → generic card with heuristic label. Title shimmers while `running`; card locked until it has detail; failed = danger tint with unwrapped error message. Older streaks fold ("▸ N earlier tool calls").
- **Reasoning**: collapsed "Thinking…" line streaming the summary, expandable, dimmed — visible while active, folded when done.
- **Plan/todo dock (#382)**: `plan.updated` renders a **dock pinned above the composer** (not in-thread; TodoWrite tool cards are hidden): collapsed = "3/7" odometer + current item with animated label; expanded = checkbox list (pending ○ / in_progress pulsing ◐ / completed ✓ with strikethrough animation). Also mirrored as a compact progress line in the run header.
- **Step rail** (workflow steps ≠ plan): the existing ✓/●/✗ steps rail stays in the header, restyled as mercato's startup-checklist (emerald check / amber-tinted spinner / faint circle / danger X above a thin progress bar); check-steps render as command cards with pass/fail pills.
- **Markdown**: Streamdown (stable-block memoization, unterminated-block repair) + Shiki CSS-variable dual theme; every code block gets copy + language chip; fixes #379's renderer glitches by replacing the renderer.
- **Thread performance**: virtua virtualization when a thread exceeds ~300 nodes, bottom-anchored streaming, "Jump to latest ↓" pill, per-session measurement + open-card cache; plaintext-first code paint at final line-height (no height jumps).
- **Header**: editable title (auto-summary, pencil-on-hover, #389), meta line (workflow · runner · model · branch chip · ± diff stat · tokens with context-window gauge · cost), status pill, action bar (Finish / Continue / Terminal / **VS Code** / Notes / Archive / Cancel / Delete) — Terminal keeps the copy-command 409 fallback; **VS Code** = `POST /api/runs/:id/open-in-editor` (`code <worktree>`, driver-detected, hidden when absent).
- **Review gate**: unchanged flow, redesigned surface — parked runs show a review banner + the session **Changes tab** (below) with notes box, `Send back`, `Draft PR`/`PR ↗`, and the manual-merge fallback line. Accepting celebrates with a brief twinkle moment (reduced-motion-safe).
- **Composer**: same intelligent composer as /new (skills `/`, files `@`, dictation, attachments); Alt+A / Alt+C quick replies kept; waiting state pulses "The agent is paused, waiting for your reply"; closed state offers Continue.
- **Variants compare**: kept as a dedicated surface, restyled: column per variant (status, tokens/cost, ± stat, Progress excerpt), full diffs below, "Pick this one" as the single accent CTA per column.

### Session git view — Changes & Files tabs (#390)

Tabs sit in the run detail next to the thread: **Session | Changes | Files** (mobile: swipeable segments).

- **Changes**: file tree (left, folders collapsible, per-file ±) + `<Diff>` viewer (right): unified/split toggle (unified+wrap forced <md), Markdown preview toggle (≥md, shown only when the diff holds a `.md` file — renders it as a document: full worktree text in the task view, the patch's new side in the repo view), word-level intra-line diff, expandable context, syntax highlighting shared with chat, sticky per-file headers, whole-view expand/collapse, animated aggregate ± stat. Empty state: "No changes yet". Toolbar: **Commit** (message box prefilled with auto-summary; commit -A), **Push**, branch chip, **Create PR** (forge; → **View PR** once open, also shown in header and task rows), **Open in editor**. Buttons come from a **git action policy object** (paseo): pure function of git/forge state → `{primary, secondary, menu}` where disabled entries explain themselves ("Push unavailable — no remote configured").
- **Files**: worktree file browser (tree + file preview with Shiki, images inline) — read-only v1, the "what does the workspace look like now" affordance.
- **Repo view** (nav "Git") becomes the same components pointed at the main working tree: working-tree Changes, recent commits (click → structured commit diff), branch list with switch/create, base-branch picker. Forge-specific rows (PR links, checks) render only when the driver is available.

### Task list & table (#389)

- The **full-width table is the Tasks overview and home** (`/`): the Tasks nav item always lands here — also when already active ("back to overview") — per PR #392, which removed the list/table toggle. **Active/Archived filter tabs live in the table header** and share state with the sidebar quick-list tabs. Columns keep live CPU/Mem/Procs and gain editable Title (auto-summary), ±, and branch; clicking a row (or a sidebar quick-list item) opens `/tasks/:id` with Tasks still active.
- Sidebar quick-list rows: status dot, editable auto-summary title, `± stat` chip, PR chip, age/queue position.

### GitHub tab (forge tab)

- Kept as-is functionally (issues/PRs lists, detail with markdown body + label chips + checks badge, drag-to-composer, hand-to-agent) with: **searchable cmdk dropdowns for workflow and skills** replacing chip walls (#385), project-first skill ordering (#377), and the whole tab hidden (nav item too) when `forge` is null — with the env chip explaining why.

### Skills, Workflows, Inbox

- **Skills** moves under Settings (catalog + detail + refresh) — project skills first and bold (#377), stable scroll/selection (#384). Bookmarklets have their own Settings subpage while the former Skills deep link stays compatible. A read-only skills browser remains reachable from pickers ("View skill" preview in the dropdown).
- **Workflows builder**: same capabilities (canvas, drag from palette, YAML import/export/preview, 8-step limit), rebuilt on dnd-kit + shadcn — visual language only, no behavior change.
- **Inbox**: card list restyled (CenteredState empty state, status dots, Run/Dismiss buttons); badge logic unchanged.

### Cross-cutting

- **Command palette** (⌘K, cmdk): tasks, views, actions ("New task", "Toggle theme", per-run actions), skills.
- **Notifications** (Phase R6): browser Notification on `waiting`/`review`/failed via the attention function — off by default, Settings toggle.
- **Accessibility**: focus-visible rings everywhere (ink light / lime dark), aria-labels on all icon buttons, decorative canvases `aria-hidden`, reduced-motion fallbacks, WCAG AA on all text tokens.

## Data model changes (all additive)

- `RunRecord` += `titleSummary?`, `diffStat? {adds,dels,files}`, `systemPrompt?` (echo of what the run used).
- NDJSON gains v2 event `type`s alongside v1 (mixed files valid; old GUI shows unknowns as notes; new GUI prefers v2, falls back to v1 rendering for old runs).
- `ui-state.json` += `theme?`, `density?`, `accent?`, `runsView` kept (schema is `.passthrough()` — safe).
- `config.json` += `systemPrompt?`, `editor?` ('code' | custom command).

## Edge Cases & Failure Scenarios

The degradation table is the product (README promise: everything degrades):

| Absent/failing | Behavior |
|---|---|
| No git | Git view shows CenteredState explainer; tasks run in place; commit/push/branch hidden; maxParallel=1 (unchanged) |
| Git, no remote | Commit works; Push/PR disabled with reason ("no remote — add one or merge locally"), manual-merge line shown |
| No `gh` / logged out / offline | `forge:null` → GitHub tab + PR buttons + checks hidden; env chip carries the hint; **everything else works** |
| Backend CLI missing | Runner pill hides it; model pill collapses to auto (unchanged) |
| `web/dist` missing (dev) | Server serves a plain page: "run `npm run dev:web` or `npm run build:web`" |
| Web Speech unavailable (Firefox, some WebViews) | Mic hidden; tooltip in composer overflow explains |
| Hosted mode (`CEZ_REMOTE=1` or non-loopback bind) | Terminal / VS Code / open-in-editor hidden entirely; resume hints render as copyable commands; endpoints 409 |
| SSE drops / phone sleeps | Reconnect → authoritative refetch + seq-dedup reconcile; thread restores scroll + open cards |
| Huge diffs / files | >500 KB files use the virtualized diff path; >400 KB raw endpoints stay capped; "Load full diff" gate beyond caps |
| Unknown v2 event type / unknown tool | Generic tool card with heuristic label; never raw JSON, never a crash |
| Old runs (v1-only NDJSON) | Thread renders from v1 events (current fidelity), no migration needed |
| `prefers-reduced-motion` | All canvas art static, shimmer/springs off |

## Risks & Impact Review

- **Bundle size / offline**: Shiki JS-engine + lazy grammars + self-hosted fonts keep first paint small (~<300 KB gz target for the shell) and fully offline; the design-guardian + a bundle-size check land in CI (validation gate gains `npm run build:web`).
- **`@pierre/diffs` is young**: pinned version + local `<Diff>` facade; documented fallback `@git-diff-view/react` behind the same facade.
- **Compatibility policy**: this program updates `BACKWARD_COMPATIBILITY.md` with an explicit **redesign waiver** — compatibility must not limit the redesign. Hard-kept: CLI commands/flags, readability of existing on-disk state (old `runs.json`/NDJSON v1 always parseable), the `/new` bookmarklet + launch-key contract, workflow YAML and skills formats, additive-only config. Waived for the duration of R1–R7: the `web/` asset layout, npm tarball layout (`web/dist`), and internal-only `/api` shapes whose sole consumer is the bundled UI — breaks ride the phase PR with a release-note line and a minor bump; no deprecation window. The waiver expires at R7.
- **Scope discipline**: multi-agent engine, worktree/queue logic, review-gate semantics, CEZ:DONE contract, skills/workflow formats are untouched — this program is UI, protocol normalization, and the listed API additions only.
- **Migration risk**: phased view-by-view with the legacy UI reachable until R7; each phase ships a working app (validation gate + `CEZ_DRY_RUN=1` smoke on every phase).
- **Rollback**: any phase can be reverted independently (legacy UI intact until R7); npm packaging change reverts by restoring `files: ["web"]`.

## Phasing

Each phase is independently shippable; issues in parentheses close in that phase.

- **R1 — Platform + shell**: Vite/React/Tailwind/shadcn scaffold, tokens, fonts, Hono static serving + dev proxy, app shell (sidebar, nav, theme system, env chips, ⌘K), task quick-list on live SSE. (#378, #369, #354 groundwork)
- **R2 — Protocol v2**: runner emitters + RunManager persistence + `web/src/protocol` display model; auto-summary titles + diffStat on RunRecord; system-prompt end-to-end. (#389-data, system prompt)
- **R3 — Thread**: full task detail — turns, tool cards, context groups, reasoning, plan dock, step rail, Streamdown+Shiki, virtua, composer (skills `/`, `@` files, dictation, attachments), review gate, variants compare. (#381, #382, #379, #380, dictation)
- **R4 — New task + list**: full-screen composer with plan-mode toggle + variants; task list/table upgrades with editable titles + ± stats. (#386, #383, #389)
- **R5 — Git view + forge seam**: structured changes/files endpoints, git actions (commit/push/branch), forge driver extraction, Changes/Files tabs, repo view rebuild, Create/View PR, open-in-editor/VS Code handoff. (#390, #385-adjacent forge gating)
- **R6 — Remaining views + Settings**: GitHub tab (searchable dropdowns), Skills→Settings, Workflows builder, Inbox, Settings (skills/bookmarklets/appearance/agents), notifications. (#385, #377, #384)
- **R7 — Retirement + polish**: delete legacy `web/app.js`/`style.css`, packaging flip to `web/dist`, design-guardian in gate, iOS pass on every view, docs/screenshots refresh.

## Implementation Plan

Steps are sized for autonomous runs (om-auto-create-pr / -loop, one PR per phase, `Source doc:` = this spec). Every step leaves the app working and passes `npm run typecheck && npm run build` (+ `npm run build:web` once it exists).

### Phase R1 — Platform + shell
1. Scaffold `web/` Vite+React+TS+Tailwind v4+shadcn (new-york); tokens from the design system section; self-hosted fonts; `npm run dev:web`/`build:web`; **vitest setup (server + web projects) with `npm test` added to `validation.commands`**; Hono serves `web/dist` with legacy fallback + `?legacy=1`.
2. App shell: react-router with the deep-link route map (server catch-all → index.html), sidebar (brand, New task button, nav, footer), theme system (pre-paint script, light/dark/system), mobile drawer + `100dvh` grid + safe areas.
3. API client + SSE hooks (global stream, reconcile doctrine) + task quick-list (groups, variant collapse, status dots) + runs table shell.
4. ⌘K palette; env chips popover; CenteredState template; design-guardian test scaffold.

### Phase R2 — Protocol v2
5. `UiEvent`/`UiItem` types + emitters in claude runner (incl. thinking, TodoWrite→plan, parent_tool_use_id) with unit tests on recorded fixtures.
6. Codex runner mapping (items, statuses, outputDelta, todoList→plan) + OpenCode (parts, session.idle turn-end, todowrite→plan) + fixtures.
7. RunManager: persist v2, compute titleSummary + diffStat on turn-end; `PATCH /api/runs/:id` title; `POST /api/runs` `systemPrompt` + config default; tests.

### Phase R3 — Thread
8. Thread skeleton on v2 with v1 fallback: turns, message items, Streamdown+Shiki singleton.
9. Tool cards + context groups + reasoning + live output streaming; tool display model.
10. Plan dock + step rail + check-step cards.
11. Composer (shared): autocomplete (`/` skills, `@` files), attachments, dictation, quick replies; thread composer wiring (messages/finish/continue).
12. Review gate + variants compare on new surfaces; virtua virtualization + scroll caches; iOS pass for the thread.

### Phase R4 — New task + list
13. `/new` full-screen composer (pickers, plan-mode toggle, variants, bookmarklet params, drafts).
14. Plan review overlay (drag-reorder, save-as-chain) on the new surface.
15. Task list/table: editable titles, ± stats, PR chips; header meta with context gauge.

### Phase R5 — Git view + forge
16. Server: `/changes`, `/files`, `git/commit|push`, `/api/repo/changes`, `/api/repo/branch`; forge driver extraction + health `forge` + `capabilities.localHandoff` (`CEZ_REMOTE`/non-loopback detection); tests.
17. `<Diff>` facade on `@pierre/diffs` (fallback impl behind same props); Changes tab (tree, viewer, action policy bar); Files tab.
18. Repo view rebuild; Create PR→View PR flow; open-in-editor endpoint + buttons; mobile diff mode.

### Phase R6 — Views + Settings
19. GitHub tab (cmdk dropdowns, forge gating); Inbox restyle.
20. Workflows builder on dnd-kit; Skills under Settings (+ ordering); dedicated Bookmarklets subpage; Settings shell (registry: skills/bookmarklets/appearance/agents) + notifications toggle.

### Phase R7 — Retirement
21. Delete legacy web app; packaging flip (`files: web/dist`, prepublish build); design-guardian + bundle check in validation gate; full iOS + degradation-matrix QA sweep.
22. **Refresh every screenshot in the main `README.md`** — the "A look inside" gallery (`docs/screenshots/live-run.png`, `review-gate.png`, `variants-compare.png`, `plan-chain.png`, `workflow-builder.png`, `github-issues.png`) still shows the pre-redesign cockpit. Recapture each against the new UI through the configured browser provider (agent-browser), at the same framing, and update any README prose that describes the old chrome. This is the last step of the program — the README is the product's shop window and must never show a UI that no longer exists.
