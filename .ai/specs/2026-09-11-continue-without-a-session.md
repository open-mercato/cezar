# Continue a task that has no session to resume

> Depends on: spec 003 (Continue), `2026-07-29-agent-profiles.md` (why a session id belongs to one account)
>
> Builds on #954 (`workflows/continuation-context.ts`), which introduced the fresh-session hand-off for a runner/account switch. This spec makes the SAME hand-off the answer for a run that never recorded a session at all, rather than adding a second one beside it.

## TLDR

Continue used to require a recorded agent session id. A task that crashed before its backend minted one — the common shape being a cezar restart while the run queued for the repository working tree — had no session, so recovery gave up (`could not resume the interrupted task (no agent session to resume)`), the composer went read-only (`Session closed — no session to resume.`), and the only remaining action on work that was genuinely in flight was Delete.

Continue now covers that case by opening a **new** session briefed with `freshContinuationContext` — the hand-off #954 already builds when a runner/account switch strands the session id: the original task, the run's state and error, and a bounded replay of the conversation. Resuming is still preferred and still happens byte-for-byte as before whenever there is something to resume.

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
| Q2 | Build a second briefing, or reuse #954's? | Reuse `freshContinuationContext`. | It answers the identical question — *what does a session that cannot resume need to know?* — and it answers it better than a parallel implementation would have: it prefers the normalized v2 message stream, strips `CEZ:` markers (a replayed `CEZ:DONE` would close the very session it was handed to), and carries branch/worktree/step state. Two builders with two budgets and two marker policies is the drift this repo keeps warning about. |
| Q3 | Does it need widening for this case? | No — only a test for the empty conversation. | #954 only ever faced runs with a conversation. A crash before the first spawn has none, and the builder already degrades to `(No persisted conversation messages.)`; what it lacked was a case pinning that, plus the marker-stripping and exclusion rules it implements but never asserted. |
| Q4 | Does the replay become the user's message? | No — delivery-only, prepended to the opening prompt. | The thread already renders every line it replays, directly above. Persisting it would duplicate the transcript inside itself and make the user appear to have typed a summary they never wrote. |
| Q5 | Does Terminal ("Open in CLI") relax the same way? | No — it still requires a session id. | It splices the id into `claude --resume <id>` for a real shell. There is nothing to substitute. |
| Q6 | Does the runner/account switch path get the briefing too? | Yes. | It has always opened a fresh session (a session id only resolves inside the config dir that created it) and has always lost the conversation doing so. One rule — *a new session gets briefed* — covers both reasons, so neither can drift. |

## Architecture

**`packages/cezar/src/workflows/continuation-context.ts`** — unchanged, reused. Its `freshContinuationContext(run, events)` is already wired into `runContinuation` behind exactly this condition (`sessionId === undefined`), so relaxing `continueRun` is all it takes for the crash-before-spawn case to reach it. New cases pin the behaviour this spec now depends on: the empty conversation, `CEZ:` marker stripping, conversation-only replay, and the named truncation.

**`RunManager.continueRun`** drops the refusal. `resume ? sessionStep.sessionId : undefined` becomes one `resumeSessionId` whose `undefined` means "open a new session" for either reason — nothing recorded, or an id this runner/account cannot resolve.

**`RunManager.runContinuation`** already built the briefing at that point; this adds the `note` event so the thread says the session is fresh. Worded for both reasons a continuation lands there — nothing recorded, or a switch — because the note cannot tell them apart and neither changes what the user is being told.

**`RunManager.recover`** needs nothing: #972 added a branch above the continuation that re-queues a `running` run which never reached an agent, which is a better exit than continuing a task that had done nothing yet. The line the user reported is gone either way.

**`reviveQueuedRun`** adopts a pending `continue-N` step whether or not a session precedes it, instead of falling back to re-running the workflow.

**Cockpit.** `runActionFlags.continueRun` is `!active` (`terminal` keeps `!active && hasSession`). The Continue tooltip and the composer placeholder distinguish the two promises — `Reopen the session` versus `Start a new session — the previous conversation is replayed to the agent` — because "pick up where you left off" is the stronger claim and only one of the two paths can make it. `askDeliveryMode`'s `unavailable` mode and the `no-session` blocked reason are removed: every closed run can take an answer now, so the ask card has no inert state left to render.

## What does NOT change

- A run with a resumable session resumes it, with the same `--resume` argument and no briefing — it is already inside that conversation, and handing it a summary of itself would be noise. Pinned by a guard test that passes both with and without this change.
- `POST /api/v1/runs/:id/open-in-cli` still answers `409 no agent session to resume`.
- `POST /api/v1/runs/:id/continue` is unchanged in shape. It accepts a case it used to reject, which is a widening; its other 409s (`run is still active`, `cannot continue a <status> run`) are untouched.
- The usage-limit auto-resume (`scheduleAutoResumeIfLimited`) keeps its own independent `run.steps.some(step => step.sessionId)` gate — an UNATTENDED resume still requires a real session.

## Testing

- `packages/cezar/src/workflows/continuation-context.test.ts` — the cases the builder needed before this spec could lean on it: the empty conversation, `CEZ:` marker stripping, conversation-only replay, named truncation.
- `packages/cezar/src/workflows/continue-without-session.test.ts` — end to end through the engine under `CEZ_DRY_RUN=1`: the briefing reaches the agent, no `--resume` reaches the CLI, the transcript persists the user's prompt alone, `recover()` finds a way forward instead of giving up, and the guard case above.

The engine cases were confirmed red with `workflows/run.ts` stashed; the guard case passes both ways, which is what it is for.
