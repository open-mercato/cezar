import { MessageSquareTextIcon, SearchXIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useLocation, useParams } from 'react-router'

import { Link } from '@/lib/project-router'

import { ApiError } from '@/api/client'
import {
  useEditQueuedMessage,
  usePatchRun,
  useRemoveQueuedMessage,
  useRun,
  useProjectRepoBase,
  useRuns,
  useSendMessage,
} from '@/api/queries'
import { useRunEvents } from '@/api/run-events'
import type { ApiRun } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { Composer } from '@/components/composer/composer'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { useKeyboardInsetVar } from '@/lib/keyboard-inset'
import { taskIssueUrl, taskPrUrl } from '@/lib/tasks-table'
import { cn, isHttpUrl } from '@/lib/utils'

import {
  AssistantMessage,
  ContextGroup,
  ImageItem,
  NoteLine,
  ProviderAuthRequiredCard,
  ReasoningItem,
  ToolCard,
  ToolStreak,
  UserBubble,
  WorkingIndicator,
} from './thread-items'
import { useContinueAction } from './follow-up-engine'
import { AgentsDock } from './agents-dock'
import { PlanDock, planCounts } from './plan-dock'
import { collectSubagents, findSubagent, subagentChildren } from './subagent-dock'
import { SubagentSheet } from './subagent-sheet'
import { AcceptCelebration, ReviewPanel } from './review-panel'
import { queuePosition } from './run-actions'
import { RunHeader } from './run-header'
import { AskCard } from './ask-card'
import { useRunRecordReconcile } from './run-reconcile'
import { useActiveProviderAvailability } from './active-provider'
import { groupThreadItems, type ThreadBlock } from './thread-groups'
import { ThreadLoading } from './thread-loading'
import { ThreadCardCache } from './thread-open-cards'
import { threadRenderMode } from './thread-scroll'
import { JumpToLatestPill, ThreadRows, useThreadScroll, type ThreadRow } from './thread-scroller'
import {
  latestPlanEntries,
  reduceThread,
  threadFilePaths,
  threadFooter,
  type ThreadEntry,
  type ThreadState,
} from './thread-state'

/**
 * `/tasks/:id` — the Session tab (spec, "Task thread"): the run header (title/meta/tabs/
 * actions — see run-header.tsx), turns with user bubbles, assistant markdown, tool cards,
 * dim lifecycle lines, the closed footer, and the docked composer (plan dock · paused hint ·
 * reply box).
 *
 * Data doctrine: `useRun` (fetch) is authoritative for the record — status, title, error;
 * `useRunEvents` (SSE replay + live) is the transcript. The reducer folds the full event list
 * on each change; the rendered rows go through the threshold-switched scroller
 * (thread-scroller.tsx — flat + content-visibility below ~300 rows, virtua above).
 */
export function TaskThreadRoute() {
  const { id } = useParams<{ id: string }>()
  const run = useRun(id)
  const events = useRunEvents(id)
  const thread = useMemo(() => reduceThread(events), [events])
  // The two feeds can drift: a record update lost on the workspace stream leaves the thread
  // showing Working… over a "run finished" transcript. The transcript is live here, so it
  // arbitrates — a session end with no session after it refetches a record still claiming one.
  useRunRecordReconcile(run.data, events)

  if (run.isPending) return <ThreadLoading />

  if (run.isError) {
    const notFound = run.error instanceof ApiError && run.error.status === 404
    return (
      <div data-route="task-thread" className="flex min-h-full flex-col">
        <CenteredState
          icon={notFound ? <SearchXIcon /> : <MessageSquareTextIcon />}
          tone={notFound ? 'neutral' : 'danger'}
          title={notFound ? 'Task not found' : 'Could not load this task'}
          subtitle={
            notFound
              ? 'No run has this id. It may have been deleted, or the link is from another machine.'
              : run.error.message
          }
          actions={
            <Button asChild variant="outline">
              <Link to="/">Back to tasks</Link>
            </Button>
          }
        />
      </div>
    )
  }

  return <ThreadView run={run.data} thread={thread} />
}

/**
 * The run's task + every turn, flattened to keyed rows for the threshold-switched scroller
 * (thread-scroll.ts owns the rule). Row keys are turn-scoped — the same keys the open-card
 * cache uses, because v2 item ids repeat across sessions.
 */
