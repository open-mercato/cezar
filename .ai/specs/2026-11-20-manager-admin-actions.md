# Managers change cezar through approval cards (2026-11-20)

Extends `2026-10-31-managers.md` (§ Safety, § `cez manager`), `2026-11-12-manager-connectors.md`,
`2026-11-17-questions-inbox.md` and `2026-11-19-manager-deactivate.md`. Design page:
`2026-11-20-manager-admin-actions.html` (card mockups, desktop and phone, and the future policy screen).
Status: **design approved** (2026-11-20, decisions in § 7). No code yet; phase 0 next.

## Problem

A manager can start, steer, cancel and retry tasks, create paused automations, and propose four
things: a merge, an automation enable, a saved job and a connector call. It cannot change cezar
itself. "Set this project's default model to Sonnet", "turn off the nightly automation", "reclaim
the old worktrees" and "add ~/code/shop as a project" all end with the manager telling the user
which screen to open. The user wants the manager to do these the way it already proposes a merge:
a card in the chat, approved with one tap. Later the user wants to let some of them run without a
tap at all.

Today each proposal type has its own command, its own `ManagerActionRequest` variant, its own
`stampAction` branch and its own `perform` branch. Adding about 80 admin actions this way would mean
80 of each. This spec adds one registry and one card shape instead.

## Decisions in one place

1. **One registry of admin operations** (`managers/admin/registry.ts`). Each entry (an *op*)
   declares its id, category, scope, risk, parameter schema, how it reads the current state, how it
   applies the change through the existing route, and how it is undone. The CLI, the capability
   list, the card, the audit log and the future policy all read from it.
2. **One CLI verb**: `cez-manager propose <op> …`. It replaces nothing: `merge`, `automation …
   enable`, `job add` and `propose-action` keep working and become registry ops underneath.
3. **One new card variant**, `type: 'admin'`. The server works out and stamps exactly what will
   change (before → after rows), who asked, in which turn, and what undo will be possible. The
   cockpit renders those stamped rows generically, so a phone or older cockpit never needs
   per-op code to show a card truthfully.
4. **Every decision goes through the existing `decision` route.** Nothing a manager's tools can
   reach performs a change. Auto-approval, when it arrives, calls the same `decide` path with
   `decidedBy: policy`. It is not a second path.
5. **A paired phone may approve any change card** (decided 2026-11-20). The card is the authority:
   the server stamped its rows and pin, the phone proves it showed them (`seen`, § 2.2), and the
   change applies with the host's capabilities, as it does for a desktop approval. What the phone
   could not do *directly* (unpair a phone, add an account) it can approve as a card. Limits:
   - handoff cards still need their screen, and a screen that exists only on the computer says
     "Open on your computer";
   - pairing a new phone stays physical.
   The audit entry records `device: 'phone'`.
6. **Everything is audit-logged**, with undo where the registry declares one.
7. **v1 always asks.** The policy model, its evaluation hook and its hard ceilings ship in the code
   (§ Auto-approval). The rule list stays empty, and no route can write it until phase 4.

## 1. Inventory

Sources: the mutating `/api/v1` routes in `server/server.ts` and its route modules, the settings
registry (`web/routes/settings/registry.tsx`), the admin surfaces outside Settings, and the `cez`
CLI. Task-run actions (start, steer, cancel, retry, land, PR) are out of scope: managers already
have those.

**Columns.**
- **Risk**: L, M or H (§ 1.1).
- **How**:
  - **change**: a normal card that performs the change on approve.
  - **handoff**: a card that opens the right screen, for anything that needs the human, a browser
    or a secret (§ 2.5).
  - **—**: not offered to managers (reason given).
- **Undo**:
  - **full**: the previous value is restored exactly.
  - **partial**: the change is restored but something is lost (the note says what).
  - **none**: cannot be undone.
- **Ph**: the rollout phase (§ 6).
- A `*` marks an action that is **pinned to ask**: no future policy can ever auto-approve it (§ 4.3).

### 1.1 Risk levels

- **L, low**: cosmetic or easily reversed, affects only scheduling or labels, no cost or exposure
  change. Examples: tags, a phone's label, pausing an automation.
- **M, medium**: changes how future tasks run or what they cost, and stays reversible. Examples:
  default model or runner, max parallel, retention days, base branch, editing a paused automation.
- **H, high**: one of the following:
  - adds or removes a project, account, manager, phone or credential;
  - widens what any agent can do (permissions, connectors, shell patterns, accounts allowed for
    tasks);
  - writes text that later becomes an agent's prompt (system prompts, workflows, automation tasks,
    instructions);
  - deletes something;
  - starts unattended activity;
  - cannot be undone.

A risk level belongs to the op, never to the card: a manager cannot argue a delete down to low.

### 1.2 Projects (`[W]` registry routes)

