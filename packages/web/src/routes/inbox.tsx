import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckIcon, InboxIcon, PlayIcon, PlusIcon, TriangleAlertIcon } from 'lucide-react'
import { useRef, useState } from 'react'
import { Link, useNavigate } from '@/lib/project-router'

import { removeTodo, startTodo } from '@/api/client'
import { queryKeys, useHealth, useRuns, useTodos, useUiState } from '@/api/queries'
import type { TodoItem } from '@open-mercato/cezar-api-client'
import { EnginePills, engineBody, useResolvedEngine, useSeededEnginePick } from '@/components/engine-pills'
import { ListEmpty, ListFrame } from '@/components/list-view'
import { Page, PageBody, PageHeader } from '@/components/page'
import { PromptTemplateMenu } from '@/components/prompt-template-menu'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'
import { deriveAttention } from '@/lib/attention'
import { shortAge } from '@/lib/format'
import { availablePromptTemplates, insertTemplate, normalizePromptTemplates } from '@/lib/prompt-templates'
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

  const count = todos?.length ?? 0

  return (
    <Page data-route="inbox" width="narrow">
      <PageHeader
        title="Inbox"
        description={
          inboxOff
            ? 'Disabled for this server; per-task Notes still run.'
            : 'Follow-ups agents suggested when they finished a task.'
        }
        eyebrow={count > 0 ? `${count} waiting on you` : undefined}
      />

      <PageBody>
        {inboxOff ? (
          <ListEmpty
            icon={<InboxIcon />}
            title="The follow-up inbox is off"
            description="Agents are not asked to leave follow-ups. Set CEZ_FOLLOWUPS=1 and restart the service to turn the inbox on."
          />
        ) : todos === undefined ? (
          todosQuery.isError ? (
            <ListEmpty
              icon={<TriangleAlertIcon />}
              tone="danger"
              title="Could not load the inbox"
              description={todosQuery.error.message}
            />
          ) : (
            <InboxSkeleton />
          )
        ) : todos.length === 0 ? (
          // Not while health is still in flight: an inbox-less server answers `[]` too, so
          // claiming "empty" here would flash the very lie this route exists to avoid. Keyed on
          // `isPending` so a health request that *fails* still falls through to the empty state.
          health.isPending ? (
            <InboxSkeleton />
          ) : (
            <ListEmpty
              icon={<InboxIcon />}
              title="Inbox empty"
              description="Agents drop follow-up suggestions here when they finish a task."
            />
          )
        ) : (
          <ListFrame>
            <ul data-slot="todo-list" className="divide-y divide-border">
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
          </ListFrame>
        )}
      </PageBody>
    </Page>
  )
}

function InboxSkeleton() {
  return (
    <ListFrame aria-busy="true" className="divide-y divide-border">
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex items-center gap-4 px-5 py-4">
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-3/5" />
            <Skeleton className="h-3 w-1/3" />
          </div>
          <Skeleton className="h-8 w-16" />
        </div>
      ))}
    </ListFrame>
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
  // Seeded from the remembered pick but never writing back to it (#906), which keeps both rules:
  // an untouched card no longer falls through to the coding agent's own default model, and a pick
  // made on THIS card still cannot re-aim its neighbours.
  const [engine, setEngine] = useSeededEnginePick()
  const resolved = useResolvedEngine(engine)

  // "Add instructions" (#413): collapsed by default, local to the card (see the doc block
  // above for why nothing here needs to persist across a reload).
  const [notesOpen, setNotesOpen] = useState(false)
  const [notes, setNotes] = useState('')
  const notesRef = useRef<HTMLTextAreaElement>(null)
  const health = useHealth()
  const templates = availablePromptTemplates(
    normalizePromptTemplates(uiState.data?.promptTemplates),
    health.data?.capabilities,
  )
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
      className="flex flex-col gap-3 px-4 py-4 sm:px-5"
    >
      <div className="flex items-start gap-3">
        <StatusDot
          tone={CARD_ATTENTION.tone}
          pulse={CARD_ATTENTION.pulse}
          title={CARD_ATTENTION.label}
          className="mt-[7px]"
        />
        <div className="min-w-0 flex-1">
          <p data-slot="todo-summary" className="text-sm leading-relaxed font-medium text-pretty text-foreground">
            {todo.summary}
          </p>
          <div
            data-slot="todo-meta"
            className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted-foreground"
          >
            {todo.ts ? <span>{shortAge(todo.ts)} ago</span> : null}
            {todo.action ? <span>{todo.action}</span> : null}
            {todo.taskId !== undefined ? (
              sourceTaskExists ? (
                <Link
                  to={`/tasks/${todo.taskId}`}
                  data-slot="todo-source"
                  className="underline decoration-border underline-offset-4 hover:text-foreground"
                >
                  Source task
                </Link>
              ) : (
                <span data-slot="todo-source-gone">Source task deleted</span>
              )
            ) : null}
            {/* href protocol guard (#431): link only for http(s) URLs. */}
            {isHttpUrl(todo.prUrl) ? (
              <a
                href={todo.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                data-slot="todo-pr"
                className="underline decoration-border underline-offset-4 hover:text-foreground"
              >
                Pull request
              </a>
            ) : null}
            {todo.suggestedSkill ? (
              <span data-slot="todo-skill">
                Skill <span className="font-mono text-xs">{todo.suggestedSkill}</span>
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {runnable ? (
            <>
              <Button
                type="button"
                variant="default"
                size="sm"
                data-action="todo-run"
                title="Start a task from this follow-up"
                disabled={busy || !resolved.canRun}
                onClick={() => start.mutate()}
              >
                <PlayIcon aria-hidden="true" className="size-3.5" />
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
              variant="outline"
              size="sm"
              data-action="todo-acknowledge"
              title="Acknowledge and remove this note"
              disabled={busy}
              onClick={() => dismiss.mutate()}
            >
              <CheckIcon aria-hidden="true" className="size-3.5" />
              Acknowledge
            </Button>
          )}
        </div>
      </div>

      {/* Only a runnable card gets pills (#401) — an acknowledge-only note has no run to aim.
          Indented under the summary, above the instructions composer, so the two per-card
          Run knobs (engine + prompt) read as one group. */}
      {runnable ? (
        <div data-slot="todo-engine" className="flex flex-wrap items-center gap-2 pl-[19px]">
          <EnginePills pick={engine} onChange={setEngine} disabled={busy || !resolved.canRun} />
          {!resolved.providerPending && !resolved.canRun ? (
            <span
              data-slot="todo-provider-gate"
              className="inline-flex flex-wrap items-center gap-1 text-[13px] text-muted-foreground"
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
          <div data-slot="todo-instructions" className="flex flex-col gap-2 pl-[19px]">
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
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-slot="todo-instructions-hide"
                onClick={() => setNotesOpen(false)}
              >
                Hide
              </Button>
            </div>
          </div>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-slot="todo-instructions-toggle"
            onClick={() => setNotesOpen(true)}
            className="ml-2.5 self-start"
          >
            {/* A collapsed composer keeps its draft, and Run still carries it — so say so
                rather than hiding instructions the next Run would silently send. */}
            {notes.trim() ? null : <PlusIcon aria-hidden="true" />}
            {notes.trim() ? 'Edit instructions (added)' : 'Add instructions'}
          </Button>
        )
      ) : null}
    </li>
  )
}
