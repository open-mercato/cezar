import { useQueryClient } from '@tanstack/react-query'
import { ArrowDownIcon, ArrowLeftIcon, BotIcon, LoaderCircleIcon } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'

import {
  applyManagerChange,
  checkManager,
  decideManagerAction,
  managerKeys,
  markManagerRead,
  sendManagerMessage,
  stopManager,
  useManagerChat,
  useManagers,
  useUpdateManager,
} from '@/api/managers'
import { useHealth } from '@/api/queries'
import { CenteredState } from '@/components/centered-state'
import { Composer } from '@/components/composer/composer'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { MANAGER_COMMANDS, parseManagerCommand } from '@/lib/managers'
import { isNearBottom } from '@/routes/task-thread/thread-scroll'
import type { ManagerListResponse, ManagerMessage, ManagerSummary } from '@open-mercato/cezar-api-client'

import { ManagerMessageRow } from './manager-message'
import { ChronPicker, ModelPicker, ProjectsPicker, type ManagerPatch } from './manager-pickers'
import { ManagerSettings, pickModel } from './manager-settings'

/** Older history loads this far before the reader reaches the top. */
const HISTORY_SLACK_PX = 400

/** Per-manager drafts for the session: switching chats must not eat what was typed. */
const drafts = new Map<string, string>()

/**
 * The transcript's scrolling: follow the tail while pinned, keep the reader's place when older
 * pages land above it, and report whether the jump button should show.
 */
function useChatScroll(messages: readonly ManagerMessage[], onNearTop: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const previous = useRef<{ first: string | undefined; height: number }>({ first: undefined, height: 0 })
  const [away, setAway] = useState(false)

  useLayoutEffect(() => {
    const box = ref.current
    if (!box) return
    const first = messages[0]?.id
    const { first: lastFirst, height } = previous.current
    if (pinned.current) box.scrollTop = box.scrollHeight
    else if (lastFirst !== undefined && first !== lastFirst) box.scrollTop += box.scrollHeight - height
    previous.current = { first, height: box.scrollHeight }
  }, [messages])

  const onScroll = useCallback(() => {
    const box = ref.current
    if (!box) return
    pinned.current = isNearBottom(box, 80)
    setAway(!pinned.current)
    if (box.scrollTop < HISTORY_SLACK_PX) onNearTop()
  }, [onNearTop])

  const jump = useCallback(() => {
    const box = ref.current
    if (!box) return
    pinned.current = true
    setAway(false)
    box.scrollTop = box.scrollHeight
  }, [])

  return { ref, onScroll, jump, away }
}

/** Clear the unread count while the chat is really being looked at. */
function useMarkRead(manager: ManagerSummary) {
  const queryClient = useQueryClient()
  const { id, unread } = manager
  useEffect(() => {
    const mark = () => {
      if (unread === 0 || document.visibilityState !== 'visible') return
      queryClient.setQueryData<ManagerListResponse>(managerKeys.list, (list) => {
        const row = list?.managers.find((entry) => entry.id === id)
        return row ? applyManagerChange(list, id, { ...row, unread: 0 }, false) : list
      })
      void markManagerRead(id).catch(() => {})
    }
    mark()
    document.addEventListener('visibilitychange', mark)
    return () => document.removeEventListener('visibilitychange', mark)
  }, [id, queryClient, unread])
}

