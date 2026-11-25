import type { ApiRun, FrameworkFile, FrameworkStage } from '@open-mercato/cezar-api-client'
import { ArrowLeftIcon, ExternalLinkIcon, LayersIcon } from 'lucide-react'
import * as React from 'react'
import { useParams } from 'react-router'

import { stageNamesOf, useCardRecheckOnFocus, useFinishCardStage, useFramework, useFrameworks } from '@/api/frameworks'
import { useRun } from '@/api/queries'
import { useRunHistory } from '@/api/run-history'
import { CenteredState } from '@/components/centered-state'
import { ScreenLoading } from '@/components/loading-state'
import { DiffStatLabel } from '@/components/diff-stat'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'
import {
  cardColumn,
  cardNotStarted,
  displayStageStatus,
  gateApprovable,
  selfConfirmedReason,
  wantsRecheck,
  inConversation,
  isCard,
  nextStage,
  openGate,
  RERUNNABLE,
  stageName,
  type CardRun,
  type StageNames,
} from '@/lib/cards'
import { isAwaitingAnswer } from '@/lib/attention'
import { PROVIDER_LABELS } from '@/lib/provider-auth-alert'
import { Link } from '@/lib/project-router'
import { runRoute } from '@/lib/task-route'
import { cn } from '@/lib/utils'
import { useRunRecordReconcile } from '../task-thread/run-reconcile'
import { reduceThread, trackedAsks, type ThreadState } from '../task-thread/thread-state'
import { CardConfirmDialog, useCardActions } from './card-actions'
import { CardChat } from './card-chat'


/**
 * The card wizard (spec 2026-11-15-framework-board, mockups 2–3): the stepper is the framework,
 * the body is the selected stage — a gate to decide, a conversation to answer, a blocker to read.
 * The conversation is a compact chat over the task view's own thread and delivery seams; the
 * full task view is one link away.
 */
export function CardWizardRoute() {
  const { runId } = useParams<{ runId: string }>()
  const run = useRun(runId)
  const frameworks = useFrameworks()
  const card = run.data && isCard(run.data) ? (run.data as CardRun & ApiRun) : undefined
  const framework = useFramework(card?.card.framework)
  const names = React.useMemo(() => stageNamesOf(frameworks.data, card?.card.framework), [frameworks.data, card?.card.framework])
  const frameworkName = frameworks.data?.frameworks.find((f) => f.id === card?.card.framework)?.name ?? card?.card.framework

  useCardRecheckOnFocus(card ? wantsRecheck(card) : false)

  if (run.isPending) return <ScreenLoading label="Loading card…" />
  if (run.isError) return <CenteredState icon={<LayersIcon />} tone="danger" title="This card did not load" subtitle={run.error.message} />
  if (!card) {
    return (
      <CenteredState
        icon={<LayersIcon />}
        title="Not a framework card"
        subtitle="This task is not on the board."
        actions={
          <Button asChild variant="outline">
            <Link to={runRoute(run.data, { taskView: true })}>Open task view</Link>
          </Button>
        }
      />
    )
  }
  return <CardWizardWithThread run={card} framework={framework.data?.framework} frameworkName={frameworkName ?? card.card.framework} names={names} />
}

/** The run's thread from the task view's own history hook (one SSE, no polling), reduced the same way. */
function CardWizardWithThread({ run, ...rest }: { run: CardRun & ApiRun; framework?: FrameworkFile; frameworkName: string; names?: StageNames }) {
  const history = useRunHistory(run.id)
  const thread = React.useMemo(
    () => reduceThread(history.visibleEvents, { activeTurn: run.status === 'running', runner: run.runner, trackedAsks: trackedAsks(run) }),
    // Same dependencies as the task view's ConversationColumn.
    [history.visibleEvents, run.status, run.runner, run.asks],
  )
  useRunRecordReconcile(run, history.visibleEvents)
  return (
    <CardWizard
      run={run}
      {...rest}
      thread={history.isPending ? undefined : thread}
      older={{ hasOlder: history.hasOlder, loading: history.isFetchingOlder, load: () => void history.loadOlder() }}
    />
  )
}

type StepState = 'done' | 'current' | 'waiting' | 'running' | 'failed' | 'skipped' | 'stale' | 'pending'