export function buildThreadRows(
  run: ApiRun,
  thread: ThreadState,
  /** Queued-run affordances (#472). Omitted (the default) renders every bubble read-only,
   *  which is what every caller outside the live thread view wants. */
  edit?: {
    onEditTask: (text: string) => Promise<void>
    onEditMessage: (msgId: string, text: string) => Promise<void>
    onRemoveMessage: (msgId: string) => Promise<void>
  },
): ThreadRow[] {
  const rows: ThreadRow[] = []
  // The initial prompt: the engine writes no v1 `user-message` line for it — the task on
  // the run record IS that message, so it renders from there, not from an invented event.
  if (run.task)
    rows.push({
      key: 'task',
      node: (
        <UserBubble
          text={run.task}
          images={run.taskImages ?? []}
          // Editable but never removable: a run with no prompt is not a run.
          onEdit={edit ? edit.onEditTask : undefined}
          editLabel="Edit the prompt"
        />
      ),
    })
  // Messages stacked onto the run while it waits for a slot (#472). Same provenance as the
  // task bubble — they live on the record, not in the event stream, and the engine writes no
  // `user-message` line for them (they are folded into the prompt, not sent as turns). So
  // rendering them here is what keeps the thread showing exactly one bubble per authored
  // message, before the run starts and after.
  for (const message of run.queuedMessages ?? []) {
    rows.push({
      key: `queued:${message.id}`,
      node: (
        <UserBubble
          text={message.text}
          images={message.images ?? []}
          onEdit={edit ? (text) => edit.onEditMessage(message.id, text) : undefined}
          onRemove={edit ? () => edit.onRemoveMessage(message.id) : undefined}
        />
      ),
    })
  }
  for (const turn of thread.turns) {
    if (turn.userMessage) {
      rows.push({
        key: `${turn.id}:user`,
        node: (
          <UserBubble
            text={turn.userMessage.text}
            imageCount={turn.userMessage.imageCount}
            images={turn.userMessage.images}
          />
        ),
      })
    }
    for (const block of groupThreadItems(turn.items)) {
      rows.push({
        key: `${turn.id}:${block.id}`,
        node: <ThreadBlockView block={block} scope={turn.id} run={run} />,
      })
    }
  }
  return rows
}

/** The loaded thread. The header owns its own data hooks (mutations, the runs list); the
 *  thread body stays presentational — tests drive it with reduced fixture states directly. */
