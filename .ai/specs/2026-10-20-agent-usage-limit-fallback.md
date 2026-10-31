# Automatic agent fallback after a usage limit

## Purpose and scope

Automatic fallback continues an existing task with an ordered, user-selected agent/account
when its current agent exhausts its usage allowance. It is off by default and configured per
project in **Settings → Agents → Automatic fallback** on a local cockpit.

Fallback retains the task ID, checkout, branch, files, transcript and remaining task budget.
It uses an ordinary continuation; it does not create a child task or perform an additional
fallback-specific commit, merge or push. Existing autosave and checkout lifecycle rules apply,
including tasks running in place rather than in an isolated worktree.

Supported execution is **Quick task and sequential step-list workflows whose last step is an
agent step**, including subsequent continuations of those tasks. In a multi-step workflow,
fallback applies only while that last step is running. Workflow graphs, check steps and earlier workflow steps
do not transfer to another agent. They retain ordinary reset-time auto-resume where eligible.
Setup and worktree lifecycle failures do not initiate fallback.

## Configuration and consent

A list contains at most ten unique provider/account pairs. A candidate names a provider,
`profileId` (`default` means its discovered login), and an optional model. Another model on the
same account is not another candidate. Different accounts of the same provider can be listed.

Each edit saves immediately. Adding a candidate does not enable fallback: the header switch
must be turned on, and cannot be enabled with an empty list. Removing the last candidate turns
it off. The list supports reordering by its drag handles or arrow buttons, and removal; changing a candidate's model means removing
and adding it again. Row actions have accessible names, reordering preserves the keyed row,
and a successful move is announced through a polite live region. Drag handles support pointer input
and Space/arrow keys/Space, with Escape to cancel. Dropping in a new position saves once;
cancelling or dropping in place does not save. A drag begun before a policy revision change
is ignored to avoid overwriting a newer order.

The visible disclosure states that the next provider receives the task and repository context
and may charge its own plan. Task budgets still apply, but tool permissions depend on the
successor backend; a transfer does not guarantee equivalent enforcement of Claude's tool rules.
Fallback does not add a cost cap to a task that has none.

An explicit model travels with the candidate. Auto clears the previous agent's model pin and
lets the successor use its native model choice; it does not select the project's composer model
preset. With model selection locked, new rows use native settings. An existing pinned row is
marked for replacement and cannot be admitted with its explicit model while the lock applies.

### Settings states

| State | Behavior |
|---|---|
| Loading | Loading message; no policy controls until the GET succeeds. |
| Hosted cockpit | Local-only explanation; no editing controls. |
| Load error, missing project folder or older server without the endpoint | Error message and Retry; other agent settings remain available. |
| Empty list | Switch disabled and off; prompt to add the first successor. |
| Saved list, off | Explicitly says the list is saved but not used. |
| Enabled | Numbered order, account/model labels and move/remove actions. |
| Unavailable row | Removed account, disabled provider or disconnected provider warning; the row can still be removed and fallback switched off. |
| Project default account listed | Explains that tasks starting on it skip it. Runtime eligibility uses the task's actual failed account. |
| Ten candidates | Add disabled; existing rows remain editable. |
| Save conflict | Reload the policy; show an error so the user can retry against its new revision. |

Connection warnings reflect currently available provider status; runtime admission performs
its own checks. Failed saves retain the add selection. The context/charging disclosure stays
visible; execution scope and permissions are in an expandable section.

## Policy lifetime

New tasks capture the policy only when it is enabled. A task without a snapshot never acquires
fallback merely because the setting is enabled later. List or model edits apply to new tasks;
existing tasks retain their snapshot.

Admission requires the live policy to be enabled with matching incarnation and revocation tokens.
Switching off withdraws consent for unstarted handovers. Switching on again creates a new
incarnation and does not revive old snapshots. Missing or unreadable policy storage denies
admission. An already running successor is not interrupted by changing this setting.

A human Continue resets the attempted-candidate episode, but does not refresh the policy snapshot
or clear account holds. Automatic continuations preserve the episode. The successful successor
becomes the task's current agent/account; project defaults do not change.

## Detection and candidate selection

`isUsageExhaustion` classifies terminal agent errors using known text patterns, not a provider
quota API. It accepts Claude's usage-limit envelope, explicit billing quota exhaustion
(`insufficient_quota`, “exceeded your current quota”), and recognized usage/session/hourly/
weekly/monthly/daily limit or exhausted-credit wording. Explicit billing exhaustion can arrive
with HTTP 429; generic 429, per-minute throttles and rate-limit wording do not initiate transfer.
An exhaustion does not need a parseable reset timestamp to trigger fallback.

Once a failure qualifies:

1. Identify the failed step's provider and account and record it as attempted.
2. Publish the task as queued with `fallbackEpisode.pending`, release the previous agent's
   leases and choose candidates from the saved order.
3. Skip attempted pairs, accounts on hold, missing named accounts and disabled providers.
   The cockpit also supplies its provider/account connection gate; the headless manager does
   not have that server gate. Skip reasons are recorded in the transcript.
4. Persist the attempted candidate before reserving its `continue-*` step, then use the normal
   queue and capacity controls. Recheck consent and account/provider availability during launch
   preparation. Recheck consent, cancellation, disposal and active-state ownership after the
   final preparation await, before starting the provider.
