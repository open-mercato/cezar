# Automations from a prompt — a task may create a GitHub automation

> Slug: `automations-from-prompt` · Status: implemented · Gated by the existing `CEZ_AUTOMATIONS=1`
> (→ `capabilities.automations`) plus the cockpit transport (`CEZ_API_URL`), exactly like dispatch.
> Extends: `2026-07-25-github-automations.md` (the feature), `2026-09-10-dispatch.md` (the mechanism).

## TLDR

A user types "whenever a PR is opened, review it" into the **New task** window and the agent creates
the automation instead of doing the work once. Two ways in, one mechanism underneath:

- **Pick the skill.** A built-in skill, `create-cezar-automation`, is listed in the composer's skill
  picker (and `/create-cezar-automation`) on any cockpit with automations on. Picking it pre-fills the
  prompt box with the two questions every automation needs answered (trigger, task) through a
  built-in prompt template assigned to it, and runs the task under a playbook: understand → write the
  definition → `cez automation create` (paused) → `cez automation check` (preview) → report the link.
- **Or just ask.** Every task's system prompt carries a short **automations part** that teaches the
  agent to recognise "whenever / every time a PR or issue …" as an automation and names the CLI. An
  agent that reads it runs `cez automation schema` for the shape and proceeds the same way.

Underneath: a `cez automation` CLI (`packages/cezar/src/automations/automation-cli.ts`), a thin HTTP
client over the existing `/api/v1/p/:projectId/automations*` routes, addressed by the same
`CEZ_API_URL` / `CEZ_PROJECT_ID` / `CEZ_BIN` variables the dispatch CLI uses. No new routes, no new
state, no new flag.

## Why this shape

- **Reuse the dispatch transport.** Spec 2026-09-10 found that turn-end markers were the cause of
  every fatal refusal; a CLI call gets a synchronous, typed answer, and the engine already publishes
  the cockpit's address and its own entrypoint to every agent. The automation CLI is the second
  client of that transport, not a third mechanism.
- **JSON, not flags.** A definition has nested filters and a task block. An agent writes JSON to a
  file more reliably than it quotes a dozen flags in a shell — so `create`/`update` take `--file`,
  `--json` or stdin, and `cez automation schema` prints the shape with every bound.
- **Paused by default, preview before enable.** The automations spec's Q1 (enabling establishes a
  baseline; a preview never launches) is exactly the safety an unattended agent needs: it cannot
  fan out a hundred tasks by creating one automation. The prompt and the skill both say create
  paused, preview, and enable only when the user asked.
- **Tell an agent only about what it can use.** The dispatch lesson (A2/A8: an agent taught a CLI
  whose every call is refused reads the refusal as "stop"): the prompt part, the built-in skill and
  the composer template are all gated on `capabilities.automations` **and** the transport
  (`automationsReachable()`), so a headless `cezar run` or a cockpit with the flag off composes
  nothing, lists nothing, offers nothing.
- **A built-in skill is the exception, named.** cezar has never shipped a skill file — every skill
  is discovered from the repo, the `npx skills` dirs or a team repo. This playbook belongs to the
  cockpit that runs the automations, not to any repository, so it ships as a TypeScript constant
  (`automations/builtin-skill.ts`, `source: 'builtin'`), appended LAST to the catalog so a repo
  skill of the same name shadows it. The `files` list, the pack gate and the discovery walk are
  untouched.

## Resolved assumptions

| # | Question | Applied default | Why |
|---|---|---|---|
| A1 | How a task creates an automation | `cez automation …` over the existing automations routes, through `node "$CEZ_BIN"`, with `CEZ_API_URL` and `CEZ_PROJECT_ID` from the agent's env. | Same transport and reasoning as dispatch A1; the routes already validate, baseline and log. |
| A2 | Gating | `automationsReachable()` = `capabilities.automations && CEZ_API_URL`. Off or unreachable: no prompt part, no built-in skill, no template; the CLI without `CEZ_API_URL` exits 2 saying so; with the flag off the routes' 409 (naming `CEZ_AUTOMATIONS=1`) is relayed verbatim and exits 1. | Dispatch A2/A8. |
| A3 | Enabled or paused on create | Paused unless `--enable`; the prompt says enable only when the user asked, and never without a preview. A definition copied from `show` carrying `enabled: true` is lifted into the route's `enable` flag rather than refused. | Automations Q1: no backfill, no surprise fan-out. |
| A4 | How the skill ships | One built-in `Skill` with `source: 'builtin'`, `path: builtin:create-cezar-automation`, `interactive: true`; `discoverSkills` appends `builtinSkills()` last. Contract enum gains `'builtin'` (additive). | The user's repo is the source of truth; nothing to isolate in a worktree, and the agent may have to ask which label was meant. |
| A5 | What the composer shows | The skill in the picker; a built-in template `create-automation` (Settings → Prompt templates, editable) assigned to the skill, hidden with `AUTOMATIONS_TEMPLATE_IDS` unless `capabilities.automations`. | Same gate as `DISPATCH_TEMPLATE_IDS`, same reason. |
| A6 | Where the prompt part sits | `ActiveRun.automationsPrompt`, resolved by `prepareAutomationsSession` at BOTH session construction sites, composed after the dispatch part and before the run's extra prompt. | AGENTS.md § "every construction site" — a Continue must keep it. |
| A7 | `update` semantics | Reads the current definition, merges the patch over the six editable keys, restates `enabled` and echoes `expectedRevision`. | A partial JSON from an agent must not blank keys it did not mention; a cockpit edit in between is a 409, not a clobber. |
| A8 | `check` | POSTs `{mode}` and polls the workspace-level `/automation-checks/:id` every 500 ms for up to 120 s; preview prints the count and "nothing was launched". | The check is asynchronous server-side; the agent needs one command that answers. |

## CLI (`packages/cezar/src/automations/automation-cli.ts`)

`cez automation schema` · `create [--file <def.json> | --json '<json>'] [--enable]` (stdin when
neither) · `update <id> [--file | --json]` · `check <id> [--execute]` · `list` · `show <id>` ·
`enable <id>` · `pause <id>` · `delete <id>`. Every mutating command prints the automation's cockpit
page (`<CEZ_API_URL>/p/<project>/automations/<id>`). Exit 0 ok, 1 refused/failed, 2 usage or no
cockpit. Routed in `index.ts` before the cockpit's own parser, like `cez task`.

## Prompt (`packages/cezar/src/automations/prompts.ts`)

`AUTOMATIONS_PROMPT` (the short always-on part), `AUTOMATION_SCHEMA_REFERENCE` (what `schema` prints:
every key of `automationDefinitionSchema` with its bounds, the events, the placeholders, the paused
rule — pinned against the storage schema by `prompts.test.ts`) and `CREATE_AUTOMATION_SKILL_BODY`
(the playbook, embedding the reference).

## Not done (deliberately)

A composer toggle or a dedicated "New automation from prompt" screen — the skill picker and the
template are the composer's existing affordances and cost nothing. Automation creation from a
headless `cezar run`. A `--dry-run` that validates a definition without a cockpit (the routes are
the validator). Changing the Automations page itself.