/** A stepper dot's state (mockup `.st.d/.a/.w/.f`): the engine's `card.stages`, never a guess. */
export function stepState(run: CardRun, stage: string): StepState {
  const status = displayStageStatus(run, stage)
  // The user's turn (💬) or an open question (❓) is amber whatever the stage record says.
  if (run.card.stage === stage && status !== 'done' && status !== 'skipped' && (inConversation(run) || isAwaitingAnswer(run))) return 'waiting'
  if (status === 'done') return 'done'
  if (status === 'failed') return 'failed'
  if (status === 'skipped') return 'skipped'
  if (status === 'waiting') return 'waiting'
  if (status === 'running') return 'running'
  if (status === 'stale') return 'stale'
  return run.card.stage === stage && run.status !== 'queued' ? 'current' : 'pending'
}

const DOT_TONE: Record<StepState, string> = {
  done: 'border-success bg-success text-background',
  current: 'border-info text-info bg-card',
  running: 'border-info text-info bg-card',
  waiting: 'border-pending bg-pending/15 text-pending-strong',
  failed: 'border-danger text-danger bg-card',
  skipped: 'border-border border-dashed text-soft-foreground bg-card',
  stale: 'border-pending text-pending-strong bg-card',
  pending: 'border-border text-muted-foreground bg-card',
}

const STATE_LABEL: Record<StepState, string> = {
  done: 'done',
  current: 'current',
  running: 'running',
  waiting: 'waiting for you',
  failed: 'failed',
  skipped: 'skipped',
  stale: 'stale — re-run',
  pending: 'pending',
}

function stepGlyph(run: CardRun, stage: string, state: StepState, index: number): string {
  if (state === 'done') return '✓'
  if (state === 'failed') return '✕'
  if (state === 'skipped') return '–'
  if (state === 'stale') return '↺'
  if (state === 'waiting' && run.card.stage === stage) {
    if (isAwaitingAnswer(run)) return '❓'
    if (inConversation(run)) return '💬'
  }
  if (state === 'waiting') return '⏸'
  if (state === 'running') return '●'
  return String(index + 1)
}

/** The small line under a step (mockup `.sub`): what a person most needs to know about it. */
function stepSub(run: CardRun, stage: string, state: StepState, def?: FrameworkStage): string | undefined {
  if (state === 'waiting') return run.card.stage === stage && inConversation(run) ? 'your turn' : 'waiting for you'
  if (state === 'running') return 'running'
  if (state === 'failed') return 'failed'
  if (state === 'skipped') return 'skipped'
  if (state === 'stale') return 'stale'
  if (state === 'done') return def?.mode === 'conversation' && run.card.autonomous ? '🤖 autonomous' : undefined
  if (state === 'pending' && nextStage(run, run.card.stage) === stage) {
    return !def?.session || def.session === 'fresh' ? 'fresh session' : 'same session'
  }
  return undefined
}

const SHIP = '__ship'

