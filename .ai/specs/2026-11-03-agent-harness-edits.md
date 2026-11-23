# Agent harness edits: let a project's Claude tasks write `.claude/skills`, `commands`, `agents`

> Status: proposed
> Brief: [briefs/2026-11-03-agent-harness-edits.md](briefs/2026-11-03-agent-harness-edits.md)
> Related: #1248 (the bug, closed by #1256 with an explanation only), #475 / #1027 (permission
> modes), #1303 (cross-project tasks, follow-up)

## 📝 TLDR

A cezar user who wants a task to improve the project's own agent harness (a skill, a sub-agent,
a command) cannot do it today: every Claude write under `.claude/` is denied, and the only way out
is taking the session over in a terminal. This spec proposes a per-user, per-project switch,
**Agents may edit this project's harness**, off by default and set by hand in the project's
settings. When it is on, Claude runs for that project may write `.claude/skills/**`,
`.claude/commands/**`, `.claude/agents/**` and `.claude/CLAUDE.md`. `.claude/settings*.json` and
`.mcp.json` stay locked.

## 📝 Problem Statement

cezar starts Claude Code with `--permission-mode dontAsk` (`buildClaudeArgs`,
`packages/cezar/src/core/claude-cli-runner.ts`). Claude Code treats `.claude/` and `.mcp.json` as
[protected paths](https://code.claude.com/docs/en/permission-modes): a write there always asks,
and under `dontAsk` the question becomes a denial. An `Edit` in `--allowedTools` does not change
that.

- #1248: four denied `Edit`s on `.claude/skills/pnl-update/SKILL.md` in a SDRC quick-task; a
  maintainer reproduced it on `main`. #1256 closed it by telling the agent to report the denial
  instead of suggesting Shift+Tab, which keeps the denial.
- The same denial recurred on 2026-11-02 in a task asked to fix a skill.
- Workaround: **Open in…** → `claude --resume <id>` in the worktree, approve by hand. That moves
  the work out of cezar exactly when cezar is being used to improve how agents work.

Root `CLAUDE.md` and `AGENTS.md` are not protected and are writable today; `.claude/CLAUDE.md` is
protected (verified on Claude Code 2.1.317).

## 📝 Proposed Solution

One boolean on the project's registry entry in `~/.cezar/config.json`: `agentHarnessEdits`.
Absent or `false` changes nothing. When `true`, a Claude launch for that project:

1. runs with `--permission-mode default` instead of `dontAsk`;
2. adds a cezar-owned stdio MCP server, the **harness approver**, to the `--mcp-config` file
   cezar already writes for private MCP servers, under a per-launch random name
   `cezar_harness_<nonce>`;
3. passes `--permission-prompt-tool mcp__cezar_harness_<nonce>__approve`.

The nonce matters: `--mcp-config` adds to the repo's own `.mcp.json`, so a fixed name would let a
cloned repo ship its own `cezar_harness` server that answers allow to everything, which is
`bypassPermissions` by another route. A name the repo cannot predict closes that.

Claude Code then sends every permission question to the approver instead of a human. The approver
answers **allow** only for `Edit` / `Write` / `MultiEdit` whose target resolves (symlinks and `..`
followed, the nearest existing ancestor for a new file) inside the run's worktree at
`.claude/skills/`, `.claude/commands/`, `.claude/agents/`, or exactly `.claude/CLAUDE.md`. Every
other question, `NotebookEdit` included, is answered **deny** with a fixed message: "Denied by
cezar: this project allows agents to write only .claude/skills, .claude/commands, .claude/agents
and .claude/CLAUDE.md. Report the change you need instead of retrying." Claude wraps that message
in its own denial text; the step-2 test pins the message cezar sends.

**Fail closed when the approver cannot be wired.** If the MCP config temp file cannot be written
(`writeClaudeMcpConfig` returns `undefined` today on a failed write), the launch falls back to
today's exact `dontAsk` argv and emits an engine note. It never emits `default` +
`--permission-prompt-tool` pointing at a server that was not configured.

The `approve` tool is visible in the model's tool list. A model calling it gets a decision back
and nothing else: the tool changes no state and grants nothing.

### Alternatives considered

Each was tried on Claude Code 2.1.317 against a throwaway repo:

| Alternative | Result | Why it lost |
| --- | --- | --- |
| `--allowedTools Edit(.claude/skills/**)` (several path spellings) | denied | allow rules do not cover protected paths (documented) |
| `--add-dir <worktree>/.claude/skills` | denied | same |
| `PreToolUse` hook answering `allow` (hook ran) | denied | protected-path check outranks hooks |
| `--permission-mode bypassPermissions` | allowed | also wrote `.claude/settings.json`, i.e. hooks and permissions |
| `default` + `--permission-prompt-tool` approver | allowed skills, denied `settings.local.json` | **chosen** |
| Agent writes `.ai/skills/**`, cezar copies to `.claude/` at review | not built | covers skills only, not agents, commands or `.claude/CLAUDE.md` |
| Build nothing, wait for #1027 | — | its zero-config default stays `dontAsk`; `Guarded` asks per write; `Auto` unlocks settings and hooks |

### Why `.claude/settings*.json` and `.mcp.json` stay locked

They hold permission rules, `hooks` (shell commands the harness runs on its own), `env`
(`ANTHROPIC_BASE_URL`), `apiKeyHelper` (a command run to fetch credentials) and MCP server launch
commands. Every cezar turn and every Continue respawns `claude` in the same worktree, so a change
there takes effect on the task's next turn, before the review gate; after merge it runs in every
teammate's own interactive sessions. The approver denies them, and the agent proposes such a
change in its summary for a human to apply. This is the boundary AGENTS.md already defends for
`PUT /api/v1/agent-config` ("closes a hooks-based RCE path").

### What the switch does grant, stated plainly

Skill and command frontmatter can declare `allowed-tools` (pre-approves tools while the skill
runs; deny rules still win) and `hooks`; a skill body can run shell through `` !`cmd` ``; agent
frontmatter can declare `tools`, `permissionMode`, `hooks` and `mcpServers`
([skills](https://code.claude.com/docs/en/skills), [sub-agents](https://code.claude.com/docs/en/sub-agents)).
So an agent with the switch on can widen what a later turn may do. The settings copy says this,
and the review surface flags it (UI/UX below). The switch is a trust decision for people who use
cezar to work on their harness, not a default.

Threat model: cezar's zero-config allowlist already includes unrestricted `Bash`, and Claude
Code's path checks only cover paths visible in the command text ("a Bash command you approve can
still write anywhere your user account can",
[security](https://code.claude.com/docs/en/security)). The switch therefore does not widen what a
hostile or prompt-injected agent can already do. It lets an honest agent make the change through
`Edit`, where it is visible in the tool timeline and the diff.

## 📝 Architecture

```mermaid
flowchart LR
  UI["Project settings switch (new)"] -->|"PATCH /api/v1/projects/:id (existing, new key)"| REG["~/.cezar registry entry (existing)"]
  REG -->|"read per launch (new)"| RUN["run.ts launch sites x2 (existing)"]
  RUN -->|"spec.harnessEdits (new)"| ARGS["buildClaudeArgs (existing)"]
  ARGS -->|"--mcp-config + --permission-prompt-tool"| CC["claude CLI"]
  CC -->|"permission question"| AP["harness approver (new)"]
  AP --> DEC["harnessWriteDecision() pure (new)"]
```

The whole decision lives in one pure function, `harnessWriteDecision(toolName, input, worktree)`
in `packages/cezar/src/core/harness-approver.ts`; the stdio MCP entry point is a thin wrapper
around it. When #1027's `--permission-prompt-tool stdio` channel lands, the same function answers
there and the MCP server is deleted; the setting and the UI do not change.

- **Launch sites.** `run.ts` builds an `AgentRunSpec` in two places (step launch and
  `runContinuation`), both already calling `privateMcpForLaunch`. The flag is resolved per launch
  through one helper used by both, so a Continue, a restart recovery and a new step all see the
  current value (AGENTS.md: grep the type, not the field).
- **MCP config.** The approver entry is merged into the same `0600` temp file as private servers;
  the file is written when either is present. Private servers keep their `claudeMcpAllowRules`.
- **Shipping.** The approver is compiled with the package and launched as
  `process.execPath <entry> <worktree>`: no `npx`, no network, no extra dependency. The entry
  path resolves next to the running module, `.js` from `dist/` and `.ts` under `tsx` for
  `npm run dev` and the test suites, the same way the bundled mock runners resolve theirs.
- **Scope.** Task runs only: the two `run.ts` launch sites. cezar's other Claude calls
  (`commit-message.ts`, `auto-name.ts`, `planner.ts`) are deliberately excluded; they never edit
  files. A dispatched child task reads the flag of the project it runs in. Claude backend only:
  Codex, OpenCode, Cursor, Gemini and the ACP runners have no protected-path denial, so for them
  the flag is ignored.
- **No registry entry.** Headless `cezar run`, an unregistered boot root and single-project mode
  have no entry to read, so the flag is off there.
- **Precedence.** `CEZ_APPROVAL_GATE=1` keeps `acceptEdits` and ignores the flag. If #1027 lands
  first: under its restrictive presets the flag adds an auto-allow for the same paths through the
  shared function; under `Auto` it is moot.

## 📝 Data Model

Registry entry (`workspaceProjectSchema`, `packages/cezar/src/workspace/config.ts`):

```ts
/** spec 2026-11-03-agent-harness-edits. Only `true` is stored; absent = off. */
agentHarnessEdits: z.literal(true).optional().catch(undefined),
```

Per user, per machine, never in the repo. `.ai/cezar/config.json` was rejected because it is
committable (`data-gitignore.test.ts`): a cloned repo must never arrive with the switch on.

`RunRecord` step (`packages/cezar/src/runs/store.ts`): optional `harnessEdits?: true`, set when the
step launched with the approver, so the run history shows which turns could write the harness.

## 📝 API Contracts

`PATCH /api/v1/projects/:projectId` (`updateProjectInputSchema`, `packages/contract/src/projects.ts`):

- Body gains `agentHarnessEdits?: boolean | null`. `true` stores it; `false` / `null` delete the
  key. The refine becomes "specify maxParallel, tags or agentHarnessEdits". Per-key semantics are
  unchanged.
- `409 {error}` when the body sets `true` on a hosted cockpit (`!capabilities().localHandoff`),
  mirroring the agent-config write guard. Turning it off is always allowed. The route's existing
  single-project `409` applies unchanged, so single-project mode cannot set it.
- `GET /api/v1/projects` rows and the PATCH answer (`updateProjectResponseSchema`, which reuses
  `projectListEntrySchema`) gain `agentHarnessEdits?: true`, omitted when off, like `tags`. The
  handler spreads it conditionally so the wire never carries `agentHarnessEdits: undefined`.

`contract-parity` and `typed-bodies` tests cover both. `BACKWARD_COMPATIBILITY.md` §2 records the
additive key in the same paragraph as `maxParallel` and `tags`.

## 📝 UI/UX

Settings → project → **General** (`packages/web/src/routes/settings/project-general.tsx`), a new
**Agent harness** card under concurrency:

- Switch: **Agents may edit this project's harness** (off).
- Copy: "Lets Claude tasks in this project write `.claude/skills`, `.claude/commands`,
  `.claude/agents` and `.claude/CLAUDE.md`. Skills and agents can grant tools or run commands, so
  review those changes like code. `.claude/settings` and `.mcp.json` stay locked. Applies to the
  next agent turn; stored only on this machine."
- Hosted cockpit: the switch is shown disabled with "Available on a local cockpit".
- Turning it on needs no confirm dialog; the copy is the warning, and turning it off is one click.

Task view:

- An engine note on each launch with the flag on: "harness edits enabled for this project:
  .claude/skills, commands, agents, CLAUDE.md".
- Changes tab: when the diff touches a file under `.claude/skills|commands|agents/` and its
  frontmatter adds or changes `allowed-tools`, `hooks`, `permissionMode`, `tools` or
  `mcpServers`, a notice above that file names the key. Detection is a frontmatter diff of the
  two YAML heads, read-only.

No mockups: the change is one switch in an existing card plus a one-line notice.

## 📝 Edge Cases & Failure Scenarios

| Case | Behavior |
| --- | --- |
| Approver crashes, hangs or answers malformed | Claude treats the prompt tool as failed → write denied. Verified by the live canary with a killed approver; a hang is bounded by Claude's MCP tool timeout. Never an open write. |
| MCP config temp file cannot be written | Launch uses today's `dontAsk` argv plus an engine note. Unit-tested. |
| Repo `.mcp.json` defines a server named like the approver | Cannot collide: the approver name carries a per-launch nonce. Unit-tested. |
| Future Claude Code stops consulting the prompt tool for protected paths | Writes are denied as today (fail closed). The canary is opt-in, so this can go unnoticed until a user reports it; the engine note tells them the switch was on. |
| Garbage value in the registry key | `.catch(undefined)` → off. Unit-tested. |
| Future Claude Code changes `dontAsk`/`default` semantics | Parity test (below) compares allow/deny for a fixed tool set in both modes. |
| Workflow step with `bashAllowlist` | Unlisted commands reach the approver and are denied, as under `dontAsk`. Parity test covers it. |
| Symlink `.claude/skills/x → ../../.claude/settings.json` or outside the worktree | Resolved target decides → denied. |
| New file in a new skill directory | Nearest existing ancestor is resolved; allowed inside the four paths. |
| Path inside `.claude/skills` of the MAIN checkout, not the worktree | Denied; the approver only knows its own worktree root. |
| `.claude/settings.json` edit wanted | Denied with the standard wording; the agent reports the proposed change in its summary. |
| Switch flipped mid-run | Current `claude` process keeps its args; the next turn, Continue or step picks up the new value. |
| Registry unreadable | Flag reads as off (the registry's existing degrade). |
| Hosted cockpit, flag set earlier on a local one | Launches ignore it when `!localHandoff`; PATCH refuses `true`. |
| `CEZ_DRY_RUN=1` | Mock Claude accepts the new flags; dry-run tests assert the args. |

## 📝 Risks & Impact Review

- **Changing a working mechanism** (AGENTS.md § Changing a mechanism that already works). With
  the flag absent, `buildClaudeArgs` output is byte-identical to today; a regression test pins
  it. The old guarantee `dontAsk` provided, "nothing outside the allowlist runs", is replaced by
  the approver's deny-by-default plus the parity test.
- **Durability.** The mechanism depends on Claude Code behavior verified on 2.1.317. The live
  canary is opt-in like the other `*.smoke.test.ts` files (`describe.skipIf`), so CI does not run
  it; a Claude Code upgrade can break the switch silently. It breaks closed: writes are denied as
  they are today. The unit suite pins the args and the decision function.
- **Security direction.** The switch lets agents change instructions that later turns follow.
  Mitigations: per-user storage, off by default, local cockpit only, settings and `.mcp.json`
  locked, unpredictable approver name, frontmatter notice in review, run-record trail. This is a
  product decision the maintainers own; it widens nothing for an agent that already uses Bash.
- **Zero config.** AGENTS.md says a feature that seems to need configuration is a design smell.
  This one is a per-user trust decision that nothing in the repo or the environment can
  discover, and the zero-config default is the safe one (off), as AGENTS.md asks for features
  that widen exposure.
- **Rollback.** Deleting the key turns it off. Removing the feature leaves an ignored registry key
  (`.passthrough()` keeps it harmlessly).

## 📋 Phasing

One phase, one PR. The Changes-tab frontmatter notice ships with the switch because the security
argument relies on it; a switch without it would ask reviewers to spot `hooks:` in a long diff.
Steps 1–3 and 4–5 can land as separate commits that each leave the app working (the flag is
inert until the settings card can set it).

Follow-ups, not in this spec: cross-project harness work (a task in X editing Y, reading Y's past
sessions), building on #1303; an opt-in Claude Code Bash sandbox for cezar runs that denies writes
to `.claude/settings*.json` and `.mcp.json` at the OS level.

## 📋 Implementation Plan

1. `core/harness-approver.ts`: `harnessWriteDecision()` + exhaustive unit tests (four allowed
   roots, settings files, `.mcp.json`, `..`, symlink in and out, new nested file, `NotebookEdit`
   and other tools, main-checkout path).
2. `core/harness-approver-main.ts`: stdio MCP wrapper (initialize, tools/list, tools/call) + a
   test that drives it over stdin/stdout: malformed input → deny, the pinned deny message.
3. `core/agent-runner.ts`: `harnessEdits?: { worktree: string }` on `AgentRunSpec`.
   `buildClaudeArgs` + MCP-config writer: flag absent → byte-identical args (regression test);
   present → `default`, merged config under a nonce name, prompt tool; temp-file write failure →
   today's `dontAsk` argv + note; `CEZ_APPROVAL_GATE=1` → ignored; entry path resolves from both
   `src/` and `dist/`. Prove the regression test red against a deliberately broken build
   (AGENTS.md § prove the test fails).
4. `workspace/config.ts` + `packages/contract/src/projects.ts`: registry key (garbage → off),
   PATCH body and answer, GET row; server handler with the hosted `409`; contract-parity,
   typed-bodies, route tests.
5. `workflows/run.ts`: one `harnessEditsForLaunch()` helper used by both launch sites; engine
   note; `RunRecord` step flag. Tests for a new step, a Continue and a restart recovery.
6. `packages/web/src/routes/settings/project-general.tsx`: Agent harness card + component tests
   (local on/off, hosted disabled, PATCH body shape).
7. Frontmatter diff helper (pure, YAML head of before/after) + unit tests; Changes-tab notice
   above affected files + component tests.
8. Live canary (`*.smoke.test.ts`, opt-in like the others): skill edit allowed,
   `settings.local.json` denied, killed approver → denied, `dontAsk`/`default` parity for a fixed
   tool set including a `bashAllowlist` step.
9. Docs: `docs/site` settings-and-projects page, workflows-and-skills page note,
   `BACKWARD_COMPATIBILITY.md` §2 and §9, AGENTS.md routing row for agent runners.

## Resolved assumptions (autonomous defaults)

The brief's resolved-unknowns table answered storage, scope, locked files, fail-closed behavior,
`CEZ_APPROVAL_GATE`, private MCP, backends and #1027 precedence. Defaults applied for what it left
open:

| # | Question | Default | Why |
| --- | --- | --- | --- |
| Q1 | May a hosted cockpit enable the switch? | No: PATCH `409` on `true`, launches ignore it | mirrors the agent-config write guard; the safer side |
| Q2 | Confirm dialog when turning it on? | No; warning copy on the card | one switch, reversible in one click |
| Q3 | Record per run? | Optional `harnessEdits?: true` on the step | trail for review without a new surface |
| Q4 | Frontmatter notice in the same PR? | Yes, same PR | the security argument relies on it (spec review finding) |
| Q5 | Field name | `agentHarnessEdits` on the registry entry | sits next to `maxParallel`, `tags`; names the capability, not the mechanism |