function ManagerChat({ manager }: { manager: ManagerSummary }) {
  const { id } = manager
  const chat = useManagerChat(id)
  const update = useUpdateManager(id)
  useMarkRead(manager)
  const [draft, setDraft] = useState(() => drafts.get(id) ?? '')
  const [deciding, setDeciding] = useState(false)
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = chat
  const loadOlder = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage()
  }, [fetchNextPage, hasNextPage, isFetchingNextPage])
  const scroll = useChatScroll(chat.messages, loadOlder)
  const origin = useMemo(() => ({ id, name: manager.name }), [id, manager.name])
  const working = manager.status === 'working'

  const onPatch = useCallback((patch: ManagerPatch) => {
    update.mutate(patch, { onError: (error) => toast(error.message, { tone: 'danger' }) })
  }, [update])

  const onDecide = useCallback((actionId: string, decision: 'approve' | 'reject') => {
    setDeciding(true)
    void decideManagerAction(id, actionId, decision)
      .catch((error: unknown) => toast(error instanceof Error ? error.message : String(error), { tone: 'danger' }))
      .finally(() => setDeciding(false))
  }, [id])

  const stop = useCallback(() => {
    void stopManager(id).catch((error: unknown) => toast(error instanceof Error ? error.message : String(error), { tone: 'danger' }))
  }, [id])

  const submit = async (text: string) => {
    const command = parseManagerCommand(text)
    scroll.jump()
    if (command?.name === 'stop') return stopManager(id)
    if (command?.name === 'check') {
      await checkManager(id)
      toast('Check started')
      return undefined
    }
    return sendManagerMessage(id, command?.prompt ?? text)
  }

  return (
    <div data-route="manager-chat" className="relative flex h-full min-h-0 flex-col">
      <header className="flex items-start gap-2 border-b border-border px-3 py-3 md:px-4">
        <Button asChild variant="ghost" size="icon" className="-ml-1 shrink-0 md:hidden">
          <Link to="/manager" aria-label="All managers">
            <ArrowLeftIcon aria-hidden="true" />
          </Link>
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-semibold tracking-tight">{manager.name}</h1>
          <ProjectsPicker value={manager.projects} onChange={(projects) => onPatch({ projects })} />
        </div>
        <ManagerSettings manager={manager} onPatch={onPatch} />
      </header>

      <div ref={scroll.ref} data-slot="manager-transcript" onScroll={scroll.onScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto flex w-full max-w-[860px] flex-col gap-5 px-4 py-6 md:px-6">
          {hasNextPage ? (
            <Button variant="ghost" size="sm" className="self-center" disabled={isFetchingNextPage} onClick={loadOlder}>
              {isFetchingNextPage ? 'Loading…' : 'Load earlier messages'}
            </Button>
          ) : null}
          {chat.isError ? (
            <p role="alert" className="text-center text-sm text-danger">{chat.error.message}</p>
          ) : null}
          {chat.messages.map((message) => (
            <ManagerMessageRow key={message.id} message={message} origin={origin} onDecide={onDecide} deciding={deciding} />
          ))}
        </div>
      </div>

      <div className="relative mx-auto w-full max-w-[860px] px-3 pb-2 md:px-6">
        {scroll.away ? (
          <button
            type="button"
            aria-label="Scroll to bottom"
            data-slot="manager-scroll-bottom"
            onClick={scroll.jump}
            className="absolute -top-12 left-1/2 flex size-9 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-background shadow-modal outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <ArrowDownIcon aria-hidden="true" className="size-4" />
          </button>
        ) : null}
        <Composer
          key={id}
          value={draft}
          onValueChange={(text) => {
            setDraft(text)
            drafts.set(id, text)
          }}
          onSubmit={submit}
          attachments={false}
          slashCommands={MANAGER_COMMANDS}
          placeholder="Type / for commands"
          ariaLabel={`Message ${manager.name}`}
          sendShortcut="↵"
          {...(working ? { stop: { label: 'Stop', onStop: stop } } : {})}
        />
        <div data-slot="manager-footer" className="mt-1 flex min-h-8 items-center justify-end gap-1 md:gap-3">
          <ChronPicker minutes={manager.cronMinutes} onChange={onPatch} />
          <ModelPicker {...pickModel(manager)} onChange={onPatch} />
          {working ? (
            <span role="status" aria-label="Working" className="flex">
              <LoaderCircleIcon aria-hidden="true" className="size-4 animate-spin text-info motion-reduce:animate-none" />
            </span>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export function ManagerChatRoute() {
  const { id = '' } = useParams()
  const enabled = useHealth().data?.capabilities.managers === true
  const managers = useManagers(enabled)
  const manager = managers.data?.managers.find((entry) => entry.id === id)
  if (manager) return <ManagerChat key={id} manager={manager} />
  if (managers.isError) return <CenteredState icon={<BotIcon aria-hidden="true" />} tone="danger" title="Managers are unavailable" subtitle={managers.error.message} />
  if (managers.data) {
    return (
      <CenteredState
        icon={<BotIcon aria-hidden="true" />}
        title="This manager no longer exists"
        actions={<Button asChild variant="outline"><Link to="/manager">Back to managers</Link></Button>}
      />
    )
  }
  return <p role="status" className="p-6 text-sm text-muted-foreground">Loading…</p>
}