export function CardWizard({
  run,
  framework,
  frameworkName,
  names,
  thread,
  older,
}: {
  run: CardRun
  framework?: FrameworkFile
  frameworkName: string
  names?: StageNames
  /** The run's reduced thread (the task view's `reduceThread`); undefined while it loads. */
  thread?: ThreadState
  older?: React.ComponentProps<typeof CardChat>['older']
}) {
  const current = run.status === 'review' || run.status === 'done' ? SHIP : run.card.stage
  const [selected, setSelected] = React.useState(current)
  React.useEffect(() => setSelected(current), [current])
  const actions = useCardActions()
  const name = (id: string) => stageName(names, id)
  const stageDef = (id: string) => framework?.stages.find((s) => s.id === id)
  const started = run.startedAt ?? run.createdAt
  const minutes = Math.max(0, Math.round(((run.finishedAt ? Date.parse(run.finishedAt) : Date.now()) - Date.parse(started)) / 60_000))
  const order = run.card.stageOrder

  return (
    <div data-route="card-wizard" data-run-id={run.id} className="flex min-h-full flex-col pb-[env(safe-area-inset-bottom)]">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-3 py-2.5 md:px-5">
        <Button asChild variant="ghost" size="sm">
          <Link to={{ pathname: '/tasks', search: '?view=board' }}>
            <ArrowLeftIcon aria-hidden="true" />
            Board
          </Link>
        </Button>
        <h1 className="min-w-0 truncate text-base font-semibold">{run.card.title}</h1>
        <span data-slot="card-framework" className="rounded-full bg-violet/10 px-2 py-0.5 text-label text-violet">◆ {frameworkName}</span>
        {run.branch ? <code className="rounded-[6px] bg-muted px-1.5 py-0.5 font-mono text-meta text-muted-foreground">{run.branch}</code> : null}
        <span className="flex-1" />
        <span className="font-mono text-meta text-muted-foreground tabular-nums">
          {run.costUsd ? `$${run.costUsd.toFixed(2)} · ` : ''}
          {minutes} min
        </span>
        <Button asChild variant="ghost" size="sm">
          <Link to={runRoute(run, { taskView: true })} data-action="open-task-view">
            Open task view <ExternalLinkIcon aria-hidden="true" />
          </Link>
        </Button>
      </header>

      <nav aria-label="Stages" className="overflow-x-auto px-3 md:px-5">
        <ol data-slot="card-stepper" className="flex min-w-max items-start pt-4 pb-2">
          {[...order, SHIP].map((stage, i) => {
            const ship = stage === SHIP
            const state: StepState = ship ? (run.status === 'review' ? 'waiting' : run.status === 'done' ? 'done' : 'pending') : stepState(run, stage)
            const isCur = ship ? current === SHIP : stage === run.card.stage && current !== SHIP
            const glyph = ship ? (state === 'done' ? '✓' : String(order.length + 1)) : stepGlyph(run, stage, state, i)
            const sub = ship ? '🧑 human' : stepSub(run, stage, state, stageDef(stage))
            const last = i === order.length
            return (
              <li key={stage} className="relative flex w-[108px] shrink-0 flex-col items-center">
                {last ? null : (
                  <span
                    aria-hidden="true"
                    className={cn('absolute top-[14px] right-[calc(-50%+17px)] left-[calc(50%+17px)] h-0.5', state === 'done' ? 'bg-success' : 'bg-border')}
                  />
                )}
                <button
                  type="button"
                  data-stage={ship ? 'ship' : stage}
                  data-state={state}
                  aria-current={selected === stage ? 'step' : undefined}
                  onClick={() => setSelected(stage)}
                  className="group flex flex-col items-center gap-1.5 rounded-md px-1 pb-1 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'z-[1] inline-flex size-7 items-center justify-center rounded-full border-2 text-label font-bold',
                      DOT_TONE[state],
                      selected === stage && 'ring-2 ring-ring/40 ring-offset-2 ring-offset-background',
                    )}
                  >
                    {glyph}
                  </span>
                  <span className={cn('text-center text-label', isCur || selected === stage ? 'font-semibold text-foreground' : 'text-muted-foreground group-hover:text-foreground')}>
                    {ship ? 'Ship' : name(stage)}
                  </span>
                  {sub ? <span className="-mt-1 text-micro text-soft-foreground">{sub}</span> : null}
                  <span className="sr-only"> — {ship ? 'a human merges' : STATE_LABEL[state]}</span>
                </button>
              </li>
            )
          })}
        </ol>
      </nav>

      <div className="grid flex-1 border-t border-border lg:grid-cols-[minmax(0,1fr)_280px]">
        <main data-slot="card-body" className="flex min-w-0 flex-col gap-4 p-3 md:px-5 md:py-4">
          <StageBody run={run} selected={selected} framework={framework} names={names} thread={thread} older={older} actions={actions} />
        </main>
        <CardSidePanel run={run} stage={selected === SHIP ? undefined : stageDef(selected)} stageId={selected} names={names} />
      </div>

      <CardConfirmDialog
        pending={actions.pending}
        names={names}
        localHandoff={actions.localHandoff}
        onCancel={() => actions.setPending(null)}
        onConfirm={actions.confirm}
      />
    </div>
  )
}