| Op id | What | Route | Risk | How | Undo | Ph |
|---|---|---|---|---|---|---|
| `project.tags` | Set a project's tags | `PATCH /projects/:id {tags}` | L | change | full | 1 |
| `project.max-parallel` | Per-project parallel limit | `PATCH /projects/:id {maxParallel}` | M | change | full | 1 |
| `project.add` | Register an existing folder, and attach it to the proposer (§ 3.1) | `POST /projects {root}` + manager attach | H* | change | full (unregister and detach) | 3 |
| `project.clone` | Clone from GitHub, register, attach | `POST /projects/checkout` | H* | change | partial (unregister and detach; the clone stays on disk) | 3 |
| `project.create` | New repository (optionally on GitHub, in a named owner or org), register, attach | `POST /projects/create` | H* | change | partial (unregister and detach; the GitHub repository and the folder stay) | 3 |
| `project.git-init` / `project.publish-github` | Initialise git, publish to GitHub | `POST /projects/:id/git-init`, `/publish-github` | H* | change | none | 3 |
| `project.remove` | Unregister. Files stay; refused while tasks run | `DELETE /projects/:id` | H* | change | partial (re-add; open tasks and the workspace's per-project settings are not restored) | 3 |
| `project.rename` | Set a display label. **New**: an optional `label` on the registry entry, shown wherever the name is (the folder name stays the fallback and the id never changes). Users get the same field in Settings → Project → General | `PATCH /projects/:id {label}` (new field) | L | change | full | 1 |

### 1.3 Project settings (`PUT /p/:id/config`, one op per field group; each is a one-field PUT)

| Op id | Fields | Risk | How | Undo | Ph |
|---|---|---|---|---|---|
| `project-config.default-runner` | `defaultRunner` | M | change | full | 1 |
| `project-config.default-models` | `defaultModels`, `defaultModelsAuto` (refused when `CEZ_AGENT_MODELS_LOCKED`) | M | change | full | 1 |
| `project-config.base-branch` | `baseBranch` | M | change | full | 1 |
| `project-config.review-gate` | `reviewGate`, `requiredChecks` | M | change | full | 1 |
| `project-config.task-workspace` | `profile`/`taskWorkspace`/`landing` (development model, where tasks work, auto-land) | M | change | full | 1 |
| `project-config.retention` | `worktreeRetention`, `worktreeIdleDays`, `archivedTaskDeleteDays` | M | change | full | 1 |
| `project-config.max-parallel` | `maxParallel` (project file) | M | change | full | 1 |
| `project-config.branch-naming` | `branchNaming` (instructions text) | H (prompt text) | change | full | 2 |
| `project-config.system-prompt` | `systemPrompt` | H* (prompt text) | change | full | 2 |
| `project-config.team-skills` | `teamSkills`, default and ask skill | H (fetches and runs others' prompts) | change | full | 2 |
| `project-config.worktree-lifecycle` | lifecycle scripts | H* (shell commands) | change | full | later |
| `project-config.bypass-permissions` | `bypassPermissions` | — | — | — | never: it lifts every task's sandbox, and a hosted cockpit already refuses it |
| `agent-config.write` | Claude/Codex/OpenCode config files | — | handoff (opens the editor) | — | 3. A direct write is never offered: hooks are code execution, and hosted already 409s |
| `start-app.set` | Preview start recipe | H* (shell command) | handoff | — | later |
| `project-ui.prompt-templates` | Prompt templates | M | change | full | 3 |

### 1.4 Workspace settings (`PUT /workspace/config`, `PUT /workspace/ui-state`)

| Op id | Fields | Risk | How | Undo | Ph |
|---|---|---|---|---|---|
| `workspace.resources` | `resources.maxParallel`, monitoring sessions, idle timeout, memory, wake mode, auto-resume, disk guard, worktree cap | M | change | full | 1 |
| `workspace.retention-defaults` | `resources.worktreeIdleDaysDefault`, `archivedTaskDeleteDaysDefault`, retention default | M | change | full | 1 |
| `workspace.task-defaults` | autonomous by default, worktree by default, `composerDefaults` | M | change | full | 1 |
| `workspace.agent-defaults` | default agent for new projects, default model per account (`agentDefaults`) | M | change | full | 1 |
| `workspace.branding` | instance name | L | change | full | 1 |
| `workspace.global-instructions` | `systemPrompt` | H* (prompt text) | change | full | 2 |
| `workspace.skill-repos` | `orgSkillsRepos`, `skillsAutoUpdate` | H* (remote prompts) | change | full | 2 |
| `workspace.folders` | `browseRoot`, `projectsDir` | H (widens what Add can reach) | change | full | 3 |
| `workspace.notifications` | browser notifications | — | handoff (needs the browser's permission prompt) | — | 2 |
| `workspace.appearance`, keybindings, sidebar order | personal per-browser or per-user preferences | — | not offered: no task needs it, and it is the user's own space | — | never |
| `workspace.telemetry-consent` | `PUT /telemetry/consent` | — | handoff only. Consent must be the user's own act (AGENTS.md § Telemetry) | — | 2 |
| `workspace.self-update` | channel, apply, schedule | H* | handoff (Settings → updates) | — | later |
| `workspace.config-import` | config bundle import | — | handoff | — | later |
| `workspace.secrets.*`, `project.secrets.*` | secret values | — | handoff only (§ 3.2). The card names the secret and its audiences; the value is typed in the cockpit | — | 2 |
| `workspace.branding-logo` | logo upload | — | not offered (binary) | — | never |

### 1.5 Agent accounts and providers

| Op id | What | Route | Risk | How | Undo | Ph |
|---|---|---|---|---|---|---|
| `account.select` | Account used for a project or machine default | `PUT /workspace/agent-profiles/selection` | M | change | full | 2 |
| `account.fallback` | Automatic fallback on or off, and its order | `PUT …/fallback-policy` (revisioned) | M | change | full | 2 |
| `account.plan-usage` | Plan-usage tracking per account | `PUT /workspace/plan-usage/tracking` | L | change | full | 1 |
| `account.rename` | Account label | `PATCH /workspace/agent-profiles/:id {label}` | L | change | full | 2 |
| `provider.enabled` | "Use <provider>" switch | `PUT /providers/:p/enabled` | M | change | full | 2 |
| `account.add` | New account (agent, label, config folder) | `POST /workspace/agent-profiles` | H* | change, then a sign-in handoff | partial (remove) | 3 |
| `account.connect` / `account.reconnect` | Sign in | `POST /providers/login` or `/connect` | — | **handoff**: the card opens the existing inline reconnect flow (spec 2026-11-18) | — | 2 |
| `account.remove` | Remove an account | `DELETE /workspace/agent-profiles/:id` | H* | change | none (the sign-in is lost) | 3 |
| `provider.update` | Update a CLI | `POST /providers/:p/update` | M | change | none | later |
| `github.login` / `github.logout` | `gh` sign-in | `POST/DELETE /github/login` | — | handoff (device code) | — | 3 |

"Accounts allowed for tasks" is per manager (`taskAgents`) and per project (selection + fallback).
The manager rows below cover the first.

### 1.6 Connectors and the issue tracker

| Op id | What | Risk | How | Undo | Ph |
|---|---|---|---|---|---|
| `tracker.associate` / `tracker.disassociate` | Link a project to a Jira/Linear project | M | change | full | 3 |
| `tracker.credentials` | Jira token or Linear key | — | handoff (secret) | — | 3 |
| `tracker.remove-credentials` | `DELETE /tracker/connection` | H* | change | none | 3 |
| `webhook.create` / `webhook.edit` | Destination URL is a credential for Slack/Discord | — | handoff | — | later |
| `webhook.pause` / `webhook.resume` | — | L / M | change | full | later (only when `CEZ_WEBHOOKS=1`) |
| `webhook.delete`, `webhook.rotate-secret` | — | H* | change | none | later |
| Manager connectors (MCP grants) | per manager, see § 1.7 | | | | |

### 1.7 Managers (`[W]`, `PATCH /workspace/managers/:id` and friends)

The **target** of an op may be the proposing manager (*self*) or another manager.

| Op id | What | Risk | How | Undo | Ph |
|---|---|---|---|---|---|
| `manager.rename` | Name or persona | L | change (self allowed) | full | 1. Moves today's direct `rename` onto a card, § 3.1 |
| `manager.quick-prompts` | Prompt chips | L | change | full | 2 |
| `manager.notify` | Notify me when important | L | change | full | 2 |
| `manager.cadence` | `cronMinutes` | M (cost). H* when it makes checks more frequent | change | full | 2 |
| `manager.follow-up` | `followUp` | M | change | full | 2 |
| `manager.agent` | Its own runner, account, model and effort | M (cost) | change | full | 2 |
| `manager.task-agents` | `taskAgents`: accounts allowed for its tasks | H* when it widens, M when it narrows | change | full | 3 |
| `manager.projects` | Connected projects | H* when it widens, M when it narrows | change | full | 3 |
| `manager.access` | `access`/`projectAccess` (read-only or write) | H* when it widens, M when it narrows | change | full | 3 |
| `manager.connectors` | MCP grant levels, per-tool modes | H* when it widens | change | full | 3 |
| `manager.shell-allow` | `bashAllow` patterns | H* when it widens | change | full | 3 |
| `manager.cancel-any` | `cancelAnyTask` | H* when it widens | change | full | 3 |
| `manager.admin-access` | The new `adminAccess` (§ 3.1) | — | not proposable: set only in Settings, by the user, for any manager | — | never |
| `manager.deactivate` | Deactivate another manager | M | change, applied by the decision route (the deactivate spec's "no tool route changes it" still holds). Never self: a manager that wants to stop says so in chat | full | 3 |
| `manager.reactivate` | — | — | not offered: the deactivate spec's rule "a manager never switches itself or another manager on" stands | — | never |
| `manager.create` | New manager with the stated instructions and permissions | H* | change. The card lists every permission the new manager gets; it can never exceed the proposer's own | partial (deactivate) | 3 |
| `manager.delete` | Delete another manager | H* | change. Never self | none | later |
| `job.add` | Saved job | H* (unattended) | change: **today's `add-job`, unchanged** | full | 0 |
| `job.edit` | Prompt or interval | H* (prompt text) | change | full | 2 |
| `job.pause` / `job.resume` | Enabled flag | L / H* | change | full | 2 |
| `job.remove` | Today a direct call with no card; kept direct (it only narrows) but audit-logged | L | direct | full | 0 |
| `manager.auto-approve` | The policy | — | **never proposable** (§ 4.3) | — | — |
| `manager.confirm` | Confirmation sheet toggles | — | never proposable (it governs the user's own tap) | — | — |

### 1.8 Automations (`/p/:id/automations`)

| Op id | What | Risk | How | Undo | Ph |
|---|---|---|---|---|---|
| create / edit (paused) | today's `cez-manager automation create|update`, direct and always paused | — | direct, unchanged, but checked on the server (§ 3.6) | — | 0 |
| `automation.enable` | **today's `enable-automation`, unchanged** | H* | change | full (pause) | 0 |
| `automation.pause` | Pause | L | change | full (enable; this undo is itself a user act) | 1 |
| `automation.delete` | Delete | H* | change | full: the card stamps the definition, and undo recreates it paused | 1 |
| `automation.report-link` | `PUT …/report` to another manager | M | change | full | 2 |
| `automation.import` | Import a file | H* | handoff | — | later |

### 1.9 Skills and workflows

| Op id | What | Risk | How | Undo | Ph |
|---|---|---|---|---|---|
| `skills.refresh` | `POST /skills/refresh`, skills-update check | L | change | none (refreshing is idempotent) | 1 |
| `skills.update-apply` | `POST /workspace/skills-update/apply` | M | change | none | 2 |
| `workflow.save` | Create or overwrite (`POST /workflows`, `/workflows/graph`) | H* (prompt text) | change. The card shows the full YAML diff | full (restore the previous file, or delete a new one) | 2 |
| `workflow.delete` | `DELETE /workflows/:name` (built-ins refuse) | H* | change | full (the card stamps the file) | 2 |
| `skills.import` | Project ui-state `importedSkills` | M | change | full | 3 |

There is **no skill install or delete route**: skills arrive through repositories (`orgSkillsRepos`,
`teamSkills`), covered above.

### 1.10 Phones and the relay

| Op id | What | Risk | How | Undo | Ph |
|---|---|---|---|---|---|
| `phone.rename` | `PATCH /workspace/phones/:deviceId` | L | change | full | 2 |
| `phone.remove` | Unpair | H* | change | none (pairing needs the phone) | 3 |
| `relay.keep-awake` | `PUT /workspace/phones/keep-awake` | L | change | full | 2 |
| `relay.computer-name` | — | L | change | full | 2 |
| `phone.pair`, `relay.account`, `relay.address`, pairing approve/deny | Physical pairing, an email link, legal terms, or unpairing every phone | — | handoff | — | 3 |
| `phone.push` | Phone-only grant | — | never | — | — |

The phone routes refuse requests that come *from* a phone (`requirePhones` 403). A card is
different (rule 5): a phone may approve `phone.rename` or `phone.remove`, and the decision route
applies it through the host. A phone can never approve its own removal: that card says "Approve on
another device", or the phone would lose its pairing mid-decision.

### 1.11 Worktrees and disk

| Op id | What | Risk | How | Undo | Ph |
|---|---|---|---|---|---|
| `worktrees.reclaim` | `POST /worktrees/reclaim` with an explicit `runIds` list from a dry run | M | change | partial: Continue restores each worktree; the branch was kept | 1 |
| `worktrees.prune` | `POST /worktrees/prune` | L | change | none (only stale git metadata) | 1 |
| `runs.archive-finished` | Archive finished tasks | L | change | full (unarchive) | 1 |
| `runs.delete-expired` | `POST /runs/archived/delete-expired` | H* | change | none | 3 |
| `worktree.remove-orphan` | lifecycle `orphan` removal | H* | change | none | 3 |

### 1.12 Not offered at all

Terminal sessions, agent-setup PTY input, the design proxy, uploads, `open-in`, telemetry relays, and
`repo/*` git operations on the main checkout. These are either a human's interactive tool or a
shell, and the second is already the manager's known gap: a task it starts has one.

## 2. The mechanism

### 2.1 Registry

```ts
// packages/cezar/src/managers/admin/registry.ts (server); ids, categories and param schemas in the contract
interface AdminOp<P> {
  id: AdminOpId;                       // 'project-config.default-models'
  category: AdminCategory;             // 'project-settings'
  scope: 'project' | 'workspace' | 'manager';
  risk: 'low' | 'medium' | 'high';
  pinnedAsk?: true | ((plan) => boolean);   // § 4.3; a function for "high when it widens"
  kind: 'change' | 'handoff';
  params: ZodType<P>;                   // the contract's schema: bounded ids, enums and numbers. No secret ever
  summary: string;                      // one line for `propose --help`
  plan(ctx, params): Promise<AdminPlan | Refusal>;   // reads current state through `forward` (GET)
  apply(ctx, plan): Promise<Outcome>;              // forwards to the existing route, carrying the pin
  undo?: (ctx, entry) => Promise<Outcome>;        // the inverse, checked against the `after` pin
}
interface AdminPlan {
  subject: string;                      // one waiting card per subject: 'project:abc/defaultModels'
  title: string;                        // 'Change default model · meblohand'
  rows: { label: string; before: Shown; after: Shown }[];
  pin: string;                          // digest of the `before` values; apply refuses on mismatch
  undo: 'full' | 'partial' | 'none';
  undoNote?: string;                    // 'Continue restores each worktree'
  handoff?: { label: string; href: string };  // a cockpit path such as /settings/global/agents#account-x
  warnings?: string[];                  // 'Running tasks keep the old model'
}
type Shown = { text: string } | { long: string } | { list: string[] } | { secretName: string } | { none: true };
```

`apply` never reimplements a route. It forwards in-process, as `perform` already does for
`enable-automation` and `merge-pr`, so validation, gates (`localHandoff`, `CEZ_*` flags, locked
models) and telemetry stay in one place. The four existing types become registry entries:
`merge-pr`, `enable-automation`, `add-job` and `connector-call`. Their `stampAction`, `perform`,
stale checks and one-card-per-subject logic move behind `plan`/`apply`, and **their wire shapes do
not change**. `cardSubject` and `actionKey` generalise to `plan.subject`.

### 2.2 Wire shape

One new variant in `managerActionRequestSchema`:

```ts
z.object({
  type: z.literal('admin'),
  request: adminOpRequestSchema,          // discriminated on `op`: { op, projectId?, managerId?, params }
  // Stamped by the server at proposal. Anything the agent sends here is ignored:
  stamp: adminStampSchema.optional(),     // { title, category, risk, pinnedAsk, rows, pin, undo, undoNote?, handoff?, warnings? }
  provenance: adminProvenanceSchema.optional(),  // server-derived, § 3.5
})
```

The `action` message gains two optional fields:
- `decidedBy?: { kind: 'user', device: 'desktop' | 'phone' } | { kind: 'policy', ruleId }`;
- `undo?: { available, until?, undoneAt?, undoActionId? }`.

All new fields are optional, so old chat files parse.

**Telemetry.** `managers/telemetry.ts` records action types as closed sets. Phase 0 adds `admin` to
them, plus the op's `category`, `risk` and `decidedBy.kind` as closed-set labels (from the registry,
enforced by the server). The op's params, rows, reason and project never leave the machine.

**Old clients.** `UNKNOWN_ACTION_COPY` lets an older cockpit approve a card it cannot describe. For
`admin` cards the decision input gains `seen: <pin>`, and the server refuses an approve without the
matching pin with 409 "Update cezar on this device to approve this". A stale phone build can then
never approve a change it did not show.

### 2.3 Routes

All are chained into the managers family, with zod in `packages/contract/src/managers.ts` (or a new
`admin-ops.ts`) and parity-tested.

| Route | Who | What |
|---|---|---|
| `POST /workspace/managers/:id/actions` | manager tools | Unchanged route; now also takes `type: 'admin'` |
| `POST /workspace/managers/:id/actions/plan` | manager tools | Dry run: returns the stamp, creates no card (`propose --dry-run`) |
| `GET /workspace/managers/:id/admin-ops` | manager tools, cockpit | The capability list for *this* manager (§ 5.3) |
| `POST /workspace/managers/:id/actions/:actionId/decision` | cockpit only | Unchanged, plus `seen` |
| `POST /workspace/admin-audit/:entryId/undo` | cockpit only | Undo (§ 3.4) |
| `GET /workspace/admin-audit` | cockpit | The change history (§ 3.4) |

### 2.4 Flow

```
cez-manager propose project-config.default-models --project meblohand --set claude=claude-sonnet-5-5 --reason "…"
  → POST …/actions {type:'admin', request}
  → engine.propose: toolScope (connected, write, not a watch turn) → adminAccess check (§ 3.1)
      → registry.plan(): reads current config, builds rows and pin; refuses a no-op ("already Sonnet 5.5")
      → one waiting card per subject (replace or return the existing one, as for merges)
      → provenance stamped from the live turn (§ 3.5)
      → policy.evaluate(manager, card) → v1 always { mode: 'ask' }   ← the auto-approval seam
      → publish the card; alert "Needs your approval: …"
user taps Approve (desktop or phone)
  → decision {approve, seen: pin}
  → engine.decide: re-read scope, access, adminAccess; plan again and compare the pin (refuse if the state moved)
      → apply with the host's capabilities, desktop or phone (rule 5)
      → audit entry; settle 'done' or 'failed'; note to the manager
```

### 2.5 Handoff cards (human in a browser, secrets, consent)

A handoff op has no `apply`. Its card says what is needed and why, and its button is **Open** (not
Approve). Open navigates to `plan.handoff.href`, or, for an account sign-in, mounts the existing
inline reconnect flow (`components/reconnect/*`) right in the card. The card stays pending until
either:
- the server **observes** the outcome. The registry entry declares the observation: the account's
  status turns connected, a secret named X exists, a phone with that label paired. The card then
  settles `done` with "Signed in as …"; or
- the user dismisses it.

Observation reuses the existing reads (provider status, `GET /workspace/secrets`) on the same
signals that already refresh them. Nothing new polls. Examples:
- "Sign Codex (work) in again" → inline reconnect;
- "Add a Linear key for meblohand" → `/p/meblohand/settings/tracker`, with the form focused;
- "Turn on browser notifications" → `/settings/global/notifications`.

## 3. Safety rules

These hold in v1 and continue to hold with auto-approval.

### 3.1 A manager never widens its own permissions and never approves its own cards

- **New `Manager.adminAccess?: 'none' | 'projects' | 'workspace'`** is set only in the cockpit. The
  default (absent) is `projects`:
  - `projects`: project-scope ops on its **write** projects, plus **bringing in new projects**
    (`project.create`, `project.clone`, `project.add`), each attached to itself (below);
  - `workspace`: also workspace and manager ops;
  - `none`: no admin ops.
  A read-only project never admits an admin op, matching today's rule that read-only refuses
  proposals.
- **New projects join their proposer: the one sanctioned self-widening** (decided 2026-11-20). A
  project op's `attachToSelf` param defaults to true. The card then carries one more row,
  "Scout's projects: meblohand, cezar → meblohand, cezar, **shop** (write)", so the widening is shown
  on the card that causes it. One approval registers the project and attaches it. Example: "create a
  repo `shop` in org xyz" proposes one `project.create` card: GitHub repository, local clone,
  registration and attach. The carve-out is narrow:
  - it applies only to a project that did not exist in the registry before this card (an existing
    project still needs `manager.projects`, which refuses for self);
  - the access granted is at most the proposer's default access;
  - it is pinned to ask, and never auto-approved.
  A manager connected to `all` projects gets the project anyway, and that row is omitted.
- **Ops on any manager's permissions** (`manager.projects`, `.access`, `.connectors`,
  `.shell-allow`, `.cancel-any`, `.task-agents`, `.create`) are always H and pinned to ask. Every
  widening op refuses when the target is the proposer itself; the only exception is a new project
  joining it, above. Narrowing itself is allowed but still asks. `adminAccess` is not an op at all.
- **Every manager-to-manager widening is capped by the proposer** (§ 7, decision 3). For
  `manager.create` and for every widening op whose target is another manager, each granted value
  (projects, access, connectors, shell patterns, task agents, `cancelAnyTask`, and the new manager's
  adminAccess) must be a subset of the proposer's own. Otherwise the proposal refuses, saying which
  grant exceeds. Without this, two managers could widen each other past what either holds, one
  "never self" card at a time.
- **Policy and confirmation settings are not ops** (§ 1.7). The policy can only be edited in
  Settings, by the user.
- **Decisions.** The `decision` and `undo` routes are cockpit routes. Today the only thing between a
  manager and them is the Bash policy (Claude and Pi), plus the prompt on other runners. This spec
  adds a cheap belt: each manager turn gets a random **turn token** (`CEZ_MANAGER_TURN_TOKEN`, held in
  memory only), and `cez-manager` sends it as `x-cez-manager-turn`.
  - Manager tool routes **require** it. That also gives the server the turn's kind and the
    triggering message, rather than trusting `CEZ_MANAGER_ID`.
  - Decision, undo, policy and `PATCH /workspace/managers/:id` **refuse** any request that carries
    one.
  This is not a fence against a process that omits the header (§ 3.7). It does stop the manager's
  own CLI from ever reaching them, and gives honest attribution.
  - This changes routes `BACKWARD_COMPATIBILITY.md` § 2 already lists (the tool routes and
    `PATCH /workspace/managers/:id`), so phase 0 updates those rows, not only adds new ones. The
    `cez-manager` shim ships with the server, so no supported client lacks the header. A turn already
    running across an upgrade has no token: its next tool call is refused once with "cezar was
    updated: finish this reply", and the following turn has one.
- **Today's gaps closed in phase 0:**
  - `cez-manager rename` calls the general `PATCH /workspace/managers/:id`, the same route that
    changes access. It moves to a narrow tool route `POST …/rename` (name only), and the PATCH then
    refuses a turn token.
  - `cez-manager automation …` talks to `/p/:id/automations` directly, and its read-only, scope,
    always-paused and no-delete checks are client-side only. It moves behind a manager tool route
    that enforces them on the server.

### 3.2 Secrets never pass through the manager or its chat

- No op's `params` may hold a secret. A contract test walks every op schema and fails on a field
  named or described as a token, key, password, secret value, credential or URL that is itself a
  credential (webhook destinations). Secret-bearing actions exist only as **handoff** ops.
- `Shown` has a `secretName` variant and no `secretValue` variant. Rows show a secret's name, its
  audiences and "set / not set", never its value.
- Plans read through the same routes the cockpit uses, and those already return names only
  (`GET /workspace/secrets`). Audit entries are built from rows and params, so they cannot contain a
  value either.
- A connector or tracker sign-in happens in the cockpit (inline reconnect, settings form). The
  manager hears only the outcome line: "Codex (work) signed in again".

### 3.3 Everything is audit-logged

- **Storage.** `~/.cezar/admin-audit.ndjson`, append-only, written through `cezarHomeDir()` and
  rotated at 5,000 entries (the older half moves to `admin-audit.1.ndjson`). Appends and rotation
  run under one cross-process lock, so a CLI and a server writing at once never lose or duplicate a
  line. Deleting it loses history, never boot.
- **Each entry** holds:
  - `id`, `at`, `op`, `scope`, `managerId`, `managerName`, `actionId` (the card), `reason` (the
    manager's, verbatim and fenced as agent text);
  - `provenance`, `rows`, `pinBefore`, `pinAfter`;
  - `decidedBy`, `outcome`, `result`;
  - `undo: { kind, undoneAt?, undoEntryId? }`.
- **What gets logged:** every applied admin op, every undo, every policy auto-approval, and the
  rejected and failed decisions. It also logs the existing four action types and the direct manager
  writes (`job remove`, paused automation create and edit, rename), so the history is complete.
- **Where it shows:**
  - Settings → Manager → **Change history**: one list, filterable by manager, project and category.
    Each row offers Undo while available.
  - Each card's settled line links to its entry.

### 3.4 Undo where possible

- `undo` is the registry's inverse, executed through the same `apply` path. It is pinned to the
  `after` state: if anything changed the same fields since, undo refuses with
  "Changed again since. Current value: …".
- **Window:**
  - `full` undo stays available until a newer change to the same subject, or 30 days;
  - `partial` undo states what will not come back before you press it.
- Deletions that declare `full` undo do so by stamping the deleted definition into the card at plan
  time (automations, workflows, jobs). Their undo recreates it, and recreates automations **paused**.
- Undo is a user act: it is a cockpit route and is itself audit-logged. A manager may *propose*
  reverting (`propose undo <entryId>`), which is just another card.

### 3.5 Prompt injection: text from PRs, issues or tasks can never cause an admin change unseen

The threat: a watch, job or follow-up turn reads attacker-written text (PR bodies, issue text, a
task's final message) and the model proposes or performs something.

1. **Nothing performs without the decision route** (§ 3.1). In v1 every admin change is a card the
   user taps after seeing the stamped before → after rows. The rows are computed by the server from
   the params, so the agent cannot make a card say one thing and do another.
2. **Watch turns cannot propose** (existing `WATCH_REFUSAL`, now enforced through the turn token
   rather than runtime state alone).
3. **Provenance is derived by the server, never claimed by the agent.** The engine knows the live
   turn's kind and its trigger:
   - `chat`, with the user's message id and its first 120 characters;
   - `followup`, with the task(s) whose report triggered it;
   - `job`, with the job name;
   - `automation-report`, not a turn: it cannot propose.
   The card shows this prominently: *"Asked in chat, after your message 'tidy up meblohand'"*, versus
   *"Proposed on its own after task Fix login finished"*, with an amber "on its own" chip. The
   manager's `--reason` is shown as quoted agent text, never as cezar's own words.
4. **Free text that becomes a future prompt is high risk and pinned to ask**: system prompts, global
   instructions, branch-naming instructions, workflows, job prompts, automation tasks and skill
   repositories. These are how an injection would persist, so they are always shown in full (a
   diff for edits) and never auto-approved.
5. **The auto-approval ceiling** (§ 4.3) excludes, whatever the rules say:
   - anything not provenance `chat`;
   - anything high or pinned;
   - anything without full undo.
   Decided: chat only (§ 7). No rule can cover follow-up, job or watch turns.
6. **Bursts are capped**:
   - at most 10 admin proposals per turn (the 11th refuses: "propose fewer changes at once");
   - at most 20 auto-approvals per manager per day, then the policy pauses itself and says so
     (§ 4.4).

### 3.6 Server-side checks that the CLI only did on the client

Phase 0 moves every manager restriction now held only in `manager-cli.ts` onto the server: the
automation scope, read-only, always paused, and no run or delete. That is a precondition: an admin
registry fenced only by the client would be the same gap at scale.

### 3.7 Known limits (stated, not solved)

- **The local API is unauthenticated by design** (zero config). A process with a free shell can call
  any route. On Claude and Pi the manager's shell is fenced by the allowlist and the PreToolUse hook,
  so it cannot. On Codex, OpenCode and the rest the prompt is the only fence: this is today's
  documented gap, not a new one. A task a manager starts has a full shell, as today. Auto-approval
  (phase 4) is therefore offered **only for managers on fenced runners**, and the settings screen
  says why.
- A phone approval applies with the host's capabilities (rule 5), so a stolen, still-paired, unlocked
  phone can approve any waiting card. This is the same exposure as that phone's chat today. Removing
  the phone (Settings → Connect a phone) cuts it off, and the audit log shows which device decided.

## 4. Auto-approval: designed now, built in phase 4

### 4.1 Data model (contract, in phase 0; writable from phase 4)

```ts
Manager.autoApprove?: {
  rules: Array<{
    id: string;                                   // stable, cited in the audit log
    match:
      | { categories: AdminCategory[]; maxRisk: 'low' | 'medium' }
      | { ops: AdminOpId[] };                     // still subject to the ceiling
    projects: 'connected' | string[];            // scope; workspace ops need adminAccess 'workspace'
    provenance: 'chat';                           // v4 only offers 'chat'; the enum leaves room for more
    limit?: { perDay: number };                   // default 20, max 50
    until?: string;                               // an optional expiry ("for this release week")
  }>;
  paused?: { since: string; reason: 'limit' | 'user' | 'undo-burst' };
}
```

Absent means always ask, so every existing manager is unchanged. In v1, `PATCH /workspace/managers/:id`
refuses `autoApprove` with 400 "not available yet". Turn-token requests always refuse it.

### 4.2 Evaluation (in phase 0, returning `ask`)

`policy.evaluate(manager, card): { mode: 'ask' } | { mode: 'auto', ruleId }` is one pure function in
`managers/admin/policy.ts`, called in `propose` right before publish. In phase 4, `auto` calls
`decide(id, actionId, 'approve', { decidedBy: { kind: 'policy', ruleId } })`: the very same path,
with the same re-checks, pin, audit and settle. Nothing else changes.

### 4.3 The ceiling, which no rule can lift

A card is auto-eligible only if **all** of these hold:
- the op is not `pinnedAsk` (including "widens" functions evaluated on the plan);
- its risk is not `high`;
- its kind is `change`;
- its undo is `full`;
- its provenance is `chat`;
- its target is not a manager's permissions;
- its scope is inside the rule's projects and the manager's `adminAccess`;
- the manager is on a fenced runner;
- the manager is active;
- the day's limit is not reached.

The ceiling lives in code, not in the policy, and has a test per clause.

### 4.4 How an auto-approved change looks

- **No question.** The card renders as a compact **notice**: "Changed meblohand's default model to
  Sonnet 5.5 · automatically · **Undo** · Why". *Why* expands the rows, the provenance and the rule
  ("Allowed: medium project settings in my projects").
- **It does not count** in Approvals or as needs-you.
- **Unread dot, no OS notification.** It raises the chat's unread dot but no notification, unless
  the manager marks it important.
- **Recent automatic changes.** The Approvals page grows a collapsed section for the last 7 days,
  with Undo.
- **Undo as feedback.** Three undos of auto-approved changes within 24 hours pause the policy
  (`paused: undo-burst`) with a one-line notice: "Paused automatic changes for <Manager>: you undid
  3 today."

### 4.5 Settings UI (phase 4)

The UI is in Settings → Manager → *<manager>* → **Changes to cezar** (mocked in the design page).
- **Access to cezar settings**: None / Its projects' settings / Its projects and workspace settings.
  This is `adminAccess` and ships in phase 1.
- **Allow without asking** (phase 4), off by default:
  - one checkbox row per category with a risk cap select (Low only / Low and medium), and **Only
    when I asked in chat** shown checked and locked;
  - pinned and high actions listed greyed out under "Always asks", with a link explaining why;
  - a per-day limit stepper and an optional expiry;
  - a status line: "Paused: you undid 3 changes today. **Resume**".
- **Change history** link.

## 5. How it looks

The design page has the mockups. In words:

### 5.1 Desktop card (chat and Approvals page, existing `ActionCard` frame)

```
┌ ⚙ Change default model · meblohand                                 Medium ┐
│ Asked in chat, after your message "use the cheaper model on meblohand"     │
│ ─────────────────────────────────────────────────────────────────────────  │
│ Claude model        Opus 5.5           →  Sonnet 5.5                        │
│ ─────────────────────────────────────────────────────────────────────────  │
│ Scout's reason  "You said meblohand tasks are routine fixes."               │
│ Running tasks keep their model. You can undo this for 30 days.             │
│                                                   [Reject]  [Approve]       │
└────────────────────────────────────────────────────────────────────────────┘
```

The other three examples are:
- `manager.access` on itself (H, pinned, red edge, "Widens Scout's own access", provenance "on its
  own" when it came from a follow-up);
- `account.reconnect` (handoff: **Sign in** mounts the inline reconnect);
- `worktrees.reclaim` (M, partial undo: a list of 12 tasks with sizes, 3.4 GB, "Continue restores
  each one").

### 5.2 CezarBot on the phone

The same card, compact, in the chat. A tap opens the existing bottom sheet: the title, the
before → after rows stacked vertically (label, old struck through, new), the provenance line,
the reason, and a full-width Approve button above Reject. Every change card is approvable from the
phone (rule 5); the one exception is the phone's own removal. Handoff cards whose screen
exists on the phone (account sign-in through the relay, notifications) open it. The others say
"Open on your computer". The auto notice is one line with Undo.

### 5.3 How the manager learns what exists

- `GET …/admin-ops` returns the registry filtered to this manager: its `adminAccess`, its write
  projects, the runner and the cockpit's capabilities. Each entry has its id, summary, risk, scope,
  kind, params (generated from zod as flag help) and an example.
- `cez-manager propose --help` prints that list grouped by category.
- `cez-manager propose <op> --help` prints its flags.
- `cez-manager propose <op> … --dry-run` prints the rows the user would see, so the agent can check
  itself before asking.
- The system prompt gets a short generated section, like `managerBashPromptSection`. It lists the
  category names and tells the manager:
  - "Changes to cezar go through `cez-manager propose`. Run `propose --help` for the list";
  - "Never ask the user for a secret or a password. Propose the handoff op instead";
  - "Changes you propose on your own after reading a PR, issue or task are labelled as such".
- **Flags**: `--project`, `--manager`, `--set key=value` (repeatable, typed by the op schema),
  `--json '<params>'` / `--file` for structured params such as a workflow, and `--reason`.
- Errors name the valid ops and flags, as the strict CLI already does.

## 6. Rollout

| Phase | Ships | Risk exposure |
|---|---|---|
| **0: foundation** (no user-visible change except audit) | Registry; the four existing types moved onto it with wire shapes unchanged; turn token; `rename` and `automation` moved behind server-checked tool routes; `admin-ops` capability route and `propose --help`; audit log for existing actions; the `autoApprove` schema plus `evaluate` returning `ask`; the `seen` pin on decisions; Change history (read-only list) | none new |
| **1: low and medium project and workspace settings** | `adminAccess` setting (default `projects`). Ops: project tags, max parallel and label (`project.rename`, new field); project config (runner, models, base branch, review gate, task workspace, retention, max parallel); workspace resources, retention defaults, task and agent defaults, branding; `account.plan-usage`; automation pause and delete; skills refresh; worktrees reclaim and prune; archive finished; `manager.rename`. Undo from cards and history | L/M plus two pinned H (automation delete, which has undo) |
| **2: prompt text, accounts, handoffs** | Handoff cards (account sign-in, secrets, notifications, telemetry consent); system prompt, global instructions, branch naming, team skills and skill repos (pinned, full text and diff); workflows save and delete; jobs edit and pause; account select, fallback and rename; provider enabled; manager notify, cadence, follow-up, agent and quick prompts; phone rename, keep awake, computer name | adds H, all pinned |
| **3: structure and permissions** | Project create (GitHub, in a named org), clone, add (each joining its proposer), git-init, publish and remove; account add and remove; manager create, deactivate (others), projects, access, connectors, shell allow, cancel-any and task agents (widening pinned, never self); tracker association; phone remove; folders; delete-expired and orphan removal; agent-config handoff | the high end |
| **4: auto-approval** | Settings UI, rule writes, `evaluate` live, notices, the Recent automatic changes section, undo-burst pause | only L/M, chat, full-undo, fenced runners |
| later | Webhooks; self-update; config import; lifecycle scripts; start-app; provider update; `manager.delete`; automation import | |

Each phase has its own PR, tests and BACKWARD_COMPATIBILITY.md §2 rows for new routes.

## Tests that matter

- **Registry contract test**: every op has a params schema with no secret-like field, a risk, and a
  scope. Every `change` op whose undo is `full` has an `undo`. Every pinned op is refused by
  `evaluate` even with a rule naming it.
- **Ceiling**: one test per clause in § 4.3.
- **Self-widening refusal** for each manager op, and the proposer-subset cap on `manager.create` and
  on every widening op that targets another manager (A cannot widen B past A's own grants).
- **Turn token**: manager tool routes refuse without it; decision, undo and PATCH refuse with it;
  a watch turn's token cannot propose.
- **Pin**: the state changes between proposal and approval, so the approval refuses. An undo after
  another change refuses.
- **Rule 5**: an approval from a relay device applies a phone-forbidden op (for example
  `phone.rename`) through the host, records `device: 'phone'`, and refuses the phone's own removal.
- **New project joins its proposer**: `project.create`/`clone`/`add` attach the new project to the
  proposer, and the card shows that row. An already-registered project refuses `attachToSelf`.
  Detach on undo.
- **Old client**: an approve without `seen` on an `admin` card is a 409.
- **Legacy cards**: merge, enable, job and connector proposals behave byte-for-byte as before
  (existing tests stay green, untouched).
- **Audit**: one entry per applied, rejected, failed, auto-approved and undone change. No secret
  value is reachable through any entry (fixture with a secret set).
- **Server-side automation checks**: a read-only project refuses, `--enable` refuses, delete refuses
  without a card.
- **Dry run**: `CEZ_DRY_RUN=1` mock turn proposes one `admin` card when asked to change a model (e2e
  plus screenshots, desktop and phone).

## 7. Decisions (2026-11-20, owner)

1. **Project rename**: add an optional display `label` (phase 1), for users and managers alike.
2. **Default `adminAccess`**: `projects`, which also covers bringing in new projects (create on
   GitHub, clone, add) that join the proposing manager (§ 3.1). Example: "create a repo in org xyz"
   creates the repository, registers the project and adds it to this manager, on one card.
3. **Manager-to-manager changes**: yes, as cards. Always asks, and capped by the proposer's own
   permissions.
4. **Deleting**: project removal, account removal and phone unpairing are offered in phase 3.
5. **Undo window**: 30 days.
6. **Auto-approval provenance**: chat only.
7. **Phone approvals**: trust the phone. A paired phone may approve any change card (rule 5).
8. **Spec landing**: as a `docs(specs)` PR, ready for review.
