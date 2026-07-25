# Permission modes: non-skip-all and non-auto agent permissions (#475)

> Status: **approved — spec PR #477 merged**
> Issue: https://github.com/open-mercato/cezar/issues/475
> Mockups: [settings block](assets/permission-modes/settings-permissions.html) ·
> [composer guard](assets/permission-modes/composer-autonomous-guard.html) ·
> [in-run prompt card](assets/permission-modes/run-permission-prompt.html)

## TLDR

Today the backends have uneven permission defaults: claude gets a hardcoded
mode plus a tool allowlist, codex has its own sandbox/policy pair, and opencode
auto-approves everything. This spec adds a user-selectable **permission mode** (four presets,
plus optional advanced per-tool rules with globs) as a global default in
Settings → Agents with a per-task override in the composer, wires it through
the `AgentRunSpec` seam into each backend's native permission mechanism, and
adds cockpit UI to surface and answer live permission prompts — activating the
`permission.requested` / `permission.resolved` events that were reserved for
exactly this. The autonomous toggle gains a guard: an autonomous run with a
non-auto mode warns the user that the run will park for their attention. The
default `auto` mode is explicitly unrestricted across every backend.

Gate decisions (2026-07-17, issue author): one spec with phased delivery;
setting lives global + per-task override; granularity is presets **plus**
advanced rules; unanswered prompts park at `waiting` indefinitely. Clarification
(2026-07-21, issue author): the default `auto` preset means **full permissions
for every coding-agent backend**; restrictive behavior is opt-in.

## Problem Statement

- cezar's pitch includes a review gate, but *during* the run the agent has
  near-unrestricted autonomy: any Bash command (claude's default `Bash` entry
  is unrestricted unless a workflow sets `bashAllowlist`), full workspace
  writes plus network (codex), everything auto-approved (opencode).
- Security-conscious users cannot tighten this without editing workflow YAML —
  and even then only for claude, only allowlists, never interactive approval.
- The event protocol already reserved `permission.requested` /
  `permission.resolved` with ACP-style option kinds (`src/core/ui-events.ts:122,
  299`) and the attention ladder already ranks `permission` highest
  (`web/app/src/lib/attention.ts`) — the design anticipated this feature;
  nothing emits or renders these events yet.
