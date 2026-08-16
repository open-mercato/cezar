import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckIcon, InboxIcon, PlayIcon, TriangleAlertIcon } from 'lucide-react'
import { useRef, useState } from 'react'
import { Link, useNavigate } from '@/lib/project-router'

import { removeTodo, startTodo } from '@/api/client'
import { queryKeys, useHealth, useRuns, useTodos, useUiState } from '@/api/queries'
import type { TodoItem } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { EnginePills, engineBody, useResolvedEngine, type EnginePick } from '@/components/engine-pills'
import { PromptTemplateMenu } from '@/components/prompt-template-menu'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'
import { deriveAttention } from '@/lib/attention'
import { shortAge } from '@/lib/format'
import { insertTemplate, normalizePromptTemplates } from '@/lib/prompt-templates'
import { isHttpUrl } from '@/lib/utils'

/**
 * `/inbox` — the follow-up inbox rebuilt in React (R6 Step 1.2, spec §"Skills, Workflows,
 * Inbox"): the card list the legacy `renderInbox()` drew, restyled to the design system.
 *
 * Functional parity with the legacy view (web/app.js, spec 007):
 *  - entries already turned into a task (`startedTaskId`) are hidden — they stay in
 *    `todos.json` as an audit trail (the legacy `visibleTodos()` rule);
 *  - Run → `POST /api/todos/:id/start`, then straight to the new task's thread (the legacy
 *    `showRunsView()` + `selectRun()` hop, expressed as navigation);
 *  - Dismiss → `DELETE /api/todos/:id` — check off, gone;
 *  - the meta row keeps age / action / source-task link (or the honest "source task
 *    deleted") / PR link / suggested skill.
 *
 * "Add instructions" (#413) is new: a collapsed-by-default composer per card, closed unless a
 * user opts in — most follow-ups just run as suggested. Whatever is typed there is extra
 * instructions appended (server-side) to the suggested/summary task text, and the same reusable
 * prompt templates as the GitHub hand-over insert into it. Unlike that composer's custom prompt,
 * nothing here survives a reload: the card itself is gone the moment Run succeeds, so there is
 * no draft worth persisting.
 *
 * The nav badge is NOT this view's business: the global-events reducer maintains the todos
 * query from the SSE `todos` event and the shell derives the badge from it — this route only
 * reads the same query, so the two can never disagree.
 *
 * Every card wears the attention grammar's "needs you" rung (`deriveAttention` on `waiting`):
 * an inbox entry is by definition an agent waiting on a human decision, so the dot is the
 * same amber pulse a waiting run shows — one grammar, not a second dialect.
 */

/** The one attention rung an inbox entry can be on — see the doc block above. */
const CARD_ATTENTION = deriveAttention({ status: 'waiting' })

/** The legacy `visibleTodos()` rule: started entries are the audit trail, not the inbox. */
export function visibleTodos(todos: readonly TodoItem[]): TodoItem[] {
  return todos.filter((todo) => !todo.startedTaskId)
}

/** Explicit intent wins; old todos infer actionability from an executable suggestion. */
export function isTodoRunnable(todo: TodoItem): boolean {
  return todo.runnable ?? Boolean(todo.suggestedSkill || todo.suggestedPrompt)
}

