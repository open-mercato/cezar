import { useQueryClient } from '@tanstack/react-query'
import { ArrowDownIcon, ArrowLeftIcon, BotIcon, ListChecksIcon, LoaderCircleIcon, PanelRightIcon, PauseIcon, PlayIcon, RefreshCwIcon } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router'

import {
  applyManagerChange,
  checkManager,
  setManagerActive,
  decideManagerAction,
  getOldestPendingAction,
  managerChat,
  managerKeys,
  markManagerRead,
  sendManagerMessage,
  stopManager,
  trimManagerChat,
  useManagerChat,
  useManagers,
  useUpdateManager,
} from '@/api/managers'
import { useHealth, useProjects } from '@/api/queries'
import type { AttachmentEntry } from '@open-mercato/cezar-api-client'
import { MyMessagesPill } from '@/components/my-messages/my-messages-pill'
import { useShellManagerMode, useShellTasksTab } from '@/components/app-shell'
import { cachedAt } from '@/api/query-persist'
import { CacheStatusChip } from '@/components/cache-status'
import { CenteredState } from '@/components/centered-state'
import { StatusDot } from '@/components/status-dot'
import { Composer } from '@/components/composer/composer'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { ChatSkeleton, LoadingState } from '@/components/loading-state'
import { Spinner } from '@/components/ui/spinner'
import {
  cronLabel,
  inactiveSinceLabel,
  MANAGER_COMMANDS,
  managerReplyAnnouncement,
  needsYouCount,
  needsYouLabel,
  parseManagerCommand,
  liveAuthFailures,
  retryOf,
  streamingReply,
  turnKindLabel,
  watchingLine,
} from '@/lib/managers'
import { useKeyboardInsetVar } from '@/lib/keyboard-inset'
import { useMediaQuery } from '@/lib/use-media-query'
import { useNow } from '@/lib/use-now'
import { cn } from '@/lib/utils'
import { trackManagerMessageSent, trackManagerQuestionAnswered, useManagerChatOpened } from '@/lib/manager-telemetry'
import { isNearBottom } from '@/routes/task-thread/thread-scroll'
import { managerAccessOf, supersededAskIds, type ManagerListResponse, type ManagerMessage, type ManagerSummary, type PlanUsageProvider } from '@open-mercato/cezar-api-client'

import { useDismissStaleMerges, type DecideAction } from './manager-approval'
import { ManagerCompanion } from './manager-companion'
import { cameFromManagerList, FOCUS_COMPOSER, opensManagerSettings, shouldFocusComposer } from './manager-focus'
import { useManagerActivityActions } from './manager-activity'
import { ManagerAvatar } from './manager-avatar'
import { ManagerChatLoading, useHideShellTopBar } from './manager-loading'
import { ReconnectSurfaceContext, type ReconnectSurface } from '@/components/reconnect/surface'
import { answersShownOnCard, ManagerChatActionsContext, ManagerMessageRow, PrTitlesContext, usePrTitles, type ManagerChatActions } from './manager-message'
import { useManagerMyMessages } from './use-manager-my-messages'
import type { ManagerPatch } from './manager-pickers'
import { ManagerSettings, useCheckNow, type ManagerSettingsHandle } from './manager-settings'
import { ManagerListRail } from './manager-sidebar'
import { startedTaskCount, WatchingPanel, WatchingSheet } from './manager-watching'
import { ManagerLimitStrip, ManagerUsageChip, useManagerPlanUsage } from './manager-plan-usage'
import { PLAN_LIMIT_RUNNERS } from '@/lib/plan-usage'

/** Older history loads this far before the reader reaches the top. */
const HISTORY_SLACK_PX = 400

/** Send vanishes under the pointer and Stop slides into its place: a double-click must not stop
 *  the turn it just started. */
const STOP_AFTER_SEND_GUARD_MS = 600

/** What an empty draft offers on a phone, where typing `/` is slow (mobile spec, Composer). */

/** Per-manager drafts for the session: switching chats must not eat what was typed. */
const drafts = new Map<string, string>()

const PENDING_CARD = '[data-slot="manager-action"][data-status="pending"]'
const OPEN_QUESTION = '[data-slot="manager-ask"][data-resolved="false"]'

/** A per-viewer convenience: the Watching panel folded stays folded on this browser. */
const WATCHING_KEY = 'cez.manager.watching'

/** Below `lg` the panel is a sheet, open while the URL says so: Back and the edge swipe close it. */
const WATCHING_PARAM = 'watching'
const WATCHING_PUSHED = 'managerWatchingPushed'
/** Tailwind's `lg`: the column shows, so a `?watching=1` there must not mount the sheet's modal overlay. */
const WIDE_QUERY = '(min-width: 64rem)'

/**
 * The transcript's scrolling: follow the tail while pinned, keep the reader's place when older
 * pages land above it, and report whether the jump button should show.
 */
/** The row at the top of the box, for holding the reader's place; a gap between rows is skipped. */
function rowAtTop(box: HTMLElement): { row: Element; offset: number } | null {
  const body = box.firstElementChild
  // jsdom has no hit testing.
  if (!body || typeof document.elementFromPoint !== 'function') return null
  const { left, top, width, height } = box.getBoundingClientRect()
  for (const y of [top + 1, top + height / 4, top + height / 2]) {
    let hit = document.elementFromPoint(left + width / 2, y)
    while (hit && hit.parentElement !== body) hit = hit.parentElement
    if (hit) return { row: hit, offset: hit.getBoundingClientRect().top - top }
  }
  return null
}

