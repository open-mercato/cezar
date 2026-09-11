# Continue a task that has no session to resume

> Depends on: spec 003 (Continue), `2026-07-29-agent-profiles.md` (why a session id belongs to one account)

## TLDR

Continue used to require a recorded agent session id. A task that crashed before its backend minted one — the common shape being a cezar restart while the run queued for the repository working tree — had no session, so recovery gave up (`could not resume the interrupted task (no agent session to resume)`), the composer went read-only (`Session closed — no session to resume.`), and the only remaining action on work that was genuinely in flight was Delete.

Continue now covers that case by opening a **new** session briefed with the old one's transcript: the original task, how the previous attempt ended, and a bounded replay of the conversation. Resuming is still preferred and still happens byte-for-byte as before whenever there is something to resume.

## Problem Statement

Reported from the thread of a real run:

```
· run started — workflow "quick-task" (runner: claude)
· worktree off — running in the repo working tree
· waiting for exclusive access to the repository working tree
· cezar restarted — could not resume the interrupted task (no agent session to resume)

Session failed — interrupted — cezar process exited during the run
```

with the composer underneath reading `Session closed — no session to resume.`

Nothing about the task was broken. The worktree, the branch, the handoff file and the user's prompt were all intact; the run simply died in the window between "accepted" and "spawned", which is precisely where a session id does not exist yet. Three surfaces then agreed the task was over:

- `RunManager.continueRun` refused with `no agent session to resume` (`workflows/run.ts`);
- `runActionFlags.continueRun` was `!active && hasSession`, so the header offered no button;
- the composer's `disabledReason` said the session was closed.

`reviveQueuedRun` had a fourth version of the same rule: a queued `continue-N` step with no session before it fell through to reviving the WORKFLOW, re-running the task from step one against a worktree that already held its results.

## Resolved assumptions (autonomous defaults)

| # | Question | Applied default | Why |
|---|----------|-----------------|-----|
| Q1 | Resume, or start fresh and replay? | Resume when possible; replay only when it is not. | A real resume carries the whole context window, tool results included. A replay is a summary by comparison, so it is the fallback, never the preference. |
| Q2 | What goes into the replay? | The original task, the run's `error`, and the `user-message` / `text` events — not lifecycle lines, tool calls or the v2 `item.*` stream. | It is a briefing, not a log. Tool traffic is the bulk of an NDJSON file and the least useful part of it to a fresh agent, which can re-run anything it needs. |
| Q3 | How much of it? | 12 000 chars total, 2 000 per message, oldest dropped first with the count named. | The end of a conversation is where the unfinished work is; the beginning is what the task text already restates. An unbounded replay could fill a context window with history before the agent read its instruction. |
| Q4 | Does the replay become the user's message? | No — delivery-only, prepended to the opening prompt. | The thread already renders every line it replays, directly above. Persisting it would duplicate the transcript inside itself and make the user appear to have typed a summary they never wrote. |
| Q5 | Does Terminal ("Open in CLI") relax the same way? | No — it still requires a session id. | It splices the id into `claude --resume <id>` for a real shell. There is nothing to substitute. |
| Q6 | Does the runner/account switch path get the briefing too? | Yes. | It has always opened a fresh session (a session id only resolves inside the config dir that created it) and has always lost the conversation doing so. One rule — *a new session gets briefed* — covers both reasons, so neither can drift. |

## Architecture

**`packages/cezar/src/runs/session-recap.ts`** (new). `buildSessionRecap({task, error, events}, limits?) → string`. Pure, store-free, separately testable. Coalesces consecutive same-speaker events back into turns (the engine appends one `text` event per streamed chunk), clips per message, then drops from the front until under budget and says how many it dropped. Always returns text: a run that produced no conversation still has a task, and that is the case this exists for.

**`RunManager.continueRun`** drops the refusal. `resume ? sessionStep.sessionId : undefined` becomes one `resumeSessionId` whose `undefined` means "open a new session" for either reason — nothing recorded, or an id this runner/account cannot resolve.

**`RunManager.runContinuation`** builds the briefing when `sessionId === undefined`, *before* it appends this continuation's own `user-message` (so the replay cannot contain the prompt it is being prepended to), appends a `note` event saying the session is fresh, and prepends the briefing to the delivered opening prompt behind a `---` rule.

**`RunManager.recover`** keeps its lifecycle line honest: `resuming the interrupted task from its last session` when there was one, `no session to resume; continuing the interrupted task in a fresh session` when there was not.

**`reviveQueuedRun`** adopts a pending `continue-N` step whether or not a session precedes it, instead of falling back to re-running the workflow.

**Cockpit.** `runActionFlags.continueRun` is `!active` (`terminal` keeps `!active && hasSession`). The Continue tooltip and the composer placeholder distinguish the two promises — `Reopen the session` versus `Start a new session — the previous conversation is replayed to the agent` — because "pick up where you left off" is the stronger claim and only one of the two paths can make it. `askDeliveryMode`'s `unavailable` mode and the `no-session` blocked reason are removed: every closed run can take an answer now, so the ask card has no inert state left to render.

## What does NOT change

- A run with a resumable session resumes it, with the same `--resume` argument and no briefing — it is already inside that conversation, and handing it a summary of itself would be noise. Pinned by a guard test that passes both with and without this change.
- `POST /api/v1/runs/:id/open-in-cli` still answers `409 no agent session to resume`.
- `POST /api/v1/runs/:id/continue` is unchanged in shape. It accepts a case it used to reject, which is a widening; its other 409s (`run is still active`, `cannot continue a <status> run`) are untouched.
- The usage-limit auto-resume (`scheduleAutoResumeIfLimited`) keeps its own independent `run.steps.some(step => step.sessionId)` gate — an UNATTENDED resume still requires a real session.

## Testing

- `packages/cezar/src/runs/session-recap.test.ts` — the builder: ordering, coalescing, what is excluded, clipping, the drop-oldest budget, the empty-conversation case.
- `packages/cezar/src/workflows/continue-without-session.test.ts` — end to end through the engine under `CEZ_DRY_RUN=1`: the briefing reaches the agent, no `--resume` reaches the CLI, the transcript persists the user's prompt alone, `recover()` continues instead of giving up, and the guard case above.

Three of those four engine cases were confirmed red with `workflows/run.ts` stashed; the guard case passes both ways, which is what it is for.