export function InboxRoute() {
  // The nav item is inbox-gated in the shell, but the route stays reachable so an old
  // bookmark still resolves (the forge routes' rule). "Inbox empty" would be a lie here —
  // the inbox is switched off, not empty — so say that instead, and park the query.
  //
  // Parked only once health has actually said the inbox is off (#471). Keying it on
  // `inboxAvailable` instead would park the query for as long as health is unknown, which on a
  // perfectly enabled server means the list waits on a second request it doesn't need.
  const health = useHealth()
  const inboxAvailable = health.data?.capabilities.followups === true
  const inboxOff = health.data !== undefined && !inboxAvailable
  const todosQuery = useTodos(!inboxOff)
  // Only to tell "source task" links from "source task deleted" — the legacy check against
  // its run map. The overview keeps this query warm, so revisits cost nothing.
  const runs = useRuns()

  const todos = todosQuery.data === undefined ? undefined : visibleTodos(todosQuery.data)

  return (
    <div data-route="inbox" className="flex min-h-full flex-col">
      {/* Desktop header — below `md` the shell's top bar already says "Inbox". */}
      <header className="sticky top-0 z-10 hidden h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-5 md:flex">
        <h1 className="text-base font-semibold">Inbox</h1>
        <p className="text-[13px] text-soft-foreground">
          {inboxOff
            ? 'Disabled for this server; per-task Notes still run.'
            : 'Follow-ups agents suggested when they finished a task.'}
        </p>
      </header>

      <div className="flex flex-1 flex-col p-3 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-5 md:pb-5">
        {inboxOff ? (
          <CenteredState
            icon={<InboxIcon />}
            tone="neutral"
            title="The follow-up inbox is off"
            subtitle="Agents are not asked to leave follow-ups. Set CEZ_FOLLOWUPS=1 and restart cezar to turn the inbox on."
            heading="h2"
          />
        ) : todos === undefined ? (
          todosQuery.isError ? (
            <CenteredState
              icon={<TriangleAlertIcon />}
              tone="danger"
              title="Could not load the inbox"
              subtitle={todosQuery.error.message}
              heading="h2"
            />
          ) : null
        ) : todos.length === 0 ? (
          // Not while health is still in flight: an inbox-less server answers `[]` too, so
          // claiming "empty" here would flash the very lie this route exists to avoid, then
          // correct itself. Keyed on `isPending` rather than `data === undefined` so a health
          // request that *fails* still falls through to the empty state — an unreachable
          // /api/health must not leave this route blank forever.
          health.isPending ? null : (
            <CenteredState
              icon={<InboxIcon />}
              tone="neutral"
              title="Inbox empty"
              subtitle="Agents drop follow-up suggestions here when they finish a task."
              heading="h2"
            />
          )
        ) : (
          <ul data-slot="todo-list" className="mx-auto flex w-full max-w-3xl flex-col gap-2.5">
            {todos.map((todo) => (
              <TodoCard
                key={todo.id}
                todo={todo}
                sourceTaskExists={
                  todo.taskId === undefined
                    ? null
                    : (runs.data?.some((run) => run.id === todo.taskId) ?? false)
                }
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function TodoCard({
  todo,
  /** null: no source task at all; false: it existed once but was deleted. */
  sourceTaskExists,
}: {
  todo: TodoItem
  sourceTaskExists: boolean | null
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const uiState = useUiState()

  // Per card, not per route (#401): each card starts its OWN run, so "run this one on codex"
  // must not silently re-aim the card below it. Reset is free — a started card leaves the list.
  // `account` stays null here: this card posts to `POST /todos/:id/start`, which has no
  // `agentProfile` field, so `EnginePills` is mounted without `accounts` and never sets one.
  const [engine, setEngine] = useState<EnginePick>({ runner: null, model: null, account: null })
  const resolved = useResolvedEngine(engine)

  // "Add instructions" (#413): collapsed by default, local to the card (see the doc block
  // above for why nothing here needs to persist across a reload).
  const [notesOpen, setNotesOpen] = useState(false)
  const [notes, setNotes] = useState('')
  const notesRef = useRef<HTMLTextAreaElement>(null)
  const templates = normalizePromptTemplates(uiState.data?.promptTemplates)
  const insertNotesTemplate = (snippet: string) => {
    const el = notesRef.current
    const caret = el?.selectionStart ?? notes.length
    const result = insertTemplate(notes, caret, snippet)
    setNotes(result.text)
    requestAnimationFrame(() => {
      notesRef.current?.focus()
      notesRef.current?.setSelectionRange(result.caret, result.caret)
    })
  }

  const start = useMutation({
    // The engine pick (#401) and the "Add instructions" prompt (#413) ride the same Run: the
    // body rules live in engineBody so this surface and the GitHub tab cannot disagree, and the
    // trimmed note joins them as `prompt`. Both are optional — an untouched card on a
    // single-backend host with no note sends the bodyless POST this endpoint always has.
    mutationFn: async () => {
      if (!resolved.canRun) return null
      return startTodo(todo.id, {
        ...engineBody(resolved),
        prompt: notes.trim() || undefined,
      })
    },
    onSuccess: (result) => {
      if (result === null) return
      const { run } = result
      // The server rewrote todos.json (SSE will confirm); the invalidations just refuse to
      // wait for the file watcher's debounce.
      void queryClient.invalidateQueries({ queryKey: queryKeys.todos })
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
      void navigate(`/tasks/${run.id}`)
    },
    onError: (error) => toast(error.message, { tone: 'danger' }),
  })

  const dismiss = useMutation({
    mutationFn: () => removeTodo(todo.id),
    onSuccess: () => {
      // Drop the card now (the legacy local filter) — the SSE `todos` broadcast is the
      // authoritative confirmation moments later.
      queryClient.setQueryData<TodoItem[]>(queryKeys.todos, (existing) =>
        existing?.filter((item) => item.id !== todo.id),
      )
      void queryClient.invalidateQueries({ queryKey: queryKeys.todos })
    },
    onError: (error) => toast(error.message, { tone: 'danger' }),
  })

  const busy = start.isPending || dismiss.isPending
  const runnable = isTodoRunnable(todo)

  return (
    <li
      data-slot="todo-card"
      data-id={todo.id}
      className="flex flex-col gap-2.5 rounded-lg border border-border bg-card p-4 shadow-xs"
    >
      <div className="flex items-start gap-3">
        <StatusDot
          tone={CARD_ATTENTION.tone}
          pulse={CARD_ATTENTION.pulse}
          title={CARD_ATTENTION.label}
          className="mt-[5px]"
        />
        <div className="min-w-0 flex-1">
          <p data-slot="todo-summary" className="text-sm leading-snug font-medium text-foreground">
            {todo.summary}
          </p>
          <div
            data-slot="todo-meta"
            className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-soft-foreground"
          >
            {todo.ts ? <span>{shortAge(todo.ts)} ago</span> : null}
            {todo.action ? <span>{todo.action}</span> : null}
            {todo.taskId !== undefined ? (
              sourceTaskExists ? (
                <Link
                  to={`/tasks/${todo.taskId}`}
                  data-slot="todo-source"
                  className="text-muted-foreground underline decoration-border underline-offset-2 hover:text-foreground"
                >
                  source task
                </Link>
              ) : (
                <span data-slot="todo-source-gone">source task deleted</span>
              )
            ) : null}
            {/* href protocol guard (#431): link only for http(s) URLs. */}
            {isHttpUrl(todo.prUrl) ? (
              <a
                href={todo.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                data-slot="todo-pr"
                className="text-muted-foreground underline decoration-border underline-offset-2 hover:text-foreground"
              >
                PR
              </a>
            ) : null}
            {todo.suggestedSkill ? (
              <span data-slot="todo-skill" className="font-mono">
                skill: {todo.suggestedSkill}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 self-center">
          {runnable ? (
            <>
              <Button
                type="button"
                variant="contrast"
                size="sm"
                data-action="todo-run"
                title="Start a task from this follow-up"
                disabled={busy || !resolved.canRun}
                onClick={() => start.mutate()}
              >
                <PlayIcon aria-hidden="true" className="size-3" />
                Run
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-action="todo-dismiss"
                title="Check off (remove)"
                disabled={busy}
                onClick={() => dismiss.mutate()}
              >
                Dismiss
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="contrast"
              size="sm"
              data-action="todo-acknowledge"
              title="Acknowledge and remove this note"
              disabled={busy}
              onClick={() => dismiss.mutate()}
            >
              <CheckIcon aria-hidden="true" className="size-3" />
              Acknowledge
            </Button>
          )}
        </div>
      </div>

      {/* Only a runnable card gets pills (#401) — an acknowledge-only note has no run to aim.
          Indented under the summary, above the instructions composer, so the two per-card
          Run knobs (engine + prompt) read as one group. */}
      {runnable ? (
        <div data-slot="todo-engine" className="flex flex-wrap items-center gap-2 pl-5">
          <EnginePills pick={engine} onChange={setEngine} disabled={busy || !resolved.canRun} />
          {!resolved.providerPending && !resolved.canRun ? (
            <span
              data-slot="todo-provider-gate"
              className="inline-flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
            >
              {resolved.providerError
                ? 'Provider authentication could not be verified.'
                : 'Connect an agent provider to run this follow-up.'}
              <Link
                to="/settings/agents#providers"
                className="font-medium text-foreground underline underline-offset-4"
              >
                Configure providers
              </Link>
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Instructions are carried by Run, so they only make sense on a runnable
          follow-up (#440): a note-only entry has no Run to carry them, and a
          composer there would be a dead end. */}
      {runnable ? (
        notesOpen ? (
          <div data-slot="todo-instructions" className="flex flex-col gap-2 pl-5">
            <Textarea
              ref={notesRef}
              data-slot="todo-instructions-input"
              aria-label="Extra instructions for this follow-up"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Add instructions for the agent… (appended to the suggestion above)"
              // Same cap the server enforces on the `prompt` body field, so an over-long note is
              // stopped at the keystroke rather than by a 400 on Run (the Settings inputs cap the
              // same way).
              maxLength={20_000}
              className="min-h-16 text-[13px]"
            />
            <div className="flex items-center gap-2">
              <PromptTemplateMenu templates={templates} onInsert={insertNotesTemplate} />
              <button
                type="button"
                data-slot="todo-instructions-hide"
                onClick={() => setNotesOpen(false)}
                className="text-xs font-medium text-muted-foreground underline decoration-border underline-offset-2 hover:text-foreground"
              >
                Hide
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            data-slot="todo-instructions-toggle"
            onClick={() => setNotesOpen(true)}
            className="self-start pl-5 text-xs font-medium text-muted-foreground underline decoration-border underline-offset-2 hover:text-foreground"
          >
            {/* A collapsed composer keeps its draft, and Run still carries it — so say so
                rather than hiding instructions the next Run would silently send. */}
            {notes.trim() ? 'Edit instructions (added)' : '+ Add instructions'}
          </button>
        )
      ) : null}
    </li>
  )
}