/** A reader's place in each chat they left scrolled up, so a task opened from it comes back to it. */
const leftAt = new Map<string, number>()

export function forgetChatPlaces(): void {
  leftAt.clear()
}

function useChatScroll(id: string, messages: readonly ManagerMessage[], onNearTop: () => void) {
  const ref = useRef<HTMLElement>(null)
  const pinned = useRef(true)
  const restored = useRef(false)
  const previous = useRef<{ first: string | undefined; height: number }>({ first: undefined, height: 0 })
  const [away, setAway] = useState(false)
  // A reader away from the tail keeps this row where it was. Older pages land above it and rows
  // above it grow after their first paint; a one-off height delta missed the second (#2038 walk).
  const anchor = useRef<{ row: Element; offset: number } | null>(null)
  /** The last scroll position seen, to tell the reader's scroll from a resize. */
  const lastTop = useRef(0)

  /** True when the anchor held the place; false leaves it to the caller's fallback. */
  const keepPlace = useCallback((box: HTMLElement) => {
    const held = anchor.current
    if (!held?.row.isConnected) return false
    const drift = held.row.getBoundingClientRect().top - box.getBoundingClientRect().top - held.offset
    if (Math.abs(drift) >= 1) box.scrollTop += drift
    return true
  }, [])

  useLayoutEffect(() => {
    const box = ref.current
    if (!box) return
    const first = messages[0]?.id
    const { first: lastFirst, height } = previous.current
    const saved = leftAt.get(id)
    if (!restored.current && messages.length > 0) {
      restored.current = true
      if (saved !== undefined) {
        pinned.current = false
        box.scrollTop = saved
        lastTop.current = box.scrollTop
        anchor.current = rowAtTop(box)
        setAway(true)
        previous.current = { first, height: box.scrollHeight }
        return
      }
    }
    if (pinned.current) box.scrollTop = box.scrollHeight
    else if (!keepPlace(box) && lastFirst !== undefined && first !== lastFirst) box.scrollTop += box.scrollHeight - height
    previous.current = { first, height: box.scrollHeight }
  }, [id, messages, keepPlace])

  // Rows grow after their first paint (markdown, session cards): a pinned reader stays at the
  // tail, any other keeps its row.
  useEffect(() => {
    const box = ref.current
    const content = box?.firstElementChild
    if (!box || !content) return undefined
    const observer = new ResizeObserver(() => {
      if (pinned.current) box.scrollTop = box.scrollHeight
      else keepPlace(box)
    })
    // Border box: the room kept under the floating button is padding, which a content box ignores.
    observer.observe(content, { box: 'border-box' })
    // The box shrinks too, when the chips come back for an empty draft.
    observer.observe(box)
    return () => observer.disconnect()
  }, [keepPlace])

  // Off-screen rows skip rendering (a 1,500-row stream: 77% -> 37% main thread), but only once
  // laid out: `auto` then remembers their real height, so scrolling up into them cannot jump.
  useEffect(() => {
    const box = ref.current
    const body = box?.firstElementChild
    if (!box || !body) return undefined
    let frame = requestAnimationFrame(() => {
      // The second frame: the first one recorded the sizes.
      frame = requestAnimationFrame(() => {
        const { top, bottom } = box.getBoundingClientRect()
        for (const row of body.querySelectorAll<HTMLElement>(':scope > :not([data-sized])')) {
          // Chrome blanks an on-screen row for a frame when it turns `auto`: CLS 0.56 on a cold
          // deep link. It is marked once a later page or message finds it off screen.
          const rect = row.getBoundingClientRect()
          if (rect.bottom < top || rect.top > bottom) row.dataset.sized = ''
        }
      })
    })
    return () => cancelAnimationFrame(frame)
    // Rows arrive only as the count grows; a streamed delta adds none.
  }, [messages.length])

  const onScroll = useCallback(() => {
    const box = ref.current
    if (!box) return
    // Only the reader scrolls up. A pinned box a growing composer shrank reads far from the tail
    // without having moved up: a resize, not the reader leaving (#2038 walk, phone attachments).
    const up = box.scrollTop < lastTop.current - 1
    if (pinned.current && !up && !isNearBottom(box, 80)) box.scrollTop = box.scrollHeight
    lastTop.current = box.scrollTop
    pinned.current = isNearBottom(box, 80)
    anchor.current = pinned.current ? null : rowAtTop(box)
    if (pinned.current) leftAt.delete(id)
    else leftAt.set(id, box.scrollTop)
    setAway(!pinned.current)
    if (box.scrollTop < HISTORY_SLACK_PX) onNearTop()
  }, [id, onNearTop])

  const jump = useCallback(() => {
    const box = ref.current
    if (!box) return
    pinned.current = true
    anchor.current = null
    leftAt.delete(id)
    setAway(false)
    box.scrollTop = box.scrollHeight
  }, [id])

  // The keyboard shrinks the box, which the content's ResizeObserver cannot see.
  const restick = useCallback(() => {
    const box = ref.current
    if (box && pinned.current) box.scrollTop = box.scrollHeight
  }, [])

  /** Bring one card to the reader and hand it focus. False until its page has rendered. */
  const reveal = useCallback((find: (box: HTMLElement) => HTMLElement | undefined) => {
    const box = ref.current
    const card = box && find(box)
    if (!box || !card) return false
    pinned.current = false
    card.scrollIntoView({ block: 'center' })
    // Before its scroll event: a row growing meanwhile must not pull the reader back.
    anchor.current = rowAtTop(box)
    card.focus({ preventScroll: true })
    return true
  }, [])

  /** Unpin and park one row `inset` px below the top — a "your messages" jump. */
  const revealAt = useCallback((row: HTMLElement, inset: number) => {
    const box = ref.current
    if (!box) return
    pinned.current = false
    box.scrollTop += row.getBoundingClientRect().top - box.getBoundingClientRect().top - inset
    lastTop.current = box.scrollTop
    // Before its scroll event: a row growing meanwhile must not pull the reader back.
    anchor.current = rowAtTop(box)
    leftAt.set(id, box.scrollTop)
    setAway(true)
  }, [id])

  return { ref, onScroll, jump, restick, reveal, revealAt, away }
}

