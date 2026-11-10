# Run notes — automations redesign (spec `2026-09-14-automations-redesign`)

Source doc: `.ai/specs/2026-09-14-automations-redesign.md`
Builds on: `.ai/specs/2026-07-25-github-automations.md`, `.ai/specs/2026-09-13-automations-from-prompt.md`,
`.ai/specs/2026-09-10-dispatch.md`. Design: `.ai/specs/assets/automations-redesign/`.

## Goal

Add a schedule trigger kind, turn automations on by default, rebuild the Automations surface
to the Claude Design export from named primitives, and land the "create an automation from a
prompt" patch on top — one PR (owner decision Q5).

## What was built, by phase

1. **Primitives** — `Chip`, `Segmented`, `Kbd`, `BranchChip` promoted into
   `packages/web/src/components`; `Card` gained `flush`. `PickerPill` and the Tasks "group by"
   control now consume them.
2. **Contract + engine** — `packages/contract/src/automation-schedule.ts` (four bounded shapes,
   `cronOf`/`parseCron`, DST-safe `occurrencesBetween`/`nextOccurrence`) and
   `packages/contract/src/zoned-time.ts` (moved out of `core/usage-limit.ts`);
   `packages/cezar/src/automations/schedule-runner.ts` (the age rule: scheduled / one catch-up /
   skipped, receipts per occurrence, auto-pause after three launch failures, lease and duplicate
   never counted); `scheduler.ts` arms one timer for both kinds and gives every registered
   project a handle (`github` only for a github.com remote); `task-template.ts` renders schedule
   placeholders, maps `task.dispatch` to the intent and the review-child suffix, and writes the
   new optional `RunRecord.automationTrigger`; `store.setState` is read-modify-write.
3. **Routes + gating** — kind-aware create/update (PUT inherits the kind, a switch is 409),
   `POST /automations/:id/run`, kind-aware `check`/`retry`, `GET /automations` with `timeZone`,
   `stats` and per-row `nextRunAt`/`lastRun`/`runs7d`/`costUsd7d` (`stats.ts`, derived), the
   log's `runs` map with dispatch children, `GET /workspace/automation-templates`
   (`templates.ts`), `capabilities.automations = CEZ_AUTOMATIONS !== '0'` with the boot
   re-baseline of idle polls (`rebaselineIdleAutomations`). README, `.env.example`, AGENTS.md
   and BACKWARD_COMPATIBILITY.md carry the break.
4. **List, rail, calendars** — `routes/automations/{automations-list,stats-strip,
   automations-table,row-actions,next-runs-rail,calendar-parts,week-view,day-view}.tsx` over one
   query (`use-automations.ts`) invalidated by `automation-change`.
5. **Editor** — `editor.tsx` + `editor-draft.ts`, schedule/GitHub fields, run-as row (composer
   pills), dispatch row, template palette (built-in + other projects), next-runs preview, Copy as
   CLI (`lib/automation-cli.ts`), last-run card.
6. **Log** — `log.tsx` with nested dispatch children and kind-aware retry.
7. **From-prompt patch** — applied from `.ai/specs/assets/automations-redesign/patch/` with a
   3-way merge (README and `.env.example` conflicted on the flag wording); the schema reference,
   the always-on prompt part and the skill playbook learned both kinds; `cez automation add`
   (flag sugar, exit 2 for a flag it cannot express) and `cez automation run` were added.
8. **Verification** — the gate (`typecheck`, `test`, `test:unit`, `build`, `test:package`),
   the e2e journeys and the design-fidelity screenshots; see the PR.

## Review trail

The spec went through an independent architectural review before implementation (see the
spec's git history). Four findings changed the design before a line was written: scheduled
automations would never have fired in a repo without a GitHub remote; loosening the run
record's `githubUrl` would have made a downgrade drop the whole runs index; a laptop asleep for
days would have fired one launch per missed occurrence; and two cockpits on one project would
have clobbered each other's state file.

## Not done

New GitHub events, a repo-committed definition format, per-run budgets outside dispatch, a
`reviewChild` field on the dispatch intent, full cron expressions, automations while the server
is stopped — all deliberate (spec § Not done).