- Autonomous mode (`#autonomous`) and restrictive permissions are in tension:
  an autonomous run that parks on a permission prompt defeats its purpose. The
  UI must make that tension explicit at task-creation time (#475).

## Research: how the three backends model permissions natively

Verified against the installed CLIs (2026-07-17) and vendor docs.

### Claude Code

- `--permission-mode <mode>`: `acceptEdits`, `auto`, `bypassPermissions`,
  `manual`, `dontAsk`, `plan`. Plus `--dangerously-skip-permissions` (bypass
  everything) and `--allow-dangerously-skip-permissions`.
- `--allowedTools` / `--disallowedTools` with specifier globs:
  `Bash(git *)`, `Edit`, `Read(src/**)`. Also a `--settings <file-or-json>`
  channel accepting the `permissions: { allow, ask, deny }` settings.json
  shape.
- Headless approval channel: with `--input-format stream-json`, a tool call
  that needs approval surfaces as a `control_request` (subtype
  `can_use_tool`) on stdout; the host answers with a `control_response` on
  stdin (the SDK's `canUseTool` contract). No answer → the CLI waits.

### Codex (`codex app-server`)

- Two orthogonal knobs: `sandbox` = `read-only` | `workspace-write` |
  `danger-full-access`; `approvalPolicy` = `untrusted` | `on-failure` |
  `on-request` | `never`. No per-tool allowlist, no globs.
- Headless approval channel: per-item JSON-RPC requests
  (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`)
  that the client answers with an approve/deny response.

### OpenCode (`opencode serve`)

- `permission` config object keyed per tool (`edit`, `bash`, `webfetch`,
  `read`, …), each `allow` | `ask` | `deny`; `bash` (and file tools) accept a
  pattern map, e.g. `{ "git *": "allow", "*": "ask" }`. Per-agent overrides
  exist.
- Headless approval channel: a `permission.updated` SSE event carrying the
  pending request; the client replies via the session permissions endpoint
  with `once` | `always` | `reject`.

**Takeaways adopted:** a small set of *capability-named* presets is the only
model that maps onto all three backends (claude is a superset, codex is
mode-only, opencode is per-tool). Advanced rules use claude's
`Tool(pattern)` specifier syntax as the canonical format — it is the most
expressive and the other two get documented best-effort mappings. The
ask/allow/deny triple (claude settings, opencode) is adopted verbatim for
rules. **Complexity skipped:** vendor config passthrough (violates the
repo's agent-agnostic copy rule), persistent "always allow" rule learning
(Phase 2 answers are per-request/per-session; durable rules stay a user
action in Settings), and codex sandbox escalation flows.

## Current state (what exists today)

| Surface | Today | File |
| --- | --- | --- |
| claude args | `--permission-mode acceptEdits`, `--allowedTools` default-deny, `Bash(prefix:*)` globs | `src/core/claude-cli-runner.ts:301-360` |
| codex args | `sandbox: danger-full-access`, `approvalPolicy: never` (#563; `CEZ_CODEX_NETWORK=0` opts into network-blocked `workspace-write`) | `src/core/codex-app-server-runner.ts:295` |
| opencode | auto-approved permissions, `allowedTools` ignored | `src/core/opencode-server-runner.ts:39` |
| Protocol | `permission.requested` / `permission.resolved` RESERVED; `PermissionOption` kinds `allow_once` / `allow_always` / `reject_once` / `reject_always` | `src/core/ui-events.ts:122-135, 296-312` |
| Attention | `permission` already tops the priority ladder | `web/app/src/lib/attention.ts:16` |
| Settings UI | Settings → Agents: runner, models, system prompt, base branch — `PUT /api/config` partial patches | `web/app/src/routes/settings/agents-section.tsx` |
| Composer | Autonomous toggle (`#autonomous`), per-task runner/model | `web/app/src/routes/new-task.tsx:135` |
| Config | `.ai/cezar/config.json`, zod, additive-safe keys (`.catch(undefined)`), zero-config defaults | `src/config.ts` |
| Workflows | per-step `allowedTools` / `bashAllowlist` | `src/workflows/types.ts:22` |

## Proposed Solution

One new concept, **permission mode**, expressed as four capability-named
presets plus optional advanced rules:

| Preset | Meaning (UI copy) | claude | codex | opencode |
| --- | --- | --- | --- | --- |
| `auto` *(default)* | Full permissions; run without asking | `bypassPermissions` / dangerously-skip permissions | `danger-full-access` + `never` | all permissions allowed |
| `guarded` | Edits run; shell & network ask | `acceptEdits`, `Bash` moved from allowlist to `ask` | `workspace-write` + `on-request` | `edit: allow`, `bash: ask`, `webfetch: ask` |
| `read-only` | Reads run; any change asks | `manual` + allowlist `Read,Grep,Glob`; writes/exec ask | `read-only` sandbox + `on-request` | `edit: ask`, `bash: ask` |
| `manual` | Everything asks | `--permission-mode manual`, empty allowlist | `untrusted` | all tools `ask` |

Advanced rules (optional, on top of a preset): three lists — `allow`, `ask`,
`deny` — of canonical `Tool` / `Tool(pattern)` specifiers (`Bash(git *)`,
`Edit(src/**)`). Precedence: `deny` > `ask` > `allow` > preset. Fidelity per
backend is explicit and surfaced, not silent:

- **claude** — full fidelity: `allow` → `--allowedTools`, `deny` →
  `--disallowedTools`, `ask` → `--settings '{"permissions":{"ask":[…]}}'`.
- **opencode** — tool-level fidelity: specifiers map onto `permission` keys;
  `Bash(git *)` becomes a `bash` pattern entry; specifiers for tools opencode
  doesn't gate degrade to the nearest gate or are dropped **with a timeline
  notice**.
- **codex** — mode-only: rules cannot be applied; the run gets a one-line
  timeline notice ("advanced permission rules are not supported by codex —
  `guarded` preset applied") and the preset governs.

"Timeline notice" throughout this spec means the run's existing engine-note
channel — the same carrier the autonomous auto-continue note uses
(`src/workflows/run.ts:611`) — so no new event type is needed and tests can
assert on the emitted note.

Alternatives considered: (a) vendor-config passthrough (rejected: leaks
backend formats past the `AgentRunSpec` seam and violates the agent-agnostic
copy rule); (b) presets only (rejected by gate decision — the issue explicitly
asks for globs); (c) cezar-side permission engine intercepting tool calls
(rejected: cezar doesn't sit between the CLI and its tools; the backends'
native gates are the only enforcement point that actually blocks anything).

Interactive prompts activate the reserved protocol: backends surface their
native approval requests as `permission.requested` UiEvents; the cockpit
renders a prompt card; the answer flows back over a new API route into the
backend session. Unanswered prompts park the run at `waiting` (gate decision
Q4) — same contract as agent questions, flagged by the existing attention
ladder and notifications.

## Architecture

```
Settings → Agents          /new composer                    Run thread (cockpit)
  permissions block   →      effective-mode chip +            permission prompt card
  (global default)           per-task override +                   │ answer
        │                    autonomous guard                      ▼
        ▼                          │                    POST /api/runs/:id/permissions/:requestId
  .ai/cezar/config.json            ▼                               │
  permissions key         POST /api/runs { permissions }           ▼
        └──────────────┬───────────┘               AgentSession.respondPermission()
                       ▼                                           │
             effective PermissionSpec                              ▼
                       ▼                             claude: control_response (stdin)
        AgentRunSpec.permissions (seam)              codex: requestApproval JSON-RPC reply
                       ▼                             opencode: permissions endpoint
   per-backend translation in each runner
   (args / JSON-RPC params / permission config)
                       ▲
   backend approval request → ui-mapper → permission.requested UiEvent
   → ui-event-sink (NDJSON + SSE) → cockpit card + attention + notification
```

- **What changes:** `src/config.ts`, `src/core/agent-runner.ts` (spec +
  session seam), the three runners, the three ui-mappers,
  `src/runs/ui-event-sink.ts` (run status → `waiting` on pending permission),
  `src/server/server.ts` (config surface, runs body, answer route),
  `web/app` settings section, composer, task-thread prompt card.
- **What is reused:** reserved `permission.*` UiEvent types (both protocol
  copies), `PermissionOption` kinds, attention ladder, run-notifications,
  NDJSON replay/dedupe, `PUT /api/config` partial-patch pattern, the
  `AgentRunSpec` seam discipline (no backend types leak past it).
- **Workflow interplay:** per-step `allowedTools`/`bashAllowlist` keep exactly
  today's semantics and compose as *additional restriction*: the step
  allowlist is intersected with what the mode would allow; rule `deny` wins
  over everything. Per-step permission modes are a **non-goal** (gate decision
  Q2 chose global + per-task).

## Data Model

All additions are optional/additive so old files parse (BACKWARD_COMPATIBILITY
rule on `runs.json` and `config.json`).

`CezConfig` (`src/config.ts`) — new key, `.catch(undefined)` additive-safe:

```jsonc
"permissions": {
  "mode": "auto" | "guarded" | "read-only" | "manual",   // default "auto"
  "rules": {                                              // optional
    "allow": ["Bash(git *)", "Read"],
    "ask":   ["Bash(npm *)"],
    "deny":  ["Bash(rm *)", "WebFetch"]
  }
}
```

Rule specifiers are validated by shape (`^[A-Za-z][A-Za-z0-9_-]*(\(.+\))?$`),
each list capped at 100 entries, each entry at 200 chars. Invalid → key
degrades to unset (never blocks startup).

`RunRecord` (`src/runs/store.ts`) — optional `permissions` snapshot of the
*effective* spec at start (for display in the run header and for resume), plus
nothing else: pending prompts live in the event stream, not the index.

Event NDJSON — `permission.requested` / `permission.resolved` events persist
per the existing sink rules. The reserved `UiPermissionResolvedEvent` shape
changes before first emission: `optionId` becomes optional and a
`cancelled?: true` variant is added (session died / run interrupted with a
prompt pending). This is a deliberate edit to a published-but-never-emitted
type in **both** protocol copies (`src/core/ui-events.ts`,
`web/app/src/protocol/ui-events.ts`) — safe only because nothing emits or
renders it yet, and called out in Risks rather than claimed as purely
additive. No sensitive-data concern beyond what tool-call events already
persist (command lines); no new secret-bearing fields.

## API Contracts

All follow the server's existing pattern: zod `safeParse`, `{ error }` with
400/404/409, `127.0.0.1` only.

- `GET /api/config` + `PUT /api/config` — answer/patch gains `permissions`
  (same shape as the config key; PUT is a partial patch merged into raw
  config.json like every other knob).
- `POST /api/runs` — body gains optional `permissions` (same shape) as the
  per-task override; wins over the config default; persisted on the
  `RunRecord` snapshot. Also `lastPermissionMode` joins the ui-state the
  composer remembers (like `lastAutonomous`).
- `POST /api/runs/:id/permissions/:requestId` — body `{ "optionId": string }`.
  Answers a pending prompt. `404` unknown run/request, `409` request already
  resolved or session no longer open, `200 { ok: true }` otherwise.
  `requestId` is validated (`^[A-Za-z0-9._-]+$`) before touching the session.
- SSE — `permission.requested` / `permission.resolved` UiEvents stream and
  replay exactly like other events (seq-deduped).

`AgentRunSpec` gains `permissions?: PermissionSpec`; `AgentSession` gains
optional `respondPermission(requestId, optionId)` — backends that cannot
answer (or a dead session) return `false`, which the route maps to `409`.

## UI/UX

Only the unique parts; all controls follow existing shadcn/theming/keyboard
conventions. Copy stays agent-agnostic (capability names, never vendor flags).

1. **Settings → Agents → Permissions** (mockup:
   `assets/permission-modes/settings-permissions.html`): a four-option radio
   group (preset name + one-line meaning), and a collapsible **Advanced
   rules** editor with three textareas (allow / ask / deny, one specifier per
   line) plus a per-backend fidelity hint ("codex applies the preset only").
   Persists via the section's normal partial `PUT /api/config`.
2. **Composer** (mockup:
   `assets/permission-modes/composer-autonomous-guard.html`): an
   effective-mode chip next to the Autonomous toggle (e.g. shield icon +
   "Guarded"), opening a popover to override the mode for this task. When
   **Autonomous is on and the effective mode can ask**, an inline amber
   warning appears and submitting asks for one confirmation: "Autonomous runs
   park when the agent needs permission — switch to Auto, or continue with
   {mode}?" (actions: *Use Auto for this task* / *Continue with {mode}*, where
   {mode} is the effective mode's display name — Guarded, Read-only, or
   Manual). Checking Autonomous never silently changes the mode (#475's
   requirement is a prompt, not a mutation).
3. **Run thread prompt card** (mockup:
   `assets/permission-modes/run-permission-prompt.html`): renders
   `permission.requested` — tool name, summarized input (command line / file
   path, truncated), and one button per offered `PermissionOption`
   (allow once / allow always / reject once / reject always — only what the
   backend actually offers). While pending: run status `waiting`, attention
   ladder `permission` (already highest), browser notification via the
   existing run-notifications gate. After resolve (from any tab): buttons
   collapse into the outcome line.

## Edge Cases & Failure Scenarios

- **Unanswered prompt** — run parks at `waiting` indefinitely (gate Q4). The
  15-minute idle close (`IDLE_TIMEOUT_MS`) must treat a pending permission
  like a pending question: exempt while pending. User escape hatches: answer
  (Phase 2), interrupt (all backends), or terminal takeover via
  `claude --resume <sessionId>` (claude only — codex/opencode have no takeover
  path, so in Phase 1 their only escape is interrupt).
- **Autonomous + ask** — the auto-nudge loop must **not** answer or nudge past
  a pending permission; the run parks (this is exactly what the composer
  warned about).
- **Session dies with a pending prompt** — sink emits `permission.resolved`
  with `cancelled`; the card collapses; the answer route returns `409`.
- **Answer for an already-resolved request** (second tab) — `409`, card shows
  the first outcome (SSE replay dedupes by seq).
- **Backend can't honor a rule/mode** — never silently: one timeline notice
  per run stating what degraded (codex + rules; opencode + non-gated tool
  specifier; an older claude CLI lacking a mode value degrades to the nearest
  **stricter** claude mapping, and if the control channel is unavailable the
  run falls back to `auto` with a loud notice — degrading *looser* silently is
  the one unacceptable failure).
- **Malformed config key** — `.catch(undefined)` → behaves as `auto`; never
  blocks boot (zero-config rule).
- **Old run records / old events** — `permissions` and the new events are
  optional; old files parse. Old cockpit against new server ignores unknown
  events (existing contract).
- **`CEZ_DRY_RUN=1`** — the bundled mock CLI gains a scripted
  `can_use_tool` exchange so the whole flow is testable offline; dry-run must
  keep working for all presets.
- **Deny-by-rule** — enforced by the backend itself (claude
  `--disallowedTools`, opencode `deny`); the agent sees a normal tool denial
  and continues; no prompt, no park.

## Risks & Impact Review

- **Blast radius**: the three runners' arg/config builders (each currently
  hardcoded — pure-function changes with unit tests), the runs API, one
  settings section, the composer, the task thread. `auto` deliberately maps
  every backend to its unrestricted native settings; #563 lands the Codex
  mapping first, while #475 owns the remaining normalization and restrictive
  modes.
- **Backward compatibility** (per `BACKWARD_COMPATIBILITY.md`): config key
  additive; `RunRecord` field optional; API changes additive (new optional
  body key, new route). The reserved `UiPermissionResolvedEvent` gets a
  pre-activation shape change (`optionId` optional + `cancelled` variant) — a
  type edit, not an additive change, but zero-risk while nothing emits or
  renders the type; it must land before the first emitter. Workflow YAML
  schema untouched. No protected surface breaks.
- **Vendor drift**: claude mode names / codex policies / opencode keys can
  change under us. Mappings live in one translation function per runner with
  table-driven unit tests, so drift is a one-file fix; unknown values degrade
  stricter, never looser.
- **Security posture**: `auto` is deliberately unrestricted across all three
  backends per the issue author's 2026-07-21 clarification; guarded,
  read-only, manual, and advanced deny rules opt into tighter policies. The
  `deny` list is enforced by the backend, not by cezar string-matching. No new
  secrets or server network surface; the server stays loopback-only.
- **Rollback**: revert the code; the `permissions` config key is ignored by
  older builds (unknown-key tolerant), runs.json stays parseable. No
  migration in either direction.

## Phasing

- **Phase 1 — modes + settings + guard + prompt *detection***: config key,
  settings UI, composer override + autonomous guard, per-backend translation,
  **and the detect/emit half of each backend's approval channel** — every
  mapper recognizes its backend's approval request and emits
  `permission.requested`, the sink parks the run at `waiting` with a timeline
  note. Detection must ship with the modes: without it, a restrictive claude
  run would silently auto-deny (the CLI only routes approvals through
  `can_use_tool` when the host declares control-protocol support at the
  stream-json handshake) and a codex `on-request` approval would hang
  invisibly. No answer UI yet — independently shippable because `auto` never
  parks for approval and restrictive modes are usable-with-caveat:
  a parked run is escaped by interrupt (all backends) or terminal takeover
  (`claude --resume <sessionId>`, claude only) — both caveats documented.
- **Phase 2 — answering**: `AgentSession.respondPermission` per backend, the
  answer route, the prompt card, notifications, dry-run mock + e2e. Ships the
  full #475 experience.

## Implementation Plan

Each step leaves the app working and is unit-testable; validation gate per
step group is `npm run typecheck && npm test && npm run test:unit`.

### Phase 1: permission modes, settings, guard, prompt detection

- 1.1 `src/config.ts`: `permissions` key (schema, caps, `.catch(undefined)`) +
  config unit tests.
- 1.2 `src/core/agent-runner.ts`: `PermissionSpec` type on `AgentRunSpec`;
  `src/core/permission-map.ts`: pure preset+rules → per-backend translation
  tables + exhaustive unit tests (including unrestricted `auto` mappings for
  every backend).
- 1.3 `src/core/claude-cli-runner.ts`: consume the translation in
  `buildClaudeArgs` (modes, allow/ask/deny channels) + tests.
- 1.4 `src/core/codex-app-server-runner.ts`: sandbox/approvalPolicy from mode;
  rules → engine note + tests.
- 1.5 `src/core/opencode-server-runner.ts`: `permission` config from
  mode+rules; non-mappable specifiers → engine note + tests.
- 1.6 `src/server/server.ts`: `permissions` in config GET/PUT and in
  `POST /api/runs` (+ `lastPermissionMode` ui-state); `RunRecord` snapshot in
  `src/runs/store.ts` + API tests.
- 1.7 Settings → Agents Permissions block (radio + advanced rules editor) +
  component tests.
- 1.8 Composer: effective-mode chip, per-task override popover, autonomous
  guard warning + confirm (dynamic mode name) + tests.
- 1.9 Protocol: `UiPermissionResolvedEvent` shape change (`optionId`
  optional + `cancelled?: true`) in both protocol copies — type-only, lands
  before any emitter.
- 1.10 `src/core/claude-ui-mapper.ts` + runner: declare control-protocol
  support at the stream-json handshake; `control_request can_use_tool` →
  `permission.requested` (unanswered → CLI waits, which is the park) + tests.
- 1.11 `src/core/codex-ui-mapper.ts`: `requestApproval` JSON-RPC →
  `permission.requested` (request left pending) + tests.
- 1.12 `src/core/opencode-ui-mapper.ts`: `permission.updated` SSE →
  `permission.requested` + tests.
- 1.13 `src/runs/ui-event-sink.ts`: pending `permission.requested` → run
  status `waiting` + engine note; idle-timeout exemption while pending;
  `permission.resolved(cancelled)` on session end/interrupt + tests.
- 1.14 Docs: AGENTS.md routing-table row update, `BACKWARD_COMPATIBILITY.md`
  note for the new config key/route, per-backend escape-hatch caveats.

### Phase 2: answering permission prompts

- 2.1 `AgentSession.respondPermission` — claude: `control_response` writer on
  stdin + tests.
- 2.2 `respondPermission` — codex: JSON-RPC approval reply + tests.
- 2.3 `respondPermission` — opencode: session permissions endpoint reply
  (`once` / `always` / `reject`) + tests.
- 2.4 `POST /api/runs/:id/permissions/:requestId` route (404/409 contract) +
  API tests.
- 2.5 Cockpit prompt card in the task thread + attention/notification wiring +
  component tests.
- 2.6 `scripts/mock-claude.mjs`: scripted permission exchange for
  `CEZ_DRY_RUN=1`; e2e spec driving prompt → answer → run continues.
- 2.7 Full gate (`npm run build`, `npm run test:package`, `npm run test:e2e`)
  and spec/docs sync.