/**
 * One polite line per reply that settles while the chat is open: a live region on the stream would
 * read every frame, and history that loads is not news.
 */
function ReplyAnnouncer({ messages, name }: { messages: readonly ManagerMessage[]; name: string }) {
  const streaming = useRef(new Set<string>())
  const [said, setSaid] = useState('')
  useEffect(() => {
    for (const message of messages) {
      if (message.kind !== 'assistant') continue
      if (message.streaming) streaming.current.add(message.id)
      else if (streaming.current.delete(message.id)) setSaid(managerReplyAnnouncement(name, message))
    }
  }, [messages, name])
  return <p role="status" data-slot="manager-announcer" className="sr-only">{said}</p>
}

/** How far the floating jump button reaches up into the transcript; 0 when it does not show. */
function useFloatingOverlap() {
  const ref = useRef<HTMLDivElement>(null)
  const [overlap, setOverlap] = useState(0)
  useLayoutEffect(() => {
    const row = ref.current
    if (!row) return undefined
    // `empty:hidden` makes an empty row 0 tall, so its size alone says whether anything floats.
    const read = () => setOverlap(Math.ceil(row.getBoundingClientRect().height))
    read()
    const observer = new ResizeObserver(read)
    observer.observe(row)
    return () => observer.disconnect()
  }, [])
  return { ref, overlap }
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

/**
 * The Needs-you strip's "Jump to first" (design, Proposal 10): the oldest waiting approval, paged
 * back with `before` until that card is loaded, else the first open question on screen.
 */
function useNeedsYouJump(
  manager: ManagerSummary,
  chat: ReturnType<typeof useManagerChat>,
  scroll: ReturnType<typeof useChatScroll>,
) {
  const { id, pendingActions } = manager
  const { reveal, ref } = scroll
  const [target, setTarget] = useState<string>()
  const [jumping, setJumping] = useState(false)
  const busy = useRef(false)

  // After the commit that rendered the page: a fetch resolves before its rows exist.
  useEffect(() => {
    if (target && reveal((box) => [...box.querySelectorAll<HTMLElement>(PENDING_CARD)].find((card) => card.dataset.actionId === target))) setTarget(undefined)
  }, [chat.messages, reveal, target])

  const jump = async () => {
    if (busy.current) return
    if (pendingActions === 0) {
      reveal((box) => box.querySelector<HTMLElement>(OPEN_QUESTION) ?? undefined)
      return
    }
    busy.current = true
    setJumping(true)
    try {
      const oldest = await getOldestPendingAction(id)
      if (!oldest) return
      let loaded: Pick<typeof chat, 'data' | 'hasNextPage'> = chat
      while (ref.current && loaded.hasNextPage && !managerChat(loaded.data).some((message) => message.id === oldest.id)) {
        loaded = await chat.fetchNextPage({ throwOnError: true })
      }
      setTarget(oldest.id)
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
    } finally {
      busy.current = false
      setJumping(false)
    }
  }

  // Waits for the first page: with none loaded there is no `before` to page back from.
  return { ready: chat.data !== undefined, jump, jumping }
}

/** The chat's anchor for "take me to what is waiting" (manager heads link here). */
export const NEEDS_YOU_HASH = '#needs-you'

const RECOVERY_FIRST_MS = 2_000
const RECOVERY_MAX_MS = 30_000

/**
 * A transcript that never loaded tries again by itself: on a backoff, when the tab comes back and
 * when the network does. The stream's reconnect cannot help it — it only refreshes a chat with data.
 */
function useChatRecovery(chat: ReturnType<typeof useManagerChat>, id: string) {
  // A restored copy whose refresh failed retries the same way an empty chat does.
  const failed = chat.isError && (chat.data === undefined || cachedAt(managerKeys.messages(id)) !== undefined)
  const { refetch } = chat
  useEffect(() => {
    if (!failed) return undefined
    const retry = () => { void refetch() }
    let delay = RECOVERY_FIRST_MS
    let timer: ReturnType<typeof setTimeout>
    const schedule = () => {
      timer = setTimeout(() => {
        retry()
        delay = Math.min(delay * 2, RECOVERY_MAX_MS)
        schedule()
      }, delay)
    }
    schedule()
    const onVisible = () => {
      if (document.visibilityState === 'visible') retry()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', retry)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', retry)
    }
  }, [failed, refetch])
}

/**
 * The phone sheet's open state lives in history: opening pushes `?watching=1`, so the system Back
 * (Android, the iOS edge swipe) pops it shut instead of leaving the chat. Closing from the sheet
 * pops our own entry, or drops the param in place when the URL arrived with it.
 */