export function ThreadView({ run, thread }: { run: ApiRun; thread: ThreadState }) {
  const footer = threadFooter(run.status, run.error)
  // The dock's data: the latest plan snapshot across turns (full replacement — an emptied
  // plan hides the dock and the header mirror alike).
  const plan = latestPlanEntries(thread)
  const planTally = plan !== undefined && plan.length > 0 ? planCounts(plan) : undefined
  // The Agents dock's data: the current fan-out's sub-agents, or [] when there is none to
  // show (#474). Derived from the same reduced turns the thread renders — no new subscription.
  // The legacy session-open rule (web/app.js `updateDetail`): the composer can deliver while
  // the engine owns a live session — running queues the message, waiting answers it.
  const sessionOpen = run.status === 'running' || run.status === 'waiting'
  // …and the third state (#472): a queued run has not started, so its prompt is still
  // authorable. "Session closed — Continue to reopen." was wrong on its own terms here —
  // the session is not closed, it was never opened, and Continue means nothing for a run
  // that has not run. Deliberately `queued` only: review/done/failed/cancelled keep the
  // existing copy and their Continue action.
  const queued = run.status === 'queued'
  // …and the fourth: a closed run whose last session can be reopened. Continue used to be a
  // bare button beside a DISABLED textarea, so "reopen it and say what to do next" meant
  // continuing blind and then typing into the thread once the session came back. The composer
  // stays authorable here instead: the draft is the prompt the reopened session starts on, and
  // submitting an empty one is still the plain one-click Continue.
  const continueAction = useContinueAction(run)
  const hasContinuation = !sessionOpen && !queued && continueAction.available
  const continuable = hasContinuation && continueAction.canContinue
  // A closed session can never settle its in-flight items — nothing in the reducer rewrites a
  // `running` item on `session.ended`, so an interrupted fan-out stays `running` in the
  // persisted stream forever. Without this, reopening it pulses `Agents · 0/1` above a dead
  // transcript for good.
  //
  // Derived from `sessionOpen` rather than enumerated, so it cannot drift when a status is
  // added: anything that is neither live nor still queued is closed. `review` matters most —
  // it is where this pipeline's runs normally END, and `threadFooter` already calls it closed.
  const runIsTerminal = !sessionOpen && run.status !== 'queued'
  const agents = useMemo(() => collectSubagents(thread.turns, runIsTerminal), [thread.turns, runIsTerminal])
  // The drill-down's whole state: which agent is open. Ephemeral by design (spec Q2/Q5) —
  // sub-agents have no stable identity outside their run, so there is nothing to persist.
  const [openAgentId, setOpenAgentId] = useState<string | undefined>(undefined)
  // Item ids repeat across runs (codex mints `item_1`, `item_rv_1` per session), so a
  // selection carried across a route change could pop the sheet open on an unrelated item.
  const [selectionRunId, setSelectionRunId] = useState(run.id)
  if (selectionRunId !== run.id) {
    setSelectionRunId(run.id)
    setOpenAgentId(undefined)
  }
  // Resolved from the turns, NOT from `agents`: the dock can yield to the transcript (Q6)
  // while a sheet is open, and that must not slam the panel shut mid-read.
  const openAgent = useMemo(
    () => (openAgentId === undefined ? undefined : findSubagent(thread.turns, openAgentId, runIsTerminal)),
    [thread.turns, openAgentId, runIsTerminal],
  )
  const openAgentChildren = useMemo(
    () => (openAgentId === undefined ? [] : subagentChildren(thread.turns, openAgentId)),
    [thread.turns, openAgentId],
  )
  const sendMessage = useSendMessage(run.id)
  const activeProvider = useActiveProviderAvailability(run)
  // A queued send only amends the persisted prompt; it invokes no provider and therefore
  // remains available even when provider discovery cannot authorize a live session. Once the
  // session is open, mirror the server's active-backend gate as before.
  const activeProviderBlocked = sessionOpen && !activeProvider.usable
  const continuationProviderBlocked = hasContinuation && !continueAction.canContinue
  const providerBlocked = activeProviderBlocked || continuationProviderBlocked
  const providerReason = activeProviderBlocked ? activeProvider.reason : continueAction.reason

  // The queued-run affordances (#472), passed only while the run is queued — so the bubbles
  // go read-only on the next `run` SSE frame once it starts. The bubbles await these promises
  // so a failed write keeps its editor/draft open and shows the server's error.
  // Depend on the `mutateAsync` functions, NOT the mutation result objects: TanStack returns a
  // fresh result object every render, so memoizing on those would rebuild `edit` — and with it
  // every thread row — on each render, defeating the memo that exists because these threads get
  // big enough to virtualize. `mutateAsync` is referentially stable.
  const { mutateAsync: patchRunAsync } = usePatchRun(run.id)
  const { mutateAsync: editQueuedAsync } = useEditQueuedMessage(run.id)
  const { mutateAsync: removeQueuedAsync } = useRemoveQueuedMessage(run.id)
  const edit = useMemo(
    () =>
      queued ?
        {
          onEditTask: async (text: string) => { await patchRunAsync({ task: text }) },
          onEditMessage: (msgId: string, text: string) =>
            editQueuedAsync({ msgId, message: { text } }).then(() => undefined),
          onRemoveMessage: (msgId: string) => removeQueuedAsync(msgId).then(() => undefined),
        }
      : undefined,
    [queued, patchRunAsync, editQueuedAsync, removeQueuedAsync],
  )

  const rows = useMemo(() => buildThreadRows(run, thread, edit), [run, thread, edit])
  // #526: the footer's issue link may be synthesized from the CEZ:ISSUE marker, and the only
  // repository it may ever name is the one on screen — never the transcript's.
  const issueUrl = taskIssueUrl(run, useProjectRepoBase())
  const { search } = useLocation()
  const mode = threadRenderMode(search, rows.length)
  const scroll = useThreadScroll(run.id)
  // The iOS keyboard lifts the dock via `--kb`; once it settles, a pinned reader re-pins
  // (research §7: re-run scrollToEnd after the viewport settles).
  useKeyboardInsetVar(scroll.restickIfStuck)

  return (
    <div data-route="task-thread" className="flex min-h-full flex-col">
      <RunHeader run={run} planTally={planTally} />

      {/* Row spacing lives on each thread row (pb-2.5, both render modes measure alike);
          this gap only separates the sections — rows, empty state, footer, review panel. */}
      <div className="mx-auto flex w-full max-w-[var(--measure)] flex-1 flex-col gap-3.5 px-4 py-5 md:px-6">
        <ThreadCardCache runId={run.id}>
          <ThreadRows runId={run.id} rows={rows} mode={mode} controls={scroll} />
        </ThreadCardCache>

        {thread.turns.length === 0 ? (
          run.status === 'queued' ? (
            <QueuedPlaceholder run={run} />
          ) : (
            <p data-slot="thread-empty" className="py-6 text-center text-xs text-soft-foreground">
              No session events yet.
            </p>
          )
        ) : null}

        {/* Live session heartbeat: while the engine owns the turn (`running`), a spinner tails
            the thread so quiet gaps between bursts don't read as "finished". `waiting` hands
            off to the dock's reply hint, `queued` to the placeholder above — so `running` only. */}
        {run.status === 'running' ? <WorkingIndicator /> : null}

        {/* Closed states read as the body's last line; the WAITING state lives in the dock
            (mockup `.paused-hint`), right above the composer it is asking the user to use. */}
        {footer && footer.state === 'closed' ? (
          <div
            data-slot="thread-footer"
            data-state={footer.state}
            className={cn(
              'mt-auto flex items-center gap-2 border-t border-border pt-3 text-xs',
              footer.tone === 'danger' ? 'text-danger' : 'text-soft-foreground',
            )}
          >
            {footer.label}
            {/* href protocol guard (#431): link only for http(s) URLs. */}
            {isHttpUrl(taskPrUrl(run)) ? (
              // The run shipped as a PR (review-gate Draft PR, or agent-opened), or worked on
              // one (#407) — the link stays reachable after the panel is gone.
              <a
                data-slot="pr-link"
                href={taskPrUrl(run)}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-foreground underline-offset-2 hover:underline"
              >
                PR ↗
              </a>
            ) : null}
            {/* #526: an issue-subject run (om-prepare-issue) links the issue it created — it
                declares no PR, so without this the created issue was unreachable from the UI. */}
            {isHttpUrl(issueUrl) ? (
              <a
                data-slot="issue-link"
                href={issueUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-foreground underline-offset-2 hover:underline"
              >
                Issue ↗
              </a>
            ) : null}
          </div>
        ) : null}

        {/* The review gate (spec 009): a finished run with changes parks here — nothing
            auto-merges. The panel exists exactly while the run rests at `review`. */}
        {run.status === 'review' ? <ReviewPanel run={run} /> : null}
      </div>

      <AcceptCelebration status={run.status} />

      {/* The drill-down for whichever Agents-dock row was clicked. Rendered outside the dock
          so the sheet's portal is not affected by the dock's collapse state — but inside its
          own card cache (module-level and run-keyed, so this is the SAME store the thread
          uses), or tool cards expanded in the sheet would forget that on reopen. */}
      <ThreadCardCache runId={run.id}>
        <SubagentSheet
          agent={openAgent}
          entries={openAgentChildren}
          onClose={() => setOpenAgentId(undefined)}
        />
      </ThreadCardCache>

      {/* The dock region (mockup `.dock`): plan dock, paused hint, then the composer.
          `bottom: var(--kb)` is the iOS keyboard lift — 0 until the visualViewport watcher
          publishes an inset. */}
      <div
        data-slot="thread-dock"
        className="sticky bottom-[var(--kb,0px)] z-10 bg-background px-4 pt-1.5 pb-3 max-md:border-t max-md:border-border md:px-6 md:pb-4"
      >
        {/* The jump pill floats over the thread, just above the dock, centered. */}
        {scroll.pillVisible ? (
          <div className="pointer-events-none absolute inset-x-0 -top-12 flex justify-center">
            <JumpToLatestPill onJump={scroll.jumpToLatest} />
          </div>
        ) : null}
        <div className="mx-auto flex w-full max-w-[var(--measure)] flex-col gap-2.5">
          {/* Agents above the plan: the fan-out is the more urgent "what is happening now",
              and it is transient — the plan outlives it. Keyed by run id like the plan dock. */}
          <AgentsDock key={`agents:${run.id}`} runId={run.id} agents={agents} onSelect={setOpenAgentId} />

          {plan !== undefined && plan.length > 0 ? (
            // Keyed by run id: the collapse default re-derives per task (see PlanDock).
            <PlanDock key={run.id} runId={run.id} entries={plan} />
          ) : null}

          {run.status === 'waiting' ? (
            <div
              data-slot="paused-hint"
              className="flex items-center gap-2 px-1 text-xs text-muted-foreground"
            >
              <StatusDot tone="pending" pulse />
              The agent is paused, waiting for your reply
            </div>
          ) : null}

          {queued ? (
            <div
              data-slot="queued-hint"
              className="flex items-center gap-2 px-1 text-xs text-muted-foreground"
            >
              <StatusDot tone="pending" />
              Messages you add now are folded into the prompt before the run starts.
            </div>
          ) : null}

          <Composer
            onSubmit={
              continuable
                ? (text, images) => continueAction.continueWith(text, images)
                : (text, images) => sendMessage.mutateAsync({ text, images })
            }
            disabled={providerBlocked || (!sessionOpen && !queued && !continuable)}
            // Only reachable now by a closed run with NO session to resume — which is exactly
            // the one case where Continue is not on offer either. Left honest rather than
            // rewritten: "closed" is all such a run can be told.
            disabledReason={providerBlocked ? providerReason : 'Session closed — no session to resume.'}
            // The engine pills ride the enabled footer, so the picked runner/model and the
            // typed prompt reach `POST /continue` in one request.
            footerEnd={
              providerBlocked && !continueAction.providerPending ? (
                <Link
                  to="/settings/agents#providers"
                  className="text-xs font-medium text-foreground underline underline-offset-4"
                >
                  Configure providers
                </Link>
              ) : continuable ? continueAction.pills : undefined
            }
            // Continuing with nothing typed is the legacy one-click Continue.
            allowEmptySubmit={continuable}
            sendAriaLabel={continuable ? 'Continue' : 'Send'}
            placeholder={
              queued ? 'Add to the prompt — sent when the run starts…'
              : continuable ? 'Continue — add a prompt, or send to just reopen the session…'
              : run.status === 'waiting' ? 'Reply — / for skills, @ for files…'
              : 'Message the agent — / for skills, @ for files…'
            }
            autocompleteSkills
            quickReplies
            getMentionCandidates={() => threadFilePaths(thread)}
          />
        </div>
      </div>
    </div>
  )
}

/** The queued run's honest empty state (legacy #351): a queued run has emitted nothing, so
 *  instead of a blank thread the placeholder names the parked state and its live position in
 *  the FIFO queue (from the runs list — the same feed the sidebar uses). */
function QueuedPlaceholder({ run }: { run: ApiRun }) {
  const runs = useRuns()
  const position = queuePosition(runs.data ?? [], run.id)
  return (
    <div data-slot="queued-state" className="flex flex-col items-center gap-1.5 py-10 text-center">
      <StatusDot tone="pending" pulse />
      <p className="text-[13px] font-medium">
        Waiting for a free agent slot{position !== undefined ? ` — #${position} in queue` : ''}
      </p>
      <p className="text-xs text-soft-foreground">
        {run.workflow} · starts automatically when a slot frees up
      </p>
    </div>
  )
}

/** One grouped block → its surface. Grouping (context groups, streaks, sub-agent nesting) is
 *  `groupThreadItems`'s — this only maps block kinds to components. `scope` (the turn's render
 *  key) namespaces the open-card cache keys, because item ids repeat across sessions. */
function ThreadBlockView({ block, scope, run }: { block: ThreadBlock; scope: string; run: ApiRun }) {
  switch (block.kind) {
    case 'entry':
      return <ThreadEntryView entry={block.entry} scope={scope} run={run} />
    case 'tool-card':
      return <ToolCard item={block.item} nested={block.children} cacheKey={`${scope}:${block.id}`} />
    case 'context-group':
      return <ContextGroup group={block} scope={scope} />
    case 'streak':
      return (
        <ToolStreak count={block.count}>
          {block.blocks.map((inner) => (
            <ThreadBlockView key={inner.id} block={inner} scope={scope} run={run} />
          ))}
        </ToolStreak>
      )
  }
}

/** One reducer entry → its block (non-tool entries; tools always arrive as tool-card blocks). */
function ThreadEntryView({ entry, scope, run }: { entry: ThreadEntry; scope: string; run: ApiRun }) {
  switch (entry.kind) {
    case 'message':
      // Agent-side user echoes (some backends emit them) read as user bubbles too.
      return entry.role === 'assistant' ? (
        <AssistantMessage text={entry.text} />
      ) : (
        <UserBubble text={entry.text} />
      )
    case 'reasoning':
      return <ReasoningItem text={entry.text} />
    case 'tool':
      return <ToolCard item={entry} cacheKey={`${scope}:${entry.id}`} />
    case 'note':
      return <NoteLine note={entry} />
    case 'image':
      return <ImageItem image={entry} />
    case 'ask':
      return <AskCard ask={entry} run={run} />
    case 'provider-auth-required':
      return <ProviderAuthRequiredCard incident={entry} />
  }
}
