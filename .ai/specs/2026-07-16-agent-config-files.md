# Agent config files in Settings (global vs local, raw + highlighted)

Status: proposed
Issue: [#404](https://github.com/open-mercato/cezar/issues/404)
Gate: resolved with the user, 2026-07-16 (Q1–Q4 below)

## TLDR

cezar picks *which* agent runs; it cannot say *how* that agent behaves. Claude, Codex and OpenCode each read their own config files — `CLAUDE.md`, `.claude/settings.json`, `.mcp.json`, `AGENTS.md`, `config.toml`, `opencode.json` — and cezar is blind to every one: whatever MCP servers, hooks and permissions the underlying CLI happens to have are inherited invisibly. This spec adds a Settings surface that reads and writes those files **raw**, in their native format, with syntax highlighting, showing each scope's file beside the others and stating honestly which one the agent will obey. cezar never parses, merges or re-serializes a vendor schema — it is a file editor that knows where the files live and what the vendor documents about precedence, so it cannot drift when the formats change.

## Decisions

Taken with the user before drafting:

1. **Per project.** Originally "project" meant the one repo bound to the server. After the
   multi-project workspace landed in #521, it means the active registered project: repo-relative
   files resolve from that project's `ProjectContext.root`; user-scope files remain machine-wide.
   The legacy unprefixed API remains the boot-project alias.
2. **Not source-file routing.** No path-glob → runner mapping. The subject is only the agent's own config.
3. **Raw file editor.** Real file bytes in a highlighted textarea. Validate on save, refuse to write a file that does not parse. cezar never re-serializes.
4. **MCP is first-class** — the `mcp` placeholder (`registry.tsx:103-110`) ships.
5. **Scopes shown together**, precedence explicit.
6. **One PR**, phased into `om-auto-create-pr-loop`-sized steps.

Resolved at the gate:

- **Q1 — worktree reality → seed the `*.local` layer, label the rest honestly.** Tracked files are edited at the repo root and labelled "applies to runs once committed"; the gitignored personal layer is seeded into each run's worktree so one layer takes effect immediately. Rationale in §"The worktree problem".
- **Q2 — hosted mode → the whole feature is read-only.** *Revised from the gate's "global scope only" after the security review (§"Why writes are a local-only capability").* Viewing every scope's file and precedence works everywhere; **no scope is writable when `capabilities.localHandoff` is false.** The original narrower gate left repo-local `.claude/settings.json` — which defines `hooks` (auto-firing shell commands that bypass cezar's `allowedTools`) — writable on an unauthenticated network endpoint, i.e. a persistent remote-code-execution primitive. Writing config is now a local-machine capability like open-in-*.
- **Q3 — new `agent-config` section + unhide `mcp`.**
- **Q4 — offer create as an explicit action**, `mkdir -p` the parent on save; never write without a click.

## Problem Statement

cezar's agent configuration stops at *capabilities it invented itself*: `defaultRunner`, `defaultModels`, `systemPrompt` (`src/config.ts:23-71`). Everything the vendors actually expose is invisible:

- **MCP is entirely unconfigurable and entirely unseen.** `AgentRunSpec` (`src/core/agent-runner.ts:23-54`) has no MCP field. Whatever servers the user's `claude`/`codex`/`opencode` happen to have configured are inherited implicitly. cezar's only acknowledgement of MCP is cosmetic — parsing the `mcp__server__tool` name convention for display (`src/core/tool-display.ts:152-156`) — plus a `hidden: true` placeholder that has been deferred twice (R6 → R7 → "post-program", `.ai/runs/2026-07-15-cockpit-ui-r7-retirement/HANDOFF.md:19`).
- **The files are unreachable from the cockpit.** There is no `AGENTS.md`/`CLAUDE.md`/`settings.json` handling anywhere in `src/` — grep returns zero hits. To change how the agent behaves you leave cezar, find the repo in a terminal, and edit files by hand — in a product whose entire premise is that you do not have to.
- **Precedence is genuinely hard to hold in your head, and cezar could hold it for you.** Three agents, three *different* precedence models (see §Research). Even an expert cannot answer "which settings file is actually in force right now" without re-reading three vendor docs.
- **The worktree makes it worse, not better** (§"The worktree problem"): the file you edited in your checkout is frequently not the file your agent read.

## Research

Verified against primary vendor docs on 2026-07-16. **This section is the spec's load-bearing content**: the catalog and every UI precedence string derive from it, and the single most important finding is that *the three agents do not share a precedence model*, so one generic "local overrides global" label would be a lie for most rows.

### Claude Code

Settings ([docs](https://code.claude.com/docs/en/settings)):

| File | Scope | Format | Tracked |
|---|---|---|---|
| `managed-settings.json` (system/MDM) | managed | JSON | n/a — **out of scope** (IT-owned, root-writable) |
| `~/.claude/settings.json` | user | JSON | no |
| `<repo>/.claude/settings.json` | project | JSON | yes |
| `<repo>/.claude/settings.local.json` | local | JSON | no — auto-excluded |

> "Managed (highest) … Command line arguments … **Local**: overrides project and user settings … **Project**: overrides user settings … **User** (lowest)"

Merge semantics are **per-key replacement, with one documented exception**:

> "Permission rules behave differently because they **merge** across scopes rather than override."

> "When Claude Code creates `.claude/settings.local.json`, it configures git to ignore the file. If you create the file yourself, add it to your gitignore manually."

**Hot reload — documented, and it decides our mid-run story**:

> "Edits to most keys apply to the running session without a restart. This includes `permissions`, `hooks`, and credential helpers like `apiKeyHelper`."

Memory ([docs](https://code.claude.com/docs/en/memory)) — a *different* model from settings:

> "All discovered files are **concatenated** into context rather than overriding each other."

Locations: `~/.claude/CLAUDE.md` (user) → `./CLAUDE.md` or `./.claude/CLAUDE.md` (project) → `./CLAUDE.local.md` (local, gitignore manually). `@path` imports, max four hops. **Claude Code does not read `AGENTS.md`**:

> "Claude Code reads `CLAUDE.md`, not `AGENTS.md`. If your repository already uses `AGENTS.md` … create a `CLAUDE.md` that imports it"

And, remarkably, the vendor documents our exact worktree problem:

> "If you work across multiple git worktrees of the same repository, a gitignored `CLAUDE.local.md` only exists in the worktree where you created it."

MCP ([docs](https://code.claude.com/docs/en/mcp)) — **the scopes do not map to the files you would guess**:

| Scope | Available in | Shared | File |
|---|---|---|---|
| Local | current project only | no | `~/.claude.json` (under that project's path) |
| Project | current project only | yes, via VCS | `.mcp.json` at project root |
| User | all projects | no | `~/.claude.json` |

Precedence: local → project → user. Key is `mcpServers`. The docs flag the trap explicitly:

> "The term 'local scope' for MCP servers differs from general local settings. MCP local-scoped servers are stored in `~/.claude.json` (your home directory), while general local settings use `.claude/settings.local.json`."

Project servers require interactive approval; `enableAllProjectMcpServers` / `enabledMcpjsonServers` in settings pre-approve them.

### Codex

Config ([reference](https://developers.openai.com/codex/config-reference)): `~/.codex/config.toml` (user; `$CODEX_HOME` relocates it) and project-scoped `.codex/config.toml`, "loaded only when you trust the project", with some keys (provider, auth, telemetry) not overridable at project scope. MCP servers are `[mcp_servers.<id>]` tables **inside those same files** — Codex has no separate MCP file.

AGENTS.md ([guide](https://developers.openai.com/codex/guides/agents-md)) — a third model, "override-file then concatenate":

> "In your Codex home directory … Codex reads `AGENTS.override.md` if it exists. Otherwise, Codex reads `AGENTS.md`. Codex uses only the first non-empty file at this level."
> "Starting at the project root … it checks for `AGENTS.override.md`, then `AGENTS.md`, then any fallback names in `project_doc_fallback_filenames`. Codex includes at most one file per directory."
> "Codex **concatenates** files from the root down, joining them with blank lines."

Hot reload: the instruction chain is built "when it starts (once per run)". Config-file reload is **not documented**.

### OpenCode

Config ([docs](https://opencode.ai/docs/config/)): `~/.config/opencode/opencode.json` (global) and `opencode.json` (project root). JSON **and JSONC**. A fourth model — *per-key merge, no scope hierarchy beyond order*:

> "Configuration files are **merged together, not replaced**. … Later configs override earlier ones only for conflicting keys."

MCP lives under the `mcp` key **inside those same files**. Supports `{env:VAR}` and `{file:path}` substitution.

AGENTS.md ([docs](https://opencode.ai/docs/rules/)) — a fifth model, *first-match-wins on the whole file*:

> "The first matching file wins in each category. For example, if you have both `AGENTS.md` and `CLAUDE.md`, only `AGENTS.md` is used."

Order: local (walking up) → `~/.config/opencode/AGENTS.md` → `~/.claude/CLAUDE.md` (compat fallback). Files **do not merge**. An `instructions` key adds more files.

### What the research forces

1. **Five precedence models across three vendors.** Per-key replace (Claude settings), merge-this-one-key (Claude permissions), concatenate-all (Claude memory, Codex AGENTS.md), per-key merge (OpenCode config), first-match-wins (OpenCode AGENTS.md). **The precedence sentence must be per catalog entry, authored from the docs — never computed, never generic.**
2. **MCP is not a file.** Only Claude has a dedicated `.mcp.json`; Codex and OpenCode keep servers inside their main config. The MCP section is therefore a *view* that routes each runner to the file that holds its servers — for two of three, the same file the Agent config section opens.
3. **`~/.claude.json` is not editable.** It holds two of Claude's three MCP scopes *and* Claude's own machine state (per-project history, onboarding). Handing a raw editor over a state file is how you destroy someone's Claude install. It stays read-only — see §Architecture.
4. **`<repo>/AGENTS.md` is one file read by two runners** (Codex and OpenCode). The catalog must not pretend it is two.
5. **Claude hot-reloads `permissions` and `hooks` mid-session** — so mid-run editing is a real, documented effect, not a hypothetical. The UI can say so for Claude and must stay silent for the others.

### Gaps — not verified from primary sources

Stated here so no UI string over-claims:

- **Codex `config.toml` user↔project merge granularity** — that project config exists and is trust-gated is documented; whether it overrides per-key or wholesale is not. The catalog's Codex precedence string will say what is documented ("project overrides apply only in trusted projects") and not invent granularity.
- **Codex / OpenCode config hot-reload** — not documented either way. The UI will not claim a mid-run effect for them.
- **OpenCode `~/.config/opencode/` on non-XDG platforms** — the docs give the one path; `$XDG_CONFIG_HOME` handling is unverified. Treated as the documented literal, with `$XDG_CONFIG_HOME` honored when set (harmless if unused).

## Proposed Solution

Four pieces, one mechanism:

1. **A catalog** (`src/agent-config/catalog.ts`) — a hardcoded table of the files above: id, runner, kind, scope, path, format, tracked-ness, and **the vendor's documented precedence sentence**. Hardcoding is the design: cezar's value here is knowing where the files are and what the docs say. An unknown file is not shown rather than guessed at, and the catalog is the only place vendor knowledge lives.
2. **A reader/writer** (`src/agent-config/files.ts`) — addressed by catalog **id**, never by client-supplied path, so traversal is impossible by construction. Validates on save per format, refuses broken writes, and refuses stale writes via a content hash.
3. **A code editor** (`web/app/src/components/code-editor.tsx`) — an overlay-on-`<textarea>` reusing the `highlighter.ts` singleton. No editor library.
4. **Two Settings sections** — `agent-config` (the files, grouped by runner and kind, with a scope ladder) and `mcp` (the same editor, filtered to whichever file holds each runner's servers).

Plus **worktree seeding** in `run.ts` so the personal layer actually reaches the agent.

Alternatives rejected: **structured forms per agent** — couples cezar to five schemas across three vendors that change monthly; the raw editor cannot drift on schema by construction. **Computing an effective merged config for display** — cezar would have to reimplement five different merge algorithms and would be wrong the moment a vendor changed one; showing each file plus the vendor's own sentence is honest and stays true. **Monaco/CodeMirror** — the first heavyweight UI dep, for textareas that are a few hundred lines at most; the redesign's tech picks (`.ai/analysis/cockpit-ui-redesign/diff-highlight-tech.md`) deliberately avoided one.

## The worktree problem

The feature's central design hazard, and the reason Q1 existed.

A run's cwd is a **worktree**, not the repo root (`run.ts:745`, `state.cwd = wt.path`; worktrees at `.ai/cezar/worktrees/<runId>` on branch `cez/<id8>` off the base branch). So for a file edited in the cockpit:

- **Tracked** (`.claude/settings.json`, `.mcp.json`, `CLAUDE.md`, `AGENTS.md`, `opencode.json`, `.codex/config.toml`) → the worktree holds *the base branch's committed copy*. An uncommitted edit never reaches a run.
- **Gitignored** (`.claude/settings.local.json`, `CLAUDE.local.md`) → the file does not exist in the worktree **at all**. Anthropic documents this exact failure.

So the naive build ships a settings page whose settings do nothing. The resolution (Q1c):

**Tracked files** are edited at the repo root with an honest label: *"Runs read the committed copy — this edit applies after you commit it."* No magic. The file is the team's, versioned, and cezar has no business silently diverging a worktree from its branch.

**The personal layer is seeded.** At run start, after `createWorktree`, cezar copies the repo root's gitignored personal files into the worktree and registers them in the shared `.git/info/exclude`. Precedent is exact: `run.ts:910-923` already materializes team skills into `<cwd>/.claude/skills/<name>/` and leans on the same shared exclude "to keep them out of git (and out of autosave commits)". Seeding is safe *because* the layer is gitignored: it collides with nothing tracked, so there is no clobber decision to make.

Only Claude documents an untracked personal layer, so **seeding is Claude-only** (`.claude/settings.local.json`, `CLAUDE.local.md`). Codex and OpenCode get honest labels on their tracked files and nothing else. The UI states which files are seeded rather than implying uniformity.

The `info/exclude` step is not optional: if a user hand-created `settings.local.json` without gitignoring it (which the docs warn about), an unexcluded seeded copy would be swept into `autosaveCommit` (`run.ts:682`) and committed onto their branch. Corollary — **seed and exclude only after confirming git actually ignores the file** (`git check-ignore`); a file the user genuinely tracked must not be force-excluded or overwritten, and its catalog label ("gitignored") is then wrong for that user, so the seed path verifies rather than trusts the convention.

## Why writes are a local-only capability

The gate's first answer to Q2 was "gate the global scope only" — keep repo files editable everywhere, make `~/**` read-only in hosted mode. The security review found that insufficient, and it was right.

`.claude/settings.json` (and the seeded `.claude/settings.local.json`) define **`hooks`** — shell commands the Claude CLI runs on lifecycle and tool events. Hooks are **not** agent tool calls, so cezar's default-deny `--allowedTools` (`run.ts:636,1019`) does not gate them; `.mcp.json` and `[mcp_servers.*]` `command`s are the same class. The cockpit server has **no authentication** and its own code calls hosted mode the "deliberate network exposure" (`server.ts:1272`). Under the narrow gate, a network client could `PUT` a hook into repo-local settings and obtain persistent host-side shell execution that fires on every subsequent run — including runs it did not start — bypassing the allowlist, and actively propagated into worktrees by Phase 4 seeding. Calling that "the same risk class as the diffs agents already write" (as an earlier draft did) was wrong: a diff is inert until someone runs it; a hook fires automatically.

Distinguishing "code-executing" files from inert ones would mean understanding each vendor's schema — exactly the drift decision 3 forbids — and the inert files are a weak boundary anyway (a `CLAUDE.md` can *instruct* the agent to run things). So the boundary is coarse and by-mode, matching the open-in-* precedent that already 409s every local-machine affordance in hosted mode:

- **Local mode** (`localHandoff: true`): full editing, every scope.
- **Hosted mode** (`CEZ_REMOTE=1` or non-loopback bind): **read-only**. Every file and its precedence are still shown — the section stays useful for understanding what is in force — but every `PUT` 409s with the reason, and the `~/.claude.json` server listing is withheld (it is host state the hosted client is explicitly not trusted with). Writing config is a thing you do from the machine that owns the checkout.

This costs a hosted user the ability to *edit* agent config from the browser. That is the correct trade: the alternative is a network-reachable arbitrary-file-write to `$HOME` and the repo, some of it auto-executing. If hosted editing is wanted later, it needs the auth story the server does not yet have — a separate spec.

## Architecture

### Components

| Component | File | Responsibility |
|---|---|---|
| Catalog | `src/agent-config/catalog.ts` (new) | The table. Pure, no IO. Owns every vendor fact and precedence string. |
| Files | `src/agent-config/files.ts` (new) | Resolve id → path, read, validate, atomic write, hash. Never throws. |
| Validators | `src/agent-config/validate.ts` (new) | `json` / `jsonc` / `toml` / `markdown`. |
| Seeding | `src/workflows/run.ts` (edit) | Copy the personal layer into the worktree + `info/exclude`. |
| Home paths | `src/paths.ts` (**coordinate**) | `~/.claude`, `$CODEX_HOME`, `~/.config/opencode`. |
| API | `src/server/server.ts` (edit) | Project-route entries `GET /agent-config`, `GET|PUT /agent-config/:id`, mounted as both legacy `/api/*` boot aliases and `/api/p/:projectId/*`. |
| Editor | `web/app/src/components/code-editor.tsx` (new) | Overlay-on-textarea, Shiki singleton. |
| Sections | `web/app/src/routes/settings/agent-config-section.tsx`, `mcp-section.tsx` (new) | The UI. |
| Registry | `web/app/src/routes/settings/registry.tsx` (edit) | `agent-config` entry; unhide `mcp`. |

**`src/paths.ts` is a coordination point, not a dependency.** The multi-project spec introduces it for `~/.cezar`; there is no shared home-path helper today (`skills-remote.ts:45-55` hardcodes `join(homedir(), '.cache', 'cez', …)` inline). Whichever spec lands first creates the file; the second imports it. Neither may block on the other — if `paths.ts` does not exist when this lands, this spec creates it with only the helpers it needs.

### The catalog

Shape (illustrative — the real table is ~15 rows):

```ts
export type ConfigFormat = 'json' | 'jsonc' | 'toml' | 'markdown';
export type ConfigScope = 'user' | 'project' | 'local';
export type ConfigKind = 'settings' | 'memory' | 'mcp';

export interface ConfigFileDef {
  /** Stable, opaque, URL-safe. The ONLY thing a client may name. */
  id: string;                       // 'claude.local.settings'
  runners: RunnerId[];              // <repo>/AGENTS.md is ['codex','opencode'] — one file, two readers
  kind: ConfigKind;
  scope: ConfigScope;
  /** Absolute path, resolved per request (home dirs move with $CODEX_HOME). */
  resolve: (repoRoot: string) => string;
  /** What the user sees: '~/.claude/settings.json', '.claude/settings.local.json'. */
  label: string;
  format: ConfigFormat;
  /** Git status by convention — drives the honest label, not read from git. */
  tracked: 'tracked' | 'gitignored' | 'outside-repo';
  /** Seeded into the run's worktree (Claude's personal layer only). */
  seeded?: boolean;
  /** VERBATIM from the vendor docs. Never computed, never generic. */
  precedence: string;
  /** Documented mid-run effect, or undefined when the vendor is silent. */
  hotReload?: string;
  docsUrl: string;
}
```

`precedence` and `hotReload` are the point. Examples, per §Research:

- `claude.user.settings` → "Lowest priority. Project and local settings override it key by key — except permission rules, which merge across all scopes."
- `claude.project.memory` → "Not overridden: every CLAUDE.md that loads is concatenated, user file first."
- `opencode.project.memory` → "First match wins. If this file exists, OpenCode does not read the global AGENTS.md at all."
- `codex.project.config` → "Applies only in projects you have trusted. Some keys (provider, auth, telemetry) cannot be overridden here."

Deliberately **not** in the catalog:

- `~/.claude.json` — Claude's own state file (§Research point 3). Two MCP scopes live there, so the MCP section *reads* it to list user-scope server names read-only, and never writes. Parsing to display is not re-serializing; a parse failure degrades to "couldn't read", never to a write.
- `managed-settings.json` and managed `CLAUDE.md` — IT-owned, often root-only. Out of scope.
- `.claude/rules/`, `~/.claude/rules/`, `.opencode/agents/`, subdirectory `CLAUDE.md`/`AGENTS.md` — directory trees, not single files. Out of scope; a follow-up issue if wanted.

### API

Additive project-scoped routes, registered once in the mirrored route table introduced by #521.
The legacy `/api/agent-config*` spellings stay bound to the boot project and byte-identical to
`/api/p/<boot>/agent-config*` and `/api/p/default/agent-config*`.

```
GET /api/agent-config
→ { editable: boolean,                               // false in hosted mode — the whole feature
    files: [{ id, runners, kind, scope, label, path, format, tracked, seeded,
              precedence, hotReload?, docsUrl,
              exists, size, version, writable, readOnlyReason? }],
    userMcp: { path, servers: string[], readable: boolean } | null }  // null in hosted mode

GET /api/agent-config/:id
→ 200 { id, path, exists, content, version }        // version null when absent; readable in every mode
→ 404 { error }                                      // unknown id

PUT /api/agent-config/:id   { content, version }
→ 200 { id, path, exists: true, content, version }
→ 400 { error }                                      // bad body, or content fails its format's parser
→ 404 { error }                                      // unknown id
→ 409 { error }                                      // stale version, OR hosted mode (writes disabled)
```

- **`:id` is a catalog key, never a path.** Unknown id → 404. Path traversal is impossible by construction rather than by sanitizing — the only paths that exist are the ones the catalog computes.
- **`version` is a sha256 of the file bytes.** mtime is coarse and lies across filesystems. `null` means "did not exist when I read it"; PUT with `null` onto a file that now exists → 409. This is the create path (Q4) and the stale-write guard in one rule.
- **Repo-file reads work in every mode; home-dir (`outside-repo`) reads AND every `PUT` 409 in hosted mode** (§"Why writes are a local-only capability"), matching the capability refusals at `server.ts:696-698, 724-726` — the house code for "the server won't, and here's why", reason in `error`. `GET /api/agent-config` reports `editable:false` so the UI renders read-only up front rather than only failing at save.
- **`userMcp` is `null` in hosted mode** — its server list is derived from `~/.claude.json`, host state the hosted client is not trusted to see (the read gate the narrow Q2 draft omitted). Locally it is `{path, servers, readable}`.
- Every mutating route zod-`safeParse`s its body and returns `{ error }`, per AGENTS.md's server rules.

### Validation

Server-side only, on PUT. The editor surfaces the 400's message inline; the browser ships no parser. This is deliberate: a second client-side validator would create exactly the parity problem `src/core/ui-parity.test.ts` and `src/server/tool-display-mirror.test.ts` exist to police.

| Format | Validator |
|---|---|
| `json` | `JSON.parse` |
| `jsonc` | internal comment-stripper → `JSON.parse` (OpenCode documents JSONC) |
| `toml` | `smol-toml` |
| `markdown` | none — anything is valid |

**One new runtime dependency: `smol-toml`** (small, zero-dep). The alternative is not validating Codex's config, i.e. letting the cockpit save a `config.toml` that bricks the user's Codex. AGENTS.md's "the server stack stays deliberately small" is a real constraint and this is a real exception — called out here so review sees it was deliberate. JSONC gets a ~30-line internal stripper (string-aware, unit-tested) rather than a second dep.

Validation proves the file parses. It does **not** check the vendor's schema — that would be the drift decision 3 forbids.

### Writes

- **Never rewrite a file cezar merely opened.** No reformatting, no key reordering, no trailing-newline "fixes". A round-trip through the editor must be byte-identical unless the user typed. This is what makes a raw editor safe for a hand-tuned file full of comments.
- **Atomic tmp+rename**, matching `store.ts:409-419`'s precedent.
- **Write through symlinks, never replace them** — `~/.claude` pointing into a dotfiles repo is common. Resolve with `realpath` before the rename, or the rename silently replaces the link with a regular file and detaches the user's dotfiles.
- **`mkdir -p` the parent only on an explicit save** (Q4).

### Editor

`<CodeEditor>` — a `<textarea>` with transparent text and a visible caret, over a `<pre>` of Shiki tokens, both sharing exact font metrics and padding; the textarea's scroll drives the `<pre>`'s transform.

- **No soft wrap** (`white-space: pre`, horizontal scroll). This is the design decision that makes the overlay technique tractable — wrapping is what breaks alignment, and config files want horizontal scroll anyway.
- Token hook mirrors `useFileTokens` (`file-preview.tsx:135-155`) — sync when the grammar is resident, async load once, plaintext for unknown. Reuse `HIGHLIGHT_MAX_LINES = 1500`: past that, plaintext beats jank.
- **Language comes from the catalog's `format`**, not `langForPath` — the catalog knows; a path heuristic guesses.
- **`toml` must be added to `LANG_LOADERS`** (`highlighter.ts:89-106` has json/jsonc/yaml/markdown, not toml). One line + the lazy chunk.
- **Tab is not trapped.** Trapping it breaks keyboard navigation, which AGENTS.md requires the cockpit preserve. Config files are not code editors; the tradeoff is right.
- Not the shadcn `<Textarea>` (`field-sizing-content` + `resize-none` are wrong for a fixed-height scroller); a dedicated component.
- `spellCheck={false}`, autocorrect/autocapitalize off, mono, `≥16px` on mobile (the redesign's iOS checklist).

### UI

**Agent config** — grouped by runner (installed first, via `/api/health` `checks`; uninstalled shown with a muted badge, still editable since the user may install later). Within a runner, one group per kind (Settings / Memory / MCP).

Each kind renders a **scope ladder**: every scope in the vendor's load order, each row showing exists/absent, tracked/gitignored/global, and the seeded badge — with the vendor's `precedence` sentence above the ladder. Selecting a row opens it in the editor. On desktop the ladder sits left of the editor; on mobile it collapses above it.

> **Deliberate deviation, flagged for review.** The ask was "global and local side by side". Claude's settings have *three* scopes and the cockpit is mobile-first (AGENTS.md), so three editor panes is a non-starter. The ladder shows every scope's state and which one wins *at once* — the comparison the ask is actually for — while exactly one file is editable at a time. Two live editors over files with five different merge models would also invite the reading that cezar merges them. It does not.

**Hosted mode renders the whole section read-only** (`editable:false`): the ladders and precedence sentences still show — understanding what is in force is the safe half — but every editor is read-only, Save/Create are hidden, and a banner states that agent config is edited from the machine that owns the checkout (§"Why writes are a local-only capability").

**Codex and OpenCode are an editor-plus-commit, not a live control.** Say it in the copy. Only Claude's personal layer is seeded (§"The worktree problem"), so for the other two a saved change reaches a run only after it is committed to the base branch. The honest per-file label already carries this, but the runner-group header states it too, so nobody reads the section as a live switch for Codex/OpenCode.

Per-file, below the ladder: the honest effect label — *"Runs read the committed copy; this edit applies after you commit it"* (tracked) or *"Copied into each run's worktree — takes effect on your next run"* (seeded) — plus `hotReload` when the vendor documents one, and a docs link.

Save / Revert, dirty state, inline parse errors from the 400, and a 409 that offers "reload from disk" (never a silent clobber). Absent files render greyed with **Create** → an empty editor whose first Save creates the file and its parent.

**MCP** — the same editor, filtered to whichever file holds each runner's servers, since only Claude has a dedicated one: Claude → `.mcp.json`; Codex → `config.toml` (`[mcp_servers.*]`); OpenCode → `opencode.json` (`mcp` key). The section says so plainly rather than implying three parallel files, and states that editing Codex's or OpenCode's MCP means editing their main config — the same file Agent config opens, same version token. Claude's user/local scopes are listed read-only from `~/.claude.json` with "managed by `claude mcp add` — cezar does not edit Claude's state file".

## Data Model

**No new cezar state.** No `config.json` key, no `.ai/cezar/` file, no `ui-state.json` key. The files are the model and they are the *user's*. BACKWARD_COMPATIBILITY.md §3 is untouched; §2 gains routes additively.

## Edge Cases & Failure Scenarios

| Scenario | Behaviour |
|---|---|
| File changes under the editor (user's editor, or an agent) | Save 409s on hash mismatch; the UI offers reload. Never a silent clobber. |
| Edit lands mid-run | Claude: documented to hot-reload `permissions`/`hooks` — the UI says so. Codex/OpenCode: undocumented, so the UI says nothing. We never claim a guarantee the vendor does not make. |
| Invalid JSON/TOML on save | 400 with the parser's message inline. Nothing written. |
| `opencode.json` has comments | JSONC validator. A JSON-only validator would reject a legal file — the reason `jsonc` is a distinct format in the catalog. |
| Symlinked `~/.claude` | Write through, never replace (§Writes). |
| `$HOME` unset / unwritable / read-only FS | Row shows `writable:false` with the reason. Never a crash. |
| `$CODEX_HOME` set | Catalog resolves per request, so it is honoured. |
| Runner not installed | Shown, muted badge, still editable. |
| `<repo>/AGENTS.md` | **One row, two runners** — not duplicated. Note that Claude ignores it (docs say so) and how to import it. |
| Huge `~/.claude.json` | Read is capped; over cap → "too large to summarise", servers not listed. Never parsed for writing. |
| Worktree disabled for a run | cwd is `repoRoot` (`run.ts:532-536`) — the edited files *are* what the agent reads, and seeding is a no-op. The label must reflect the run, not assume a worktree. |
| Seeded file already exists in the worktree | Overwrite: it is gitignored and cezar-owned. Only the personal layer is ever seeded. |
| Hosted mode (`CEZ_REMOTE=1` / non-loopback) | Whole feature read-only: files and precedence shown, every `PUT` 409s, `userMcp` withheld. The one gate that closes the hooks RCE path (§"Why writes are a local-only capability"). |
| A user genuinely tracked their `settings.local.json` | The seed path runs `git check-ignore` before seeding/excluding — a tracked file is neither force-excluded nor overwritten. The catalog's "gitignored" label is by convention and can be wrong for that user; the git check, not the label, guards the write. |
| Concurrent runs seed the same personal layer | The `info/exclude` append is idempotent (skip if the line is already present) — parallel runs sharing the common-dir exclude can otherwise duplicate lines or race the read-modify-write. Duplicate ignore lines are harmless, but the append guards anyway. |
| cezar's `allowedTools` vs the user's `permissions` | **Two different gates that both apply.** cezar passes `--allowedTools` default-deny (`run.ts:1019`, Claude only; codex/opencode ignore it per `codex-app-server-runner.ts:46`). Widening `permissions.allow` in settings cannot re-open what cezar's allowlist already denies. The Settings copy must say this or users will file "my permissions don't work" bugs. |

## Risks & Impact Review

- **This is the first write outside `.ai/cezar/`, and some of what it writes executes code.** Every file cezar owns today is repo-local, gitignored, disposable. These are the user's — some tracked, some in `$HOME`, and some (`hooks`, MCP `command`) run shell commands *automatically*, outside cezar's `allowedTools`. On a local, loopback-bound cockpit this is no worse than the agent the user already runs. On a **hosted** cockpit it would be a network-reachable RCE primitive — which is why writes are gated entirely by mode, not by scope (§"Why writes are a local-only capability"). The earlier "same risk class as the diffs agents already write" framing was wrong and is corrected there: a diff is inert until run; a hook is not.
- **Editing repo-tracked files dirties the working tree.** cezar writes into the user's checkout, which shows up in `GET /api/repo/changes`. Expected, but new: cezar has never modified tracked files outside a worktree before. Worth a review eye.
- **Vendor drift is the standing risk, and decision 3 only half-covers it.** A raw editor cannot drift on *schema*; it can absolutely drift on *paths and precedence strings*. The catalog is a maintenance surface, and a stale precedence sentence is worse than none — it is a confident lie. Mitigation: every string carries `docsUrl`; the catalog is one file; §Research dates its claims.
- **`smol-toml`** — one new runtime dep (§Validation).
- **Zero-config principle** (multi-project spec appendix): this *edits* config, never requires it. cezar works with none of these files present, and the section is empty-but-honest on a fresh machine. Not a violation — stated so it does not read as one.
- **Blast radius is small.** Additive routes, a new section, one new `run.ts` hook that no-ops when the personal layer is absent. Every failure path collapses to today's behaviour.

## Phasing

One PR, five phases, each leaving the app working and independently reviewable. Phases 1–3 deliver the feature; 4 makes it take effect; 5 records it.

## Implementation Plan

### Phase 1 — Backend foundation

1.1 `src/agent-config/catalog.ts` — the table + `ConfigFileDef`, `listConfigFiles(repoRoot)`, `findConfigFile(id)`. Pure, no IO. Unit tests: every id unique and URL-safe; `<repo>/AGENTS.md` is one entry with two runners; `$CODEX_HOME` honoured; every entry has a non-empty `precedence` and a `docsUrl`.
1.2 `src/paths.ts` — home helpers (create only if the multi-project spec has not; otherwise import). Tests for `$CODEX_HOME` / `$XDG_CONFIG_HOME` / unset `$HOME`.
1.3 `src/agent-config/validate.ts` — the four validators + the JSONC stripper (string-aware: `//` inside a string is not a comment). Add `smol-toml`. Unit tests incl. the stripper's nasty cases.
1.4 `src/agent-config/files.ts` — `readConfigFile(id)` → `{exists, content, version}`; `writeConfigFile(id, content, version)` → validate → hash-compare → atomic tmp+rename through symlinks → `mkdir -p`. Never throws. Tests: stale 409, create, symlink preserved, byte-identical round-trip.
1.5 `src/server/server.ts` — the three routes, zod bodies, `{error}` + 400/404/409. **Hosted-mode gate: every `PUT` 409s and `userMcp` is withheld when `capabilities().localHandoff` is false** (§"Why writes are a local-only capability"); `GET /api/agent-config` sets `editable` accordingly. Reads stay open in every mode. Tests: a `PUT` 409s under `CEZ_REMOTE=1` for a repo-local id (not just a user-scope one — this is the regression test for the hooks RCE hole), `userMcp` is null in hosted mode, reads still work, unknown id → 404.

### Phase 2 — Editor

2.1 `highlighter.ts` — add `toml` to `LANG_LOADERS`. Extend the existing allowlist test.
2.2 `web/app/src/components/code-editor.tsx` — the overlay. Vitest: renders content, fires change, no wrap, plaintext past the cap, unknown format degrades, Tab still moves focus. **Caveat, called out so the "no editor library" bet has a safety net:** the overlay's one load-bearing property — pixel-exact font-metric and scroll alignment between the `<textarea>` and the `<pre>` — is a real-browser property jsdom cannot assert. Cover it with a step in the `npm run test:e2e` suite (real Chrome via agent-browser) that types into the editor and screenshots caret/scroll alignment, and a manual QA pass in the PR. If alignment proves fragile, the fallback is a read-only highlighted `<pre>` with a plain `<textarea>` toggle — not a heavyweight editor dep.

### Phase 3 — Settings UI

3.1 `registry.tsx` — add `agent-config`, unhide `mcp` (real component). Update `settings.test.tsx:67-74` and `routes.test.tsx:105-111` — `/settings/mcp` is now a route, not a 404 (called out in #404).
3.2 `web/app/src/api/` — types, `getAgentConfig`/`getAgentConfigFile`/`putAgentConfigFile`, query keys, hooks.
3.3 `agent-config-section.tsx` — runner groups, scope ladder, precedence + effect labels, editor, save/revert/create, 400 inline, 409 reload, and the `editable:false` read-only render (banner, hidden Save/Create). Tests incl. the honest labels, the Codex/OpenCode editor-plus-commit header, and the read-only hosted-mode render.
3.4 `mcp-section.tsx` — the filtered view + the read-only `~/.claude.json` listing. Tests.

### Phase 4 — Worktree seeding

4.1 `run.ts` — after `createWorktree` (near line 745), for each catalog entry with `seeded:true`: if the source exists at `repoRoot` **and `git check-ignore` confirms it is ignored**, copy it into `state.cwd` and **idempotently** register it in the shared `.git/info/exclude` (append only if absent — follow `materializeSkillDir`, `run.ts:910-923`), emitting a `note` event. No-op when the file is absent, genuinely tracked, or the run has no worktree. Tests: seeded file lands and is excluded; absent → silent no-op; no-worktree → no-op; **a truly-tracked `settings.local.json` is neither seeded nor excluded**; the exclude append is idempotent across two runs; a seeded file never reaches `autosaveCommit`.

### Phase 5 — Documentation

5.1 `AGENTS.md` task-routing row for `src/agent-config/`; README section; BACKWARD_COMPATIBILITY.md §2 route list; CHANGELOG. Note the new dep and that `/settings/mcp` now exists.

## Follow-ups (deliberately out of scope)

- `.claude/rules/` and `~/.claude/rules/`, `.opencode/agents/` — directory trees with `paths:` frontmatter, a different UI problem.
- Managed/enterprise scopes (`managed-settings.json`, managed `CLAUDE.md`).
- Editing `~/.claude.json` (Claude's state file) — deliberately never.
- Teaching `AgentRunSpec` about MCP so cezar could pass servers per run — a real capability, orthogonal to editing files.