function useWatchingSheet(): [boolean, (open: boolean) => void] {
  const location = useLocation()
  const navigate = useNavigate()
  const open = new URLSearchParams(location.search).get(WATCHING_PARAM) === '1'
  const pushed = (location.state as Record<string, unknown> | null)?.[WATCHING_PUSHED] === true
  const set = useCallback((next: boolean) => {
    const params = new URLSearchParams(location.search)
    if (next === open) return
    if (next) {
      if (document.activeElement instanceof HTMLElement && document.activeElement.matches('input, textarea, [contenteditable=true]')) document.activeElement.blur()
      params.set(WATCHING_PARAM, '1')
      const state = { ...(location.state as Record<string, unknown> | null), [WATCHING_PUSHED]: true }
      void navigate({ pathname: location.pathname, search: `?${params}` }, { state })
    } else if (pushed) {
      void navigate(-1)
    } else {
      params.delete(WATCHING_PARAM)
      const search = params.toString()
      void navigate({ pathname: location.pathname, search: search ? `?${search}` : '' }, { replace: true, state: location.state })
    }
  }, [location.pathname, location.search, location.state, navigate, open, pushed])
  return [open, set]
}

const watchingListeners = new Set<() => void>()

function readWatchingPref(): boolean {
  try {
    return localStorage.getItem(WATCHING_KEY) !== '0'
  } catch {
    return true
  }
}

/** The Watching panel's fold, remembered per browser; a storage that throws reads as open. */
function useWatchingOpen(): [boolean, (open: boolean) => void] {
  const open = useSyncExternalStore(
    (notify) => {
      watchingListeners.add(notify)
      return () => watchingListeners.delete(notify)
    },
    readWatchingPref,
    () => true,
  )
  const set = useCallback((next: boolean) => {
    try {
      localStorage.setItem(WATCHING_KEY, next ? '1' : '0')
    } catch {
      // Private window or blocked storage: the fold still works for this render tree.
    }
    watchingListeners.forEach((notify) => notify())
  }, [])
  return [open, set]
}

/** The phone's ←: back to the list it came from, else the list in this chat's place. A push
 *  made the system Back reopen the chat just left (round-3 review). */