function Panel({ title, tone = 'neutral', children, slot }: { title: React.ReactNode; tone?: 'neutral' | 'pending' | 'danger' | 'info'; children: React.ReactNode; slot?: string }) {
  return (
    <section
      data-slot={slot}
      className={cn(
        'rounded-lg border px-4 py-3',
        tone === 'pending' ? 'border-pending/50 bg-gradient-to-b from-pending/10 to-transparent' : tone === 'danger' ? 'border-danger/40 bg-danger/5' : tone === 'info' ? 'border-info/30 bg-info/5' : 'border-border bg-card',
      )}
    >
      <h2 className="mb-1 text-ui font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  )
}

/** The selected stage's title and its role line (the framework's `description`). */
function StageHeading({ title, stage, slot }: { title: React.ReactNode; stage?: FrameworkStage; slot?: string }) {
  return (
    <div data-slot={slot ?? 'card-stage-heading'} className="flex flex-col gap-0.5">
      <h2 className="text-ui font-semibold text-foreground">{title}</h2>
      {stage?.description ? <p data-slot="card-stage-role" className="text-label text-muted-foreground">{stage.description}</p> : null}
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="eyebrow mb-2 text-soft-foreground">{children}</h3>
}

/** The stage the gate's Request changes reopens: `onReject`, else the previous stage (compile.ts). */
function rejectTarget(run: CardRun, stage: string, def?: FrameworkStage): string {
  if (def?.gate?.kind === 'approve' && def.gate.onReject) return def.gate.onReject
  const order = run.card.stageOrder.filter((s) => run.card.stages[s] !== 'skipped')
  return order[order.indexOf(stage) - 1] ?? stage
}

function StageBody({
  run,
  selected,
  framework,
  names,
  thread,
  older,
  actions,
}: {
  run: CardRun
  selected: string
  framework?: FrameworkFile
  names?: StageNames
  thread?: ThreadState
  older?: React.ComponentProps<typeof CardChat>['older']
  actions: ReturnType<typeof useCardActions>
}) {
  const name = (id: string) => stageName(names, id)
  const finish = useFinishCardStage()
  const [comment, setComment] = React.useState('')
  const fail = (error: Error) => toast(error.message, { tone: 'danger' })
  const chat = (buttons?: React.ReactNode) =>
    thread ? (
      <CardChat
        run={run as CardRun & ApiRun}
        thread={thread}
        stage={name(run.card.stage)}
        next={nextStage(run, run.card.stage) ? name(nextStage(run, run.card.stage)!) : undefined}
        actions={buttons}
        older={older}
      />
    ) : (
      <p className="text-label text-muted-foreground">Loading the conversation…</p>
    )

  if (selected === SHIP) {
    return (
      <Panel title="🧑 Ship — a human merges">
        <p className="text-label text-muted-foreground">
          {run.status === 'review'
            ? 'Every stage is done. Open the task view to review the diff, open the pull request, or discard.'
            : run.status === 'done'
              ? 'This card has shipped.'
              : 'Ship is the run’s own review gate — the card reaches it after its last stage.'}
        </p>
      </Panel>
    )
  }

  const stage = framework?.stages.find((s) => s.id === selected)
  const isCurrent = selected === run.card.stage && cardColumn(run).startsWith('stage:')
  const order = run.card.stageOrder
  const earlier = order.indexOf(selected) < order.indexOf(run.card.stage) || run.status === 'review'
  const rerunButton = RERUNNABLE.has(run.status) && (earlier || isCurrent) && run.card.stages[selected] !== 'skipped' ? (
    <Button type="button" variant="ghost" data-action="card-rerun" onClick={() => actions.setPending({ kind: 'rerun', run, fromStage: selected })}>
      Re-run {name(selected)}
    </Button>
  ) : null

  if (run.status === 'queued' && selected === run.card.stage && !cardNotStarted(run)) {
    return (
      <Panel slot="card-queued" title={`${name(run.card.stage)} — waiting for a slot`}>
        <p className="text-label text-muted-foreground">The card was re-queued mid-walk; it resumes this stage when a slot frees.</p>
      </Panel>
    )
  }

  if (run.status === 'queued' && selected === run.card.stage) {
    return (
      <Panel title={run.card.held ? 'In the Backlog' : 'Ready — waiting for a slot'}>
        <p className="mb-3 text-label text-muted-foreground">
          {run.card.held ? 'Nothing runs until the card is Ready.' : 'An agent picks it up in Ready order whenever a slot frees.'}
        </p>
        <Button type="button" onClick={() => void actions.patch(run.id, { held: !run.card.held }).catch(fail)}>
          {run.card.held ? 'Move to Ready' : 'Back to Backlog'}
        </Button>
      </Panel>
    )
  }

  if (!isCurrent) {
    return (
      <Panel title={`Stage ${order.indexOf(selected) + 1} · ${name(selected)} · ${displayStageStatus(run, selected) ?? 'pending'}`}>
        <StageFacts stage={stage} />
        {rerunButton ? <div className="mt-3">{rerunButton}</div> : null}
      </Panel>
    )
  }

  const gate = openGate(run)
  const next = nextStage(run, run.card.stage)
  if (gate) {
    const approvable = gateApprovable(gate)
    const loopKey = `${gate.stage}-reject-loop`
    const loops = run.graphState?.loops?.[loopKey] ?? 0
    const loopMax = stage?.loopMax ?? 2
    const reopens = rejectTarget(run, gate.stage, stage)
    return (
      <>
        <Panel
          slot="card-gate"
          tone="pending"
          title={approvable ? `⏸ Approve ${name(gate.stage)}${next ? ` to start ${name(next)}` : ''}` : `⏸ ${name(gate.stage)} — waiting for the framework`}
        >
          {stage?.description ? <p data-slot="card-stage-role" className="mb-1 text-label text-muted-foreground">{stage.description}</p> : null}
          <p className="mb-3 text-label text-muted-foreground">
            {!approvable
              ? `${selfConfirmedReason(gate)} The card moves on once the framework’s state says the stage is done.`
              : gate.kind === 'framework'
              ? 'The framework records this approval itself; the card moves on once its state says the stage is approved.'
              : `Approve continues on the same branch${next ? `; ${name(next)} starts in ${!stageDefOf(framework, next)?.session || stageDefOf(framework, next)?.session === 'fresh' ? 'a fresh session' : 'the same session'}` : ''}. Request changes sends your comment back to ${name(reopens)} (bounded loop).`}
          </p>
          {gate.kind === 'human' ? (
            <Textarea
              aria-label="What should change"
              rows={3}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Comment (required for Request changes)…"
              className="mb-3"
            />
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {approvable ? (
              <Button type="button" data-action="card-approve" disabled={actions.busy} onClick={() => actions.setPending({ kind: 'approve', run, gate })}>
                Approve &amp; continue{next ? ` → ${name(next)}` : ''}
              </Button>
            ) : null}
            {gate.kind === 'human' ? (
              <Button
                type="button"
                variant="outline"
                data-action="card-request-changes"
                className="border-pending/60 text-pending-strong"
                disabled={!comment.trim() || loops >= loopMax}
                onClick={() => {
                  actions.requestChanges(run, comment)
                  setComment('')
                }}
              >
                Request changes → re-run {name(reopens)} (loop {Math.min(loops + 1, loopMax)}/{loopMax})
              </Button>
            ) : null}
            <span className="flex-1" />
            {rerunButton}
          </div>
        </Panel>
        <section data-slot="card-produced">
          <SectionTitle>Stage {order.indexOf(gate.stage) + 1} · {name(gate.stage)} — produced</SectionTitle>
          <ul className="flex flex-col rounded-lg border border-border bg-card text-label">
            {(stage?.artifacts ?? []).map((glob) => (
              <li key={glob} className="flex items-center gap-2 border-b border-border px-3 py-2 last:border-b-0">
                📄 <span className="font-mono text-meta text-foreground">{glob}</span>
              </li>
            ))}
            {run.diffStat ? (
              <li className="flex items-center gap-2 border-b border-border px-3 py-2 last:border-b-0">
                Changes on the branch <span className="ml-auto"><DiffStatLabel stat={run.diffStat} /></span>
              </li>
            ) : null}
            {run.pullRequestUrl ? (
              <li className="flex items-center gap-2 border-b border-border px-3 py-2 last:border-b-0">
                🔗{' '}
                <a href={run.pullRequestUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                  Draft pull request
                </a>
              </li>
            ) : null}
            {!stage?.artifacts?.length && !run.diffStat && !run.pullRequestUrl ? <li className="px-3 py-2 text-muted-foreground">Open the task view for the stage’s output.</li> : null}
          </ul>
        </section>
      </>
    )
  }

  if (run.card.blocked && run.card.blocked.reason !== 'gate') {
    return (
      <Panel slot="card-blocked" tone="pending" title={run.card.blocked.reason === 'wip' ? `⏸ ${name(run.card.stage)} is full (WIP)` : '⏸ The stage’s precheck refused to start'}>
        <p className="text-label text-muted-foreground">
          {run.card.blocked.reason === 'wip'
            ? 'The card holds no slot and starts by itself when a card leaves this stage.'
            : 'The framework said this stage cannot start yet. Fix what it names; the card is checked again when its state changes.'}
        </p>
        {run.card.blocked.detail ? <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-meta whitespace-pre-wrap">{run.card.blocked.detail}</pre> : null}
      </Panel>
    )
  }

  const conversationStage = stage?.mode === 'conversation' && !run.card.autonomous
  // Mockup 3's right-hand pair: in a conversation turn, and in a live question inside a conversation stage.
  const conversationButtons =
    inConversation(run) || (conversationStage && isAwaitingAnswer(run) && run.status === 'waiting') ? (
      <>
        <Button type="button" variant="ghost" data-action="card-autonomous" disabled={actions.busy} onClick={() => void actions.patch(run.id, { autonomous: true }).catch(fail)}>
          🤖 Let the agent decide
        </Button>
        <Button
          type="button"
          data-action="card-finish-stage"
          className="bg-success text-success-foreground"
          disabled={finish.isPending}
          onClick={() => finish.mutate(run.id, { onError: fail })}
        >
          Finish stage{next ? ` → ${name(next)}` : ''}
        </Button>
      </>
    ) : undefined

  if (inConversation(run)) {
    return <div data-slot="card-conversation">{chat(conversationButtons)}</div>
  }

  if (isAwaitingAnswer(run)) {
    const agent = PROVIDER_LABELS[run.runner as keyof typeof PROVIDER_LABELS] ?? 'The agent'
    return (
      <>
        <StageHeading slot="card-question" title={`❓ ${name(run.card.stage)} — a question for you`} stage={stage} />
        {run.status !== 'waiting' ? (
          <p data-slot="card-question-note" className="text-label text-muted-foreground">
            {agent} asked — answer to continue (the session ended; sending reopens it).
          </p>
        ) : null}
        {chat(conversationButtons)}
        {rerunButton ? <div className="flex flex-wrap items-center gap-2">{rerunButton}</div> : null}
      </>
    )
  }

  if (run.status === 'failed') {
    return (
      <>
        <Panel tone="danger" title={`✕ ${name(run.card.stage)} failed`}>
          <p className="mb-3 text-label text-muted-foreground">The error is the last entry in the thread below. Reply to continue the stage, or re-run it.</p>
          {rerunButton}
        </Panel>
        {chat()}
      </>
    )
  }

  return (
    <>
      <StageHeading
        title={`${run.status === 'waiting' ? '💬' : '●'} ${name(run.card.stage)} — ${run.status === 'waiting' ? 'a question for you' : 'running'}`}
        stage={stage}
      />
      {chat()}
    </>
  )
}

const stageDefOf = (framework: FrameworkFile | undefined, id: string) => framework?.stages.find((s) => s.id === id)

function StageFacts({ stage }: { stage?: FrameworkStage }) {
  if (!stage) return <p className="text-label text-muted-foreground">The framework’s detail is loading.</p>
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-label">
      {stage.description ? (
        <>
          <dt className="text-muted-foreground">Role</dt>
          <dd>{stage.description}</dd>
        </>
      ) : null}
      <dt className="text-muted-foreground">Must leave</dt>
      <dd className="font-mono text-meta">{stage.artifacts?.join(', ') || '—'}</dd>
      {stage.checks?.length ? (
        <>
          <dt className="text-muted-foreground">Checks</dt>
          <dd className="font-mono text-meta">{stage.checks.join(', ')}</dd>
        </>
      ) : null}
    </dl>
  )
}

function gateLabel(stage?: FrameworkStage): string {
  if (!stage?.gate) return 'None'
  return stage.gate.kind === 'approve' ? 'Approve' : stage.gate.approve ? `Framework (approve ${stage.gate.approve})` : 'Framework (owner confirms)'
}

function KeyValues({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[110px_1fr] gap-x-2.5 gap-y-1.5">
      {rows.map(([k, v]) => (
        <React.Fragment key={k}>
          <dt className="text-soft-foreground">{k}</dt>
          <dd className="min-w-0 [overflow-wrap:anywhere]">{v}</dd>
        </React.Fragment>
      ))}
    </dl>
  )
}

function CardSidePanel({ run, stage, stageId, names }: { run: CardRun; stage?: FrameworkStage; stageId: string; names?: StageNames }) {
  const [open, setOpen] = React.useState(false)
  const conversation = stage?.mode === 'conversation' && !run.card.autonomous
  const isCurrent = run.card.stage === stageId
  const next = stage ? nextStage(run, stageId) : undefined
  // Mockup 3's order; a conversation stage shows only its five rows.
  const rows: [string, React.ReactNode][] = stage
    ? [
        ['Mode', conversation ? '💬 Conversation' : '🤖 Autonomous'],
        ['Skill', <span className="font-mono text-meta">{stage.skill ?? stage.command ?? 'generated prompt'}</span>],
        ['Session', !stage.session || stage.session === 'fresh' ? 'Fresh' : `Continues ${stageName(names, stage.session.continue)}`],
        ...(stage.artifacts?.length ? ([['Must leave', <span className="font-mono text-meta">{stage.artifacts.join(', ')}</span>]] as [string, React.ReactNode][]) : []),
        ...(conversation && !stage.gate
          ? []
          : ([
              ['Gate', gateLabel(stage)],
              ['Runner', [stage.runner ?? run.runner, stage.model].filter(Boolean).join(' · ') || 'project default'],
            ] as [string, React.ReactNode][])),
        [
          'Holds slot',
          run.status === 'running' && isCurrent ? 'Yes' : conversation && isCurrent ? 'Only while answering' : 'No (parked)',
        ],
      ]
    : []
  const created = new Date(run.createdAt)
  const history = [...(run.card.history ?? [])].reverse()
  return (
    <aside data-slot="card-side" className="flex flex-col border-t border-border bg-muted/20 text-label lg:border-t-0 lg:border-l">
      <button
        type="button"
        data-action="card-side-toggle"
        aria-expanded={open}
        aria-controls="card-side-body"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center justify-between px-3 py-2.5 text-ui font-medium lg:hidden"
      >
        Stage &amp; card details
        <span aria-hidden="true" className={cn('transition-transform', open && 'rotate-180')}>▾</span>
      </button>
      <div id="card-side-body" className={cn('flex-col gap-5 px-3 pb-4 lg:flex lg:p-4', open ? 'flex' : 'hidden')}>
        {rows.length ? (
          <section>
            <SectionTitle>Stage</SectionTitle>
            <KeyValues rows={rows} />
          </section>
        ) : null}
        {conversation && isCurrent && next ? (
          <section data-slot="card-side-next">
            <SectionTitle>Next</SectionTitle>
            <p className="text-muted-foreground">
              {stageName(names, next)} starts in a new session. It reads the {stageName(names, stageId)} artifact and the card, not this chat.
            </p>
          </section>
        ) : null}
        <section>
          <SectionTitle>Card</SectionTitle>
          <KeyValues
            rows={[
              [
                'Issue',
                run.card.issue ? (
                  run.card.issue.url ? (
                    <a href={run.card.issue.url} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                      {run.card.issue.ref}
                    </a>
                  ) : (
                    run.card.issue.ref
                  )
                ) : (
                  '—'
                ),
              ],
              ['Created', created.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })],
              ['Total cost', <span className="font-mono tabular-nums">{run.costUsd ? `$${run.costUsd.toFixed(2)}` : '—'}</span>],
              ['Autonomous', run.card.autonomous ? 'Yes' : 'No'],
            ]}
          />
        </section>
        {history.length ? (
          <section>
            <SectionTitle>History</SectionTitle>
            <ol data-slot="card-history" className="flex flex-col">
              {history.map((h, i) => {
                const tone = /fail|cancel/i.test(h.text) ? 'bg-danger' : /wait|gate|back to|blocked/i.test(h.text) ? 'bg-pending' : 'bg-success'
                return (
                  <li key={`${h.at}-${i}`} className="relative border-l-2 border-border py-1 pl-3.5 text-meta">
                    <span aria-hidden="true" className={cn('absolute top-[9px] -left-[5px] size-2 rounded-full', tone)} />
                    <span className="text-foreground">{h.text}</span>{' '}
                    <span className="text-soft-foreground tabular-nums">· {new Date(h.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
                  </li>
                )
              })}
            </ol>
          </section>
        ) : null}
      </div>
    </aside>
  )
}