5. If a reserved successor fails before any assistant text or tool event is recorded, treat it
   as a failed start and try the next candidate. A session ID assigned before spawn is not proof
   of work. Once output exists, an ordinary error is not grounds for another fallback; a new
   qualifying usage exhaustion is.

Each configured pair is considered at most once in an unattended episode, including candidates
skipped as unavailable. A task cannot return to the account that just exhausted its allowance.
When no candidate can continue, the task is failed, the episode is finished, and a danger-toned
transcript summary names the exhausted/unavailable list and known reset times. It waits for
manual action rather than cycling or scheduling reset-time auto-resume for that episode.
Ordinary Continue retains its existing session requirements; only the internal fallback path
can open a continuation when no prior agent session exists.

## Context and task history

Changing provider or account opens a fresh session. The portable context contains the original
task, recorded error, branch/checkout path, step statuses, and persisted user/assistant messages
(up to 60,000 conversation characters, retaining the recent end). It does not copy tool inputs,
tool results or reasoning. The successor is instructed to read `CEZ_HANDOFF_FILE`, inspect git
status/history and continue existing work. An exhausted predecessor is not guaranteed to have
written a final handoff update.

The failed step remains in history with its provider/account. Candidate reservation records one
informational handover line with the previous and next account labels. This line announces the
handover; launch can still be refused during subsequent preparation. The synthetic instruction
is labelled as an automatic cezar message in the thread.

While candidate selection is pending, the task's attention label is “switching agent” and it
produces no failure notification. A terminal admission failure is reported as a failure. For a
dispatched child, reporting to its parent is deferred until transfer or terminal settlement is
resolved.

## Recovery and account holds

Pending selection survives restart and is resumed without replaying completed workflow steps.
A reserved continuation without a session is requeued as a fresh continuation. Cancellation
stops selection. Manager disposal leaves durable pending state for recovery and prevents its
outstanding preparation from launching a new provider. A revoked pending or queued handover
stops with an explanation and requires manual continuation. A later ordinary usage failure on
a task whose snapshot has been revoked follows the existing auto-resume rules.

A fallback exhaustion creates an account hold **only when a reset time can be parsed**. Such
holds participate in the shared queue's account constraints and survive task completion,
archiving, deletion and server restart. Expiry timers wake the queue; ordinary task holds and
capacity limits still apply. Manual Continue does not remove a fallback hold early.

## Persistence and API

All paths use `cezarHomeDir()` and honor `CEZ_HOME`; no new environment variable is required.

- `agent-fallback.json` stores per-project policies keyed by the canonical repository path.
  Missing/unreadable storage defaults to disabled; invalid entries are salvaged independently.
  Atomic writes use mode 0600, a cross-process lock and revision/incarnation compare-and-swap.
  Lock acquisition pins the read/write path for the transaction. Unknown stored fields survive
  unrelated edits and retained candidate identities, but are not exposed by the API.
- `agent-usage-holds/<sha256>.json` stores immutable `{account, until}` entries, keyed by a hash of
  both values. Independent writers cannot overwrite a later deadline with an earlier one.
  Reads validate entries and prune expired holds. An unwritable home retains holds in memory
  with one warning per manager. Existing active run-record holds are copied on manager startup.
- Optional run fields are `fallbackPolicy`, `fallbackEpisode` (`attempted`, optional `pending`,
  `current: {key, stepId}`, `done`) and `usageLimitHolds`. They require no run migration and are
  absent on the default, unconfigured path.

The workspace route is `/api/v1/workspace/agent-profiles/fallback-policy`, selecting a project
through `projectId` rather than a project-prefixed route:

| Method | Input | Success |
|---|---|---|
| GET | Query `{projectId}` | `{enabled, candidates, revision, incarnation, revocation}` |
| PUT | `{projectId, expectedRevision, expectedIncarnation, enabled, candidates}` | The saved policy in the same shape. |

Each candidate is `{provider, profileId, model?}`. Invalid input or a newly added missing named
account returns 400. Unknown project returns 404. Hosted mode, missing/non-directory project
root, stale revision/incarnation or lock contention returns 409. Unexpected write failure returns
500 with a fixed error message. Existing removed-account rows do not prevent disabling or removal.
Request and response schemas live in `packages/contract/src/agent-profiles.ts`.

## Verification surfaces

Server test paths below are relative to `packages/cezar/src/`; web paths to `packages/`.

- `workflows/agent-fallback-run.test.ts`: real-engine dry-run handover, default-off/scope guards,
  candidate exhaustion and failures, account identity, recovery, revocation, disposal and hold expiry.
- `workspace/agent-fallback.test.ts`: classification, list validation, consent, serialization,
  unknown-field preservation, canonical paths and pinned transaction location.
- `workspace/agent-usage-holds.test.ts`: independent writers, expiry and persistence.
- `server/agent-profiles-api.test.ts`: policy HTTP behavior, conflicts and unavailable projects.
- `web/src/routes/settings/agents-fallback.test.tsx`: settings interactions and error states.
- Attention/notification, contract parity, route inventory and existing continuation/auto-resume
  suites cover integration boundaries.

These tests use the dry-run provider. They do not establish real paid-provider behavior on every
platform or replace CodeQL and CI checks on the submitted branch.