function BackToList() {
  const navigate = useNavigate()
  const { state } = useLocation()
  const fromList = cameFromManagerList(state)
  return (
    <Button asChild variant="ghost" size="icon" className="size-11 shrink-0 md:hidden">
      <Link
        to="/manager?all=1"
        replace
        aria-label="All managers"
        onClick={(event) => {
          if (!fromList || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
          event.preventDefault()
          void navigate(-1)
        }}
      >
        <ArrowLeftIcon aria-hidden="true" />
      </Link>
    </Button>
  )
}

function WorkingSpinner({ label }: { label: string }) {
  return (
    <span role="status" aria-label="Working" title={label ? `Working on ${label}` : undefined} data-slot="manager-working" className="flex shrink-0">
      <LoaderCircleIcon aria-hidden="true" className="size-4 animate-spin text-info motion-reduce:animate-none" />
    </span>
  )
}

/** The header's sub line while inactive: since when, and what is paused. */
function inactiveLine(manager: ManagerSummary): string {
  const jobs = manager.jobs.filter((job) => job.enabled).length
  const paused = [jobs > 0 ? `${jobs} ${jobs === 1 ? 'job' : 'jobs'}` : '', manager.cronMinutes > 0 ? `checks every ${cronLabel(manager.cronMinutes)}` : ''].filter(Boolean).join(' and ')
  return `${inactiveSinceLabel(manager).replace(' · since', ' since')}${paused ? ` · ${paused} paused` : ''}`
}

function ManagerChat({ manager }: { manager: ManagerSummary }) {
  const { id } = manager
  const chat = useManagerChat(id)
  const registry = useProjects().data?.projects
  const connected = useMemo(
    () => (registry ?? []).filter((project) => manager.connectedProjectIds.includes(project.id)),
    [registry, manager.connectedProjectIds],
  )
  const update = useUpdateManager(id)
  useChatRecovery(chat, id)
  useMarkRead(manager)
  useHideShellTopBar()
  useManagerChatOpened(id)
  const queryClient = useQueryClient()
  // Coming back re-mounts every cached row: 2.4 s for 1,500. Older pages reload on scroll. A
  // reader left scrolled up keeps them, or their place would not be there to come back to.
  useEffect(() => () => { if (!leftAt.has(id)) trimManagerChat(queryClient, id) }, [id, queryClient])
  const location = useLocation()
  // Read once: Composer's autoFocus is mount-only, and a later render must not re-ask.
  const [focusComposer] = useState(() => shouldFocusComposer(location.state))
  const [draft, setDraft] = useState(() => drafts.get(id) ?? '')
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = chat
  const loadOlder = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage()
  }, [fetchNextPage, hasNextPage, isFetchingNextPage])
  const scroll = useChatScroll(id, chat.messages, loadOlder)
  const returnedDecision = useRef('')
  useEffect(() => {
    if (!location.hash.startsWith('#decision-') || returnedDecision.current === location.key) return
    let target: string
    try { target = decodeURIComponent(location.hash.slice(1)) } catch { return }
    if (scroll.reveal((box) => Array.from(box.querySelectorAll<HTMLElement>('[id]')).find((node) => node.id === target))) {
      returnedDecision.current = location.key
    } else if (hasNextPage) loadOlder()
  }, [location.hash, location.key, chat.messages, hasNextPage, loadOlder, scroll.reveal])
  useKeyboardInsetVar(scroll.restick)
  // Recovery unmounts Retry: a keyboard user who was on it lands in the transcript, not on <body>.
  const retryFocused = useRef(false)
  useEffect(() => {
    if (chat.isError || !retryFocused.current) return
    retryFocused.current = false
    document.querySelector<HTMLElement>('[data-slot="manager-transcript"]')?.focus({ preventScroll: true })
  }, [chat.isError])
  const origin = useMemo(() => ({ id, name: manager.name }), [id, manager.name])
  const prTitles = usePrTitles(chat.messages)
  const working = manager.status === 'working'
  const onCard = useMemo(() => answersShownOnCard(chat.messages), [chat.messages])
  const superseded = useMemo(() => supersededAskIds(chat.messages), [chat.messages])
  // "Your messages" (spec 2026-11-17-my-message-navigation): the ↓ button grows into ▲ · 💬 · ▼ | ↓.
  const myMessages = useManagerMyMessages({
    id,
    messages: chat.messages,
    onCard,
    hasNextPage: Boolean(hasNextPage),
    fetchNextPage,
    scrollRef: scroll.ref,
    away: scroll.away,
    revealAt: scroll.revealAt,
  })
  // A waiting card is answered from the card or the composer; a chip would answer it with a command.
  const questionOpen = chat.messages.some((message) => message.kind === 'assistant' && message.ask !== undefined && message.askAnswer === undefined && message.askClosed === undefined && !superseded.has(message.id))
  const asking = manager.pendingActions > 0 || questionOpen
  const now = useNow(30_000)
  const usageRunner = manager.runner ?? 'claude'
  const usageProvider = PLAN_LIMIT_RUNNERS.has(usageRunner) ? (usageRunner as PlanUsageProvider) : null
  const planUsage = useManagerPlanUsage({ managerId: id, provider: usageProvider, agentProfile: manager.agentProfile }, chat.messages, now)
  const usageProps = usageProvider ? { usage: planUsage.usage, account: planUsage.account, provider: usageProvider, now } : null
  const subline = watchingLine({
    names: connected.map((project) => project.name),
    access: connected.map((project) => managerAccessOf(manager, project.id)),
    cronMinutes: manager.cronMinutes,
    nextCheckAt: manager.nextCheckAt,
    now: new Date(now),
  })
  const checkNow = useCheckNow(id)
  const settings = useRef<ManagerSettingsHandle>(null)
  // Spec 2026-11-19-manager-deactivate: a banner, Check now off, and a send that asks first.
  const inactive = manager.inactive !== undefined
  const activity = useManagerActivityActions()
  // A sidebar row's Settings… lands here with the gear menu to open, once.
  const navigateOnce = useNavigate()
  useEffect(() => {
    if (!opensManagerSettings(location.state)) return
    settings.current?.openMenu()
    navigateOnce({ pathname: location.pathname, search: location.search, hash: location.hash }, { replace: true, state: null })
  }, [location.key]) // once per arrival
  const [watchingOpen, setWatchingOpen] = useWatchingOpen()
  const watchingId = `manager-watching-${id}`
  const [sheetParam, setSheetOpen] = useWatchingSheet()
  // The bottom bar's Tasks is the one way in: no column, and the sheet at every width (a tablet).
  const tasksTab = useShellTasksTab()
  // CezarBot's bar is there at every width; a phone PWA's only below `md`.
  const barEverywhere = tasksTab?.everyWidth === true
  const wide = useMediaQuery(WIDE_QUERY) && !barEverywhere
  const sheetOpen = sheetParam && !wide
  const startedCount = useMemo(() => startedTaskCount(chat.messages), [chat.messages])
  const openSheet = useRef(setSheetOpen)
  openSheet.current = setSheetOpen
  useEffect(() => {
    tasksTab?.publish({ count: startedCount, expanded: sheetOpen, open: () => openSheet.current(true) })
  }, [tasksTab, startedCount, sheetOpen])
  useEffect(() => () => tasksTab?.publish(null), [tasksTab])

  const onPatch = useCallback((patch: ManagerPatch) => {
    update.mutate(patch, { onError: (error) => toast(error.message, { tone: 'danger' }) })
  }, [update])

  const onDecide = useCallback<DecideAction>((actionId, decision, opts) => decideManagerAction(id, actionId, decision, opts), [id])
  useDismissStaleMerges(chat.messages, onDecide)
  const needsYou = useNeedsYouJump(manager, chat, scroll)
  const floating = useFloatingOverlap()
  const waiting = needsYouCount(manager)
  // `#needs-you` (a manager head's "Open chat") lands on the first waiting card, once.
  const navigateChat = useNavigate()
  const wantsJump = location.hash === NEEDS_YOU_HASH
  useEffect(() => {
    if (!wantsJump || !needsYou.ready) return
    if (waiting > 0) void needsYou.jump()
    navigateChat({ pathname: location.pathname, search: location.search }, { replace: true, state: location.state })
  }, [wantsJump, needsYou.ready]) // once per arrival: the hash is cleared right after

  // What a card can ask of the chat: the gear, opened on the account picker.
  const confirmActivity = activity.confirmActivity
  const chatActions = useMemo<ManagerChatActions>(() => ({
    switchAccount: () => settings.current?.openAccount(),
    ...(inactive ? { confirmReactivate: async (answer: string) => (await confirmActivity({ kind: 'answer', manager, answer })) !== null } : {}),
  }), [inactive, confirmActivity, manager])
  const authLive = useMemo(() => liveAuthFailures(chat.messages), [chat.messages])
  // "Use <other> instead" on a reconnect card: the manager's own account, then the failed turn again.
  const latestMessages = useRef(chat.messages)
  latestMessages.current = chat.messages
  const reconnectSurface = useMemo<ReconnectSurface>(() => ({
    kind: 'manager',
    ownId: id,
    switchTo: async (agentProfile: string) => {
      await update.mutateAsync({ agentProfile })
      const failed = retryOf(latestMessages.current)
      if (failed) await sendManagerMessage(id, failed.text, [])
    },
  }), [id, update])

  const lastSent = useRef(0)
  const stop = useCallback(() => {
    if (Date.now() - lastSent.current < STOP_AFTER_SEND_GUARD_MS) return
    void stopManager(id).catch((error: unknown) => toast(error instanceof Error ? error.message : String(error), { tone: 'danger' }))
  }, [id])

  const deliver = async (text: string, attachments: AttachmentEntry[], via: 'composer' | 'chip') => {
    // A command takes no files, so a message that has them is a message.
    const command = attachments.length > 0 ? null : parseManagerCommand(text)
    // A message to an inactive manager wakes it, so it asks first; a cancel hands the draft back.
    const reactivate = inactive && command?.name !== 'stop'
    if (reactivate && !(await activity.confirmActivity({ kind: command?.name === 'check' ? 'check' : 'send', manager }))) {
      throw new Error(`Not sent: ${manager.name} is still inactive.`)
    }
    scroll.jump()
    lastSent.current = Date.now()
    if (command?.name === 'stop') return stopManager(id)
    if (command?.name === 'check') {
      // Reactivating with Catch me up is exactly one forced check; a plain check would 409 while inactive.
      await (reactivate ? setManagerActive(id, true, { catchUp: true }) : checkManager(id))
      toast('Check started')
      return undefined
    }
    const sent = await sendManagerMessage(id, command?.prompt ?? text, attachments, undefined, reactivate ? { reactivate: true } : undefined)
    trackManagerMessageSent(via, attachments.length > 0)
    // The next message answers an open card, whatever it says (spec 2026-10-31-managers, Questions).
    if (questionOpen) trackManagerQuestionAnswered('typed')
    return sent
  }
  const submit = (text: string, attachments: AttachmentEntry[]) => deliver(text, attachments, 'composer')

  // A chip stays drawn after a tap, so a double tap must not spend a second turn.
  const sendChip = (prompt: string) => {
    if (Date.now() - lastSent.current < STOP_AFTER_SEND_GUARD_MS) return
    void deliver(prompt, [], 'chip').catch((error: unknown) => toast(error instanceof Error ? error.message : String(error), { tone: 'danger' }))
  }
  const quickPrompts = manager.quickPrompts ?? []
  const retry = useMemo(() => (working ? undefined : retryOf(chat.messages)), [working, chat.messages])
  const resend = useCallback((text: string) => {
    void sendManagerMessage(id, text, []).catch((error: unknown) => toast(error instanceof Error ? error.message : String(error), { tone: 'danger' }))
  }, [id])

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
    {/* `--kb` is the iOS lift; the shell's bottom safe-area row already sits under the keyboard. */}
    <div data-route="manager-chat" className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col pb-[max(0px,calc(var(--kb,0px)-env(safe-area-inset-bottom)))]">
      {/* One row on a phone (spec, Phones); the sub line, Check now and the panel fold are desktop. */}
      <header className="flex items-center gap-3 border-b border-border bg-card px-3 py-2.5 max-md:box-content max-md:h-13 max-md:gap-1 max-md:px-1 max-md:py-0 max-md:pt-[env(safe-area-inset-top)] md:px-5">
        <BackToList />
        {/* Avatar-sized so it fits the 52 px phone bar (h-13) and centres on the title rows. */}
        {inactive ? (
          <ManagerAvatar avatar={manager.avatar} mascot={manager.mascot} inactive className="size-10 self-center md:size-11" sizes="44px" />
        ) : (
          <ManagerCompanion manager={manager} messages={chat.messages} className="size-10 self-center md:size-11" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <h1 className="truncate text-body font-semibold md:text-base">{manager.name}</h1>
            {working ? <WorkingSpinner label={turnKindLabel(streamingReply(chat.messages))} /> : null}
          </div>
          <p data-slot="manager-watching-line" className="truncate text-xs text-muted-foreground max-md:hidden">{inactive ? inactiveLine(manager) : subline}</p>
          {inactive ? <p className="text-xs text-muted-foreground md:hidden">Inactive</p> : null}
          <CacheStatusChip queryKey={managerKeys.messages(id)} isFetching={chat.isFetching} isError={chat.isError} className="mt-0.5 max-w-full" />
        </div>
        {usageProps ? <ManagerUsageChip {...usageProps} /> : null}
        <Button variant="outline" size="sm" className="max-md:hidden" data-slot="manager-check-now" disabled={inactive} title={inactive ? 'Reactivate to check' : undefined} onClick={checkNow}>
          <RefreshCwIcon aria-hidden="true" className="size-3.5" />
          Check now
        </Button>
        {barEverywhere ? null : <Button
          variant="ghost"
          size="icon-sm"
          className="max-lg:hidden"
          aria-label="Watching panel"
          aria-expanded={watchingOpen}
          aria-controls={watchingId}
          data-slot="manager-watching-toggle"
          onClick={() => setWatchingOpen(!watchingOpen)}
        >
          <PanelRightIcon aria-hidden="true" />
        </Button>}
        {barEverywhere ? null : <Button
          variant="ghost"
          size="icon"
          className={cn('relative shrink-0 max-md:size-11 lg:hidden', tasksTab && 'max-md:hidden')}
          aria-label={startedCount > 0 ? `Tasks and watching, ${startedCount} tasks` : 'Tasks and watching'}
          aria-haspopup="dialog"
          aria-expanded={sheetOpen}
          data-slot="manager-watching-sheet-toggle"
          onClick={() => setSheetOpen(true)}
        >
          <ListChecksIcon aria-hidden="true" />
          {startedCount > 0 ? (
            <span aria-hidden="true" className="absolute top-1.5 right-1.5 flex size-4 items-center justify-center rounded-full bg-primary text-micro font-semibold text-primary-foreground tabular-nums">
              {startedCount}
            </span>
          ) : null}
        </Button>}
        <ManagerSettings ref={settings} manager={manager} onPatch={onPatch} />
      </header>

      {inactive ? (
        <div data-slot="manager-inactive-banner" role="status" className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-border bg-muted/70 px-3 py-2 text-sm md:flex-nowrap md:px-5">
          <PauseIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-semibold">Inactive</span>
          <span className="min-w-0 basis-full text-muted-foreground max-md:order-last md:basis-auto md:truncate">No checks, jobs or model calls. Its tasks keep running; their cards still arrive here.</span>
          <Button size="sm" className="ml-auto shrink-0 pointer-coarse:min-h-11" data-slot="manager-reactivate" onClick={() => void activity.reactivate(manager)}>
            <PlayIcon aria-hidden="true" />
            Reactivate…
          </Button>
        </div>
      ) : null}

      {waiting > 0 ? (
        // Replaces the floating "N approvals waiting" pill (design, Proposal 10).
        <div data-slot="manager-needs-you" role="region" aria-label="Needs you" className="flex items-center gap-2.5 border-b border-border bg-info/10 px-3 py-2 text-sm md:px-5">
          <StatusDot tone="info" />
          <span className="font-semibold">Needs you</span>
          <span data-slot="manager-needs-you-count" className="min-w-0 truncate text-muted-foreground">{needsYouLabel(manager)}</span>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto shrink-0"
            data-slot="manager-needs-you-jump"
            disabled={!needsYou.ready || needsYou.jumping}
            onClick={() => void needsYou.jump()}
          >
            Jump to first
          </Button>
        </div>
      ) : null}

      {/* Focusable so a keyboard can scroll it; the announcer below speaks for it, not every frame.
          `relative`: a row's `sr-only` text is positioned in here, or it stretches the shell's
          scroller below the composer. */}
      <section
        ref={scroll.ref}
        data-slot="manager-transcript"
        aria-label={`Conversation with ${manager.name}`}
        tabIndex={0}
        onScroll={scroll.onScroll}
        className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain outline-none [overflow-anchor:none] focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset"
      >
        {/* The floating jump button sits over the tail: room for exactly it, at any width. */}
        <div
          data-slot="manager-transcript-body"
          className="mx-auto flex w-full max-w-[860px] flex-col gap-5 px-4 pt-6 pb-6 md:px-6 *:[contain-intrinsic-size:auto_160px] [&>[data-sized]]:[content-visibility:auto]"
          style={floating.overlap > 0 ? { paddingBottom: `calc(1.5rem + ${floating.overlap}px)` } : undefined}
        >
          {hasNextPage ? (
            <Button variant="ghost" size="sm" className="self-center" disabled={isFetchingNextPage} aria-busy={isFetchingNextPage || undefined} onClick={loadOlder}>
              {isFetchingNextPage ? <Spinner /> : null}
              Load earlier messages
            </Button>
          ) : null}
          {chat.isError ? (
            <div data-slot="manager-chat-error" className="flex flex-col items-center gap-2">
              <p role="alert" className="text-center text-sm text-danger">{chat.error.message}</p>
              <Button
                variant="outline"
                size="sm"
                className="pointer-coarse:h-11"
                // aria-disabled, not disabled: a disabled button drops keyboard focus on every retry.
                aria-disabled={chat.isFetching || undefined}
                aria-busy={chat.isFetching || undefined}
                onFocus={() => { retryFocused.current = true }}
                onBlur={() => { retryFocused.current = false }}
                // An older page that failed keeps the loaded ones: only it is asked again.
                onClick={() => {
                  if (chat.isFetching) return
                  if (chat.data === undefined) void chat.refetch()
                  else loadOlder()
                }}
              >
                {chat.isFetching ? <Spinner /> : null}
                Retry
              </Button>
            </div>
          ) : null}
          {/* No reveal delay: the header is already real, and an invisible placeholder is a blank frame. */}
          {chat.isPending ? <LoadingState label="Loading messages…" delayMs={0}><ChatSkeleton /></LoadingState> : null}
          {chat.isSuccess && chat.messages.length === 0 ? (
            <p data-slot="manager-empty" className="py-10 text-center text-sm text-muted-foreground">
              Ask {manager.name} what needs you, or to start something.
            </p>
          ) : null}
          <ManagerChatActionsContext.Provider value={chatActions}>
            <ReconnectSurfaceContext.Provider value={reconnectSurface}>
            <PrTitlesContext.Provider value={prTitles}>
              {chat.messages.map((message, index) => (onCard.has(message.id) ? null : (
                <ManagerMessageRow
                  key={message.id}
                  message={message}
                  origin={origin}
                  onDecide={onDecide}
                  projects={connected}
                  superseded={superseded.has(message.id)}
                  authLive={authLive.has(message.id)}
                  {...(usageProvider ? { planUsage: planUsage.replies.get(message.id) } : {})}
                  answerOnCard={onCard.has(chat.messages[index + 1]?.id ?? '')}
                  {...(retry?.messageId === message.id ? { onRetry: () => resend(retry.text) } : {})}
                />
              )))}
            </PrTitlesContext.Provider>
            </ReconnectSurfaceContext.Provider>
          </ManagerChatActionsContext.Provider>
        </div>
      </section>
      <ReplyAnnouncer messages={chat.messages} name={manager.name} />

      <div className="relative mx-auto w-full max-w-[860px] px-3 pb-2 md:px-6">
        <div ref={floating.ref} data-slot="manager-floating" className="pointer-events-none absolute inset-x-0 bottom-full flex justify-center gap-2 pb-2 *:pointer-events-auto empty:hidden">
          {scroll.away && myMessages.items.length > 0 ? <MyMessagesPill nav={myMessages} onLatest={scroll.jump} latestLabel="Scroll to bottom" latestSlot="manager-scroll-bottom" /> : null}
          {scroll.away && myMessages.items.length === 0 ? (
            <button
              type="button"
              aria-label="Scroll to bottom"
              data-slot="manager-scroll-bottom"
              onClick={scroll.jump}
              className="flex size-9 items-center justify-center rounded-full border border-border bg-background shadow-modal outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:size-11"
            >
              <ArrowDownIcon aria-hidden="true" className="size-4" />
            </button>
          ) : null}
        </div>
        {/* The user's own prompts (gear → Prompt buttons), plus the phone's Tasks chip; neither, no row and no room kept. */}
        {(quickPrompts.length > 0 || (startedCount > 0 && !tasksTab)) && draft.trim() === '' && !asking ? (
          // Scrolls sideways rather than wrapping: a narrow phone keeps one row above the composer.
          <div data-slot="manager-chips" className={cn('flex gap-1.5 overflow-x-auto pt-1 pb-2.5 [scrollbar-width:none]', quickPrompts.length === 0 && 'md:hidden')}>
            {startedCount > 0 && !tasksTab ? (
              // The thumb's way to the tasks: the header button sits out of reach (design: one thumb).
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-haspopup="dialog"
                data-slot="manager-chip-tasks"
                className="shrink-0 rounded-full pointer-coarse:h-11 pointer-coarse:px-4 md:hidden"
                onClick={() => setSheetOpen(true)}
              >
                <ListChecksIcon aria-hidden="true" />
                Tasks · {startedCount}
              </Button>
            ) : null}
            {quickPrompts.map(({ label, prompt }, index) => (
              <Button
                key={`${index}-${label}`}
                type="button"
                variant="outline"
                size="sm"
                title={prompt}
                className="shrink-0 rounded-full pointer-coarse:h-11 pointer-coarse:px-4"
                onClick={() => sendChip(prompt)}
              >
                {label}
              </Button>
            ))}
          </div>
        ) : null}
        {usageProps ? <ManagerLimitStrip {...usageProps} /> : null}
        <Composer
          key={id}
          dictation={false}
          autoFocus={focusComposer}
          value={draft}
          onValueChange={(text) => {
            setDraft(text)
            drafts.set(id, text)
          }}
          onSubmit={submit}
          slashCommands={MANAGER_COMMANDS}
          placeholder={inactive ? `${manager.name} is inactive — write anyway; sending reactivates it` : `Message ${manager.name}, or / for commands`}
          {...(inactive ? { sendLabel: 'Reactivate and send', sendAriaLabel: 'Reactivate and send' } : {})}
          ariaLabel={`Message ${manager.name}`}
          textareaClassName="max-md:max-h-[calc((100dvh-var(--kb,0px))*0.35)]"
          sendShortcut="↵"
          {...(working ? { stop: { label: 'Stop', onStop: stop } } : {})}
        />
      </div>
    </div>
    {activity.dialog}
    {watchingOpen && !barEverywhere ? (
      <WatchingPanel
        id={watchingId}
        manager={manager}
        messages={chat.messages}
        loadedAll={chat.data !== undefined && !hasNextPage}
        onPatch={onPatch}
        onAddJob={() => settings.current?.openJobs()}
      />
    ) : null}
    <WatchingSheet
      open={sheetOpen}
      everyWidth={barEverywhere}
      onOpenChange={setSheetOpen}
      manager={manager}
      messages={chat.messages}
      loadedAll={chat.data !== undefined && !hasNextPage}
      onPatch={onPatch}
      onAddJob={() => {
        setSheetOpen(false)
        settings.current?.openJobs()
      }}
    />
    </div>
  )
}

export function ManagerChatRoute() {
  const { id = '' } = useParams()
  const enabled = useHealth().data?.capabilities.managers === true
  const managers = useManagers(enabled)
  const manager = managers.data?.managers.find((entry) => entry.id === id)
  // Deleted under the reader, here or in another tab: this screen is gone, so is its Settings
  // popover and any callback it held. "No longer exists" is for a link that never resolved.
  const seen = useRef<string | undefined>(undefined)
  // The shell's sidebar lists the managers in manager mode (design 2026-11 "Manager mode", § 2).
  const shellListsManagers = useShellManagerMode()
  if (manager) seen.current = id
  if (manager) {
    // The list (only outside the shell), the chat, the Watching panel. Phones use `manager-index`.
    return (
      <div data-route="manager-screen" className="flex h-full min-h-0">
        {shellListsManagers ? null : <ManagerListRail activeId={id} />}
        <ManagerChat key={id} manager={manager} />
      </div>
    )
  }
  if (managers.data && seen.current === id) return <Navigate to="/manager" replace state={FOCUS_COMPOSER} />
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
  return <ManagerChatLoading />
}
