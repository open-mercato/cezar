import {
  ArrowLeftIcon,
  ArrowRightIcon,
  GlobeIcon,
  MousePointerClickIcon,
  PlusIcon,
  RotateCwIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { openDesignProxy } from '@/api/client'
import { useHealth } from '@/api/queries'
import { CenteredState } from '@/components/centered-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { toast } from '@/components/ui/toaster'
import { cn } from '@/lib/utils'

import { parseDesignPick, type NewDesignPick } from '../task-thread/design-picks'

import { FullViewExit } from './maximize'

import {
  MAX_BROWSER_TABS,
  emptyBrowserState,
  type BrowserState,
} from './layout-state'

/**
 * The Browser column (spec `.ai/specs/2026-10-07-task-workspace.md` §7).
 *
 * Its own tabs, Back/Forward/Reload, an address bar, and an `<iframe>`. Only addresses that
 * LOADED are persisted; a tab whose last attempt failed comes back blank, which is the spec's
 * rule and the reason the saved state is a list of plain strings.
 *
 * WHAT A BROWSER CANNOT DO, and why this view says so rather than pretending:
 *
 *  - A cross-origin page's TITLE is unreadable. The same-origin policy is the whole point of an
 *    iframe boundary, so the spec's "tabs use the page title as their label" cannot be honoured
 *    for anything but a same-origin page. The label is derived from the address instead, which
 *    is also what the spec asks for on failure — so one rule, always true, rather than a title
 *    that would silently be wrong.
 *  - A page that refuses to be framed (`X-Frame-Options`, `frame-ancestors`) fails in a way the
 *    embedder cannot observe: `load` fires for the refusal too. The timeout below is the only
 *    honest signal available, and its message says what it actually knows.
 *  - On a HOSTED cockpit a loopback address means the VIEWER's machine, not the host the task
 *    runs on, so framing it would show the wrong thing — or someone else's service. That case is
 *    refused outright with the reason. Routing it through the host that owns the task needs the
 *    preview proxy §7 calls for, which is deliberately not built: serving untrusted worktree
 *    content from the cockpit's own origin would put it beside the authenticated API, which is
 *    the one thing §7 says not to do.
 */

/** How long a page gets to fire `load` before the view calls it a failure. Generous: a cold dev
 *  server can take a while to answer its first request. */
const LOAD_TIMEOUT_MS = 12_000

/** Hosts that mean "the machine cezar runs on". Framing one of these from a remote cockpit would
 *  resolve on the VIEWER's machine instead — a different computer entirely. */
const LOOPBACK = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?|.+\.local)$/i

export function BrowserView({
  state,
  onChange,
  onPickElement,
  designMarks,
  onUnpickElement,
  renderDesignNote,
  designPickCount = 0,
  designDock,
}: {
  state: BrowserState
  /** Persisted into the column (spec §7). Called only for changes worth keeping — a successful
   *  load, a tab opened or closed — never for a failed attempt. */
  onChange: (state: BrowserState) => void
  /**
   * Design Mode (spec `.ai/specs/2026-10-09-design-mode.md`): given, the toolbar offers a picker
   * and every element the user clicks in the page is handed here. Answers whether it was kept.
   * Absent, the view has no Design Mode at all — a host with nowhere to send an element.
   */
  onPickElement?: (pick: NewDesignPick) => boolean
  /** The elements of the note being written that the page can still frame: the picker's key
   *  (`DesignPick.mark`) and the number the note gives the element. */
  designMarks?: readonly { key: string; n: number }[]
  /** A selected element was clicked again in the page — it is no longer selected. */
  onUnpickElement?: (mark: string) => void
  /**
   * The note being written, as a popup beside the element it is about. Rendered by the host —
   * what a note is, and where it goes, is its business; this view only decides WHEN it shows
   * (an element was picked, or its mark clicked) and WHERE (anchored to that element, following
   * it as the page scrolls). `close` hides it until the next pick or mark click.
   */
  renderDesignNote?: (controls: { close: () => void }) => React.ReactNode
  /** How many elements the note holds. At zero there is no note to show. */
  designPickCount?: number
  /** A strip under the page — the host's queues. Shown whenever the host provides it. */
  designDock?: React.ReactNode
}) {
  const tabs = state.tabs.length > 0 ? state.tabs : ['']
  const active = Math.min(state.active, tabs.length - 1)
  const current = tabs[active] ?? ''

  // What the address bar shows. Separate from the loaded address because a failed attempt stays
  // in the bar for correction (spec §7) while the tab's saved address does not change.
  const [draft, setDraft] = useState(current)
  const [status, setStatus] = useState<'idle' | 'loading' | 'failed'>(current === '' ? 'idle' : 'loading')
  /** Bumped to force the iframe to reload the same address. */
  const [reloadToken, setReloadToken] = useState(0)
  /** The address the iframe is actually pointed at — may be a failed attempt, which `tabs` never
   *  holds. */
  const [target, setTarget] = useState(current)
  const health = useHealth()
  /**
   * The address this view itself just persisted, and for which tab.
   *
   * A successful load writes its address into the column (spec §7 — only loaded addresses are
   * kept), and that write comes straight back as a new `current`. Without recognising the echo,
   * the re-point effect below treated it as a tab switch and reset a FINISHED load to `loading`.
   * No second `load` event can follow — the iframe is already sitting on that exact address — so
   * the timeout then declared a page that had rendered perfectly "Nie udało się otworzyć",
   * twelve seconds after the user watched it appear.
   */
  const echo = useRef<{ index: number; url: string } | null>(null)

  /**
   * Per-tab navigation history, kept HERE rather than read out of the frame.
   *
   * `contentWindow.history` is not reachable across an origin boundary: `history` is not on the
   * cross-origin property allowlist, so merely touching it raises `SecurityError`. That is what
   * Back and Forward used to do — uncaught, inside the click handler — for every page that was
   * not same-origin with the cockpit, which in practice is every page worth framing, a dev
   * server on another port included.
   *
   * So the history is the addresses THIS VIEW pointed the frame at. A link the user follows
   * inside the page is unobservable for exactly the same reason its title is, and nothing here
   * can change that; Back therefore returns to the previous address the bar held, which is the
   * honest meaning of a history an embedder is allowed to keep.
   *
   * Session-lifetime, deliberately not persisted: §7 saves ADDRESSES, and a back stack is where
   * you have been rather than what the column is.
   */
  const [navByTab, setNavByTab] = useState<Record<number, Nav>>({})
  const nav = navByTab[active] ?? seedNav(current)
  const canBack = nav.position > 0
  const canForward = nav.position >= 0 && nav.position < nav.stack.length - 1

  // Switching tabs re-points everything at that tab's own address — but the echo of this view's
  // own successful-load write is not a tab switch, and must not re-point anything.
  useEffect(() => {
    if (echo.current && echo.current.index === active && echo.current.url === current) {
      echo.current = null
      return
    }
    echo.current = null
    setDraft(current)
    setTarget(current)
    setStatus(current === '' ? 'idle' : 'loading')
  }, [active, current])

  /**
   * A loopback address this cockpit cannot honestly show.
   *
   * Read from `capabilities.preview` — the server's own answer to "can a task's app be previewed
   * from here" (spec §9, Milestone 3) — rather than inferred from the transport. The two agree
   * today, but the preview question is the one being asked, and a comment claiming this while
   * the code consulted something else was exactly the kind of drift this feature has already
   * produced once.
   */
  const canPreview = health.data?.capabilities?.preview ?? true
  const refused = target !== '' && !canPreview && isLoopback(target)

  /**
   * Design Mode.
   *
   * The framed page is cross-origin, so this view cannot see what the user points at — the whole
   * header comment above. Design Mode therefore frames the SAME app through a second loopback
   * origin the server opens on request, whose HTML carries a picker script; the picker reports
   * the clicked element over `postMessage`. Only a local `http://` address can be mirrored that
   * way, so the toggle is offered for those and nothing else.
   *
   * `design` is the user's switch. `proxy` is the mirror it produced, kept after the switch goes
   * off so that leaving Design Mode does not reload the page (and lose its state) — the picker
   * is simply told to stand down. The next navigation with the switch off drops it, and the tab
   * is framed directly again. `tabs` never holds a proxy address: the port is this session's.
   */
  const [design, setDesign] = useState(false)
  const [proxy, setProxy] = useState<{ upstream: string; origin: string } | null>(null)
  const [pickerReady, setPickerReady] = useState(false)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const designAllowed = onPickElement !== undefined && (health.data?.capabilities?.designMode ?? false)
  const targetOrigin = designOrigin(target)
  const designActive = designAllowed && design && targetOrigin !== null
  const mirror = proxy !== null && proxy.upstream === targetOrigin ? proxy.origin : null
  // Asked for but not answered yet: nothing is framed, so the page is not loaded directly only to
  // be loaded again a moment later through the mirror.
  const awaitingProxy = designActive && mirror === null
  const frameSrc = mirror !== null && targetOrigin !== null ? mirror + target.slice(targetOrigin.length) : target

  // Asked again before every load while the switch is on. The route is idempotent, and a mirror
  // the server closed for being idle comes back on a new port this way instead of as a dead frame.
  useEffect(() => {
    if (!designActive || targetOrigin === null) return
    let cancelled = false
    openDesignProxy({ target: targetOrigin, parentOrigin: window.location.origin })
      .then((opened) => {
        if (!cancelled) setProxy({ upstream: targetOrigin, origin: opened.origin })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setDesign(false)
        toast(error instanceof Error && error.message ? error.message : 'Design Mode could not start.', { tone: 'danger' })
      })
    return () => {
      cancelled = true
    }
  }, [designActive, reloadToken, targetOrigin])

  // A new document means a new picker, which announces itself when it is listening.
  useEffect(() => setPickerReady(false), [frameSrc, reloadToken])

  useEffect(() => {
    if (!pickerReady || mirror === null) return
    frameRef.current?.contentWindow?.postMessage(
      { source: 'cezar-design-host', type: 'set-active', active: designActive },
      mirror,
    )
  }, [designActive, mirror, pickerReady])

  // The page keeps a frame and a number on every element still in the note. Sent again whenever
  // the note changes and whenever a new document's picker comes up (which then knows none of them).
  const hasNote = renderDesignNote !== undefined
  /**
   * The note popup. `anchor` is the picker key of the element it sits beside; `rects` is where
   * the page says each marked element currently is, in the frame's own viewport — which is this
   * view's frame area, since the iframe fills it. A pick's own rect seeds the map so the popup
   * has somewhere to appear before the page's first report.
   */
  const [noteOpen, setNoteOpen] = useState(false)
  const [anchor, setAnchor] = useState<string | null>(null)
  const [rects, setRects] = useState<Record<string, MarkRect>>({})
  const areaRef = useRef<HTMLDivElement>(null)
  const noteRef = useRef<HTMLDivElement>(null)
  const [notePosition, setNotePosition] = useState<{ left: number; top: number } | null>(null)
  const closeNote = useCallback(() => setNoteOpen(false), [])
  const noteVisible = hasNote && designAllowed && noteOpen && designPickCount > 0
  const anchorRect = anchor !== null ? rects[anchor] : undefined

  // Nothing left in the note (it was sent, or emptied): the popup has nothing to be about.
  useEffect(() => {
    if (designPickCount === 0) setNoteOpen(false)
  }, [designPickCount])

  // Switching Design Mode on with a note already waiting brings the note back with it.
  useEffect(() => {
    if (designActive && designPickCount > 0) setNoteOpen(true)
    // Only the switch: a later pick opens the note through its own path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [designActive])

  // Beside the element: under it when there is room, above it when there is not, and always
  // inside the frame area. Without a known rect (a pick from a page since reloaded) it parks in
  // the bottom-right corner rather than guess.
  useLayoutEffect(() => {
    if (!noteVisible) return
    const area = areaRef.current
    const note = noteRef.current
    if (!area || !note) return
    setNotePosition(placeNote(anchorRect, { width: area.clientWidth, height: area.clientHeight }, { width: note.offsetWidth, height: note.offsetHeight }))
  }, [anchorRect, designPickCount, noteVisible])

  const marksKey = (designMarks ?? []).map((mark) => `${mark.key}:${mark.n}`).join(' ')
  const sendMarks = useCallback(() => {
    if (mirror === null) return
    const marks =
      marksKey === '' ? [] : marksKey.split(' ').map((entry) => ({ key: entry.split(':')[0]!, n: Number(entry.split(':')[1]) }))
    frameRef.current?.contentWindow?.postMessage({ source: 'cezar-design-host', type: 'set-marks', marks }, mirror)
  }, [marksKey, mirror])
  useEffect(() => {
    if (pickerReady) sendMarks()
  }, [pickerReady, sendMarks])

  useEffect(() => {
    if (mirror === null) return
    const onMessage = (event: MessageEvent) => {
      // The mirror's origin AND this view's own frame: another Browser column may be mirroring
      // the same app, and its picks are not this column's to report.
      if (event.origin !== mirror || event.source !== frameRef.current?.contentWindow) return
      const data = event.data as {
        source?: unknown
        type?: unknown
        element?: unknown
        key?: unknown
        rects?: unknown
      } | null
      if (data === null || typeof data !== 'object' || data.source !== 'cezar-design') return
      if (data.type === 'ready') setPickerReady(true)
      else if (data.type === 'cancel') setDesign(false)
      else if (data.type === 'mark-clicked' && typeof data.key === 'string') {
        setAnchor(data.key)
        setNoteOpen(true)
      } else if (data.type === 'unpicked' && typeof data.key === 'string') onUnpickElement?.(data.key)
      else if (data.type === 'rects') setRects(parseMarkRects(data.rects))
      else if (data.type === 'picked') {
        const pick = parseDesignPick(data.element)
        if (!pick || !onPickElement?.(pick)) {
          // The page framed the element the moment it was clicked. It was not kept (malformed,
          // or the host refused it), so the page is told what IS selected and drops the frame.
          sendMarks()
          return
        }
        if (!hasNote) {
          // No note popup on this host: the element went to the composer, out of sight.
          toast('Element added to your next message.')
          return
        }
        const mark = pick.mark
        if (mark !== undefined) setRects((known) => ({ ...known, [mark]: pick.rect }))
        setAnchor(mark ?? null)
        setNoteOpen(true)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [hasNote, mirror, onPickElement, onUnpickElement, sendMarks])

  /** With the switch off, a navigation is where the mirror is let go. */
  const releaseMirror = useCallback(() => {
    if (!design) setProxy(null)
  }, [design])

  // A page that never fires `load` is the only failure an embedder can detect at all.
  useEffect(() => {
    if (status !== 'loading' || target === '' || refused) return
    const timer = setTimeout(() => setStatus('failed'), LOAD_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [refused, reloadToken, status, target])

  const commit = useCallback(
    (raw: string) => {
      const url = normalizeAddress(raw)
      if (url === null) return
      releaseMirror()
      setTarget(url)
      setDraft(url)
      setStatus('loading')
      setReloadToken((token) => token + 1)
      // A new entry, with anything ahead of the cursor dropped — the grammar every browser uses
      // when you navigate after going Back. Re-entering the address you are already on is a
      // reload, not a second entry.
      setNavByTab((byTab) => {
        const base = byTab[active] ?? seedNav(current)
        const kept = base.stack.slice(0, base.position + 1)
        if (kept[kept.length - 1] === url) return byTab
        const stack = [...kept, url].slice(-MAX_HISTORY)
        return { ...byTab, [active]: { stack, position: stack.length - 1 } }
      })
    },
    [active, current, releaseMirror],
  )

  /** Back (`-1`) and Forward (`+1`) — a move along this tab's own stack. */
  const go = useCallback(
    (delta: -1 | 1) => {
      const position = nav.position + delta
      const url = nav.stack[position]
      if (url === undefined) return
      releaseMirror()
      setNavByTab((byTab) => ({ ...byTab, [active]: { stack: nav.stack, position } }))
      setTarget(url)
      setDraft(url)
      setStatus('loading')
      setReloadToken((token) => token + 1)
    },
    [active, nav.position, nav.stack, releaseMirror],
  )

  /** A load succeeded: only now is the address worth keeping (spec §7). */
  const onLoaded = useCallback(() => {
    if (target === '') return
    setStatus('idle')
    if (tabs[active] !== target) {
      echo.current = { index: active, url: target }
      onChange({ ...state, tabs: tabs.map((tab, index) => (index === active ? target : tab)) })
    }
  }, [active, onChange, state, tabs, target])

  const addTab = useCallback(() => {
    if (tabs.length >= MAX_BROWSER_TABS) return
    // New tabs are blank and go at the end (spec §7).
    onChange({ tabs: [...tabs, ''], active: tabs.length })
  }, [onChange, tabs])

  const closeTab = useCallback(
    (index: number) => {
      const remaining = tabs.filter((_, position) => position !== index)
      // Closing the last tab creates a new blank one — a Browser column is never tabless.
      if (remaining.length === 0) {
        onChange(emptyBrowserState())
        setNavByTab({})
        return
      }
      // The tab to the right, or the previous one when there is none (spec §7).
      const nextActive = index < active ? active - 1 : Math.min(active, remaining.length - 1)
      onChange({ tabs: remaining, active: nextActive })
      // The histories are keyed by tab INDEX, and closing a tab shifts every index above it —
      // so they have to move with the tabs, or the surviving tabs inherit each other's stacks.
      setNavByTab((byTab) => {
        const shifted: Record<number, Nav> = {}
        for (const [key, entry] of Object.entries(byTab)) {
          const position = Number(key)
          if (position === index) continue
          shifted[position > index ? position - 1 : position] = entry
        }
        return shifted
      })
    },
    [active, onChange, tabs],
  )

  return (
    <div data-slot="browser-view" className="flex h-full min-h-0 flex-col">
      <Tabs
        value={String(active)}
        onValueChange={(value) => onChange({ ...state, active: Number(value) })}
        className="shrink-0 gap-0"
      >
      <TabsList
        aria-label="Browser tabs"
        className="flex w-full justify-start gap-0.5 overflow-x-auto rounded-none bg-transparent px-3 py-0"
      >
        {tabs.map((tab, index) => (
          <div
            key={index}
            data-slot="browser-tab"
            data-active={index === active ? '' : undefined}
            className={cn(
              'group flex h-6 shrink-0 items-center rounded-sm pl-2 pr-0.5 text-xs font-medium',
              index === active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {/* Radix selects on pointer-down and on arrow-key focus (`onValueChange` above);
                `onClick` stays for a synthetic click and skips the tab that is already showing. */}
            <TabsTrigger
              value={String(index)}
              onClick={() => {
                if (index !== active) onChange({ ...state, active: index })
              }}
              title={tab || 'New tab'}
              className="inline-block h-auto max-w-32 flex-none truncate rounded-none border-0 p-0 text-xs font-medium text-inherit hover:text-inherit focus-visible:underline focus-visible:ring-0 focus-visible:outline-0 data-[state=active]:bg-transparent data-[state=active]:font-medium data-[state=active]:text-inherit group-data-[variant=default]/tabs-list:data-[state=active]:shadow-none"
            >
              {tabLabel(tab)}
            </TabsTrigger>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`Close tab ${tabLabel(tab)}`}
              onClick={() => closeTab(index)}
              className={cn(
                'ml-1 size-4 rounded text-inherit opacity-0 transition-opacity hover:bg-background hover:text-inherit focus-visible:opacity-100 group-hover:opacity-100',
                index === active && 'opacity-60',
              )}
            >
              <XIcon aria-hidden="true" className="size-3" />
            </Button>
          </div>
        ))}
        {tabs.length < MAX_BROWSER_TABS ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="New tab"
            title="New tab"
            onClick={addTab}
            className="rounded"
          >
            <PlusIcon aria-hidden="true" className="size-3.5" />
          </Button>
        ) : null}
        {/* Top right of the strip that is already here; renders only in full view. */}
        <FullViewExit className="sticky right-0 ml-auto" />
      </TabsList>
      </Tabs>

      <div className="flex shrink-0 items-center gap-1 border-b border-border/70 px-3 pb-2">
        {/* Back and Forward walk this view's OWN per-tab stack — see `navByTab`. They can
            therefore be disabled truthfully, which reaching into the frame could never do. */}
        <ToolbarButton
          label="Back"
          disabled={!canBack}
          onClick={() => go(-1)}
          icon={<ArrowLeftIcon aria-hidden="true" className="size-3.5" />}
        />
        <ToolbarButton
          label="Forward"
          disabled={!canForward}
          onClick={() => go(1)}
          icon={<ArrowRightIcon aria-hidden="true" className="size-3.5" />}
        />
        <ToolbarButton
          label="Reload"
          onClick={() => {
            if (target === '') return
            releaseMirror()
            setStatus('loading')
            setReloadToken((token) => token + 1)
          }}
          icon={<RotateCwIcon aria-hidden="true" className={cn('size-3.5', status === 'loading' && 'animate-spin')} />}
        />
        <form
          className="min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault()
            commit(draft)
          }}
        >
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Enter an address, e.g. http://localhost:3000"
            aria-label="Address"
            spellCheck={false}
            className="h-8 text-[13px] focus-visible:ring-ring/30 md:text-[13px] dark:bg-card"
          />
        </form>
        {designAllowed ? (
          // The one control in this toolbar that is not navigation, and the only one a user has
          // to be told exists — so it carries its name, and wears the accent while it is on.
          <Button
            type="button"
            data-slot="browser-design-toggle"
            variant={designActive ? 'primary' : 'outline'}
            size="sm"
            aria-pressed={designActive}
            disabled={targetOrigin === null}
            title={
              targetOrigin === null ? 'Design Mode works on local http:// addresses'
              : designActive ? 'Stop selecting elements (Esc)'
              : 'Click an element of the page to send it to the agent'
            }
            onClick={() => setDesign((on) => !on)}
            className="ml-1 disabled:opacity-40"
          >
            <MousePointerClickIcon aria-hidden="true" className="size-3.5" />
            Design Mode
          </Button>
        ) : null}
      </div>

      <div ref={areaRef} className="relative min-h-0 flex-1">
        {refused ? (
          <CenteredState
            icon={<TriangleAlertIcon />}
            tone="neutral"
            heading="h2"
            title="This address points at the machine you are sitting at"
            subtitle="This cockpit runs remotely, so a local address would open on your computer rather than on the task's host. Previewing the task's app from hosted mode needs a proxy that does not exist yet."
          />
        ) : target === '' ? (
          <CenteredState
            icon={<GlobeIcon />}
            tone="neutral"
            heading="h2"
            title="Empty tab"
            subtitle="Enter an address above. Any will do — including the app running in this task's terminal."
          />
        ) : (
          <>
            {status === 'failed' ? (
              <div
                data-slot="browser-failed"
                className="absolute inset-x-0 top-0 z-10 border-b border-border bg-background px-3 py-2 text-xs text-soft-foreground"
              >
                <span className="font-medium text-foreground">Could not open</span> — the page did not
                respond or does not allow embedding. The address is still in the bar; you can fix it.
              </div>
            ) : null}
            {designActive && status === 'idle' && !noteVisible ? (
              <p
                data-slot="browser-design-hint"
                className="pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full border border-border bg-background/95 px-3 py-1 text-xs whitespace-nowrap text-soft-foreground shadow-sm"
              >
                {hasNote ? 'Click an element to write a note about it · Esc to stop' : 'Click an element to add it to your next message · Esc to stop'}
              </p>
            ) : null}
            {awaitingProxy ? null : (
            <iframe
              ref={frameRef}
              // Keyed by the address AND the reload token so Reload really re-fetches. It is the
              // FRAMED address that keys it: entering Design Mode swaps it for the mirror's.
              key={`${frameSrc}#${reloadToken}`}
              src={frameSrc}
              title="Preview"
              onLoad={onLoaded}
              // Worktree-served content is untrusted (spec §7). `allow-same-origin` keeps the page
              // in its OWN origin — which is not the cockpit's, so it still cannot touch the
              // authenticated API — while letting an app use its own storage and cookies, without
              // which most dev servers do not work at all.
              sandbox="allow-same-origin allow-scripts allow-forms allow-modals allow-popups"
              // A framed page must not be able to reach for the camera, the microphone or the
              // user's location on the cockpit's behalf.
              allow=""
              referrerPolicy="no-referrer"
              // No background of its own: the framed page paints one, and forcing white here would
              // flash a light rectangle into a dark cockpit for every load.
              className={cn('size-full border-0', status === 'loading' && 'invisible')}
            />
            )}
            {status === 'loading' ? (
              <p className="absolute inset-0 grid place-items-center text-xs text-soft-foreground">
                Loading…
              </p>
            ) : null}
          </>
        )}
        {noteVisible ? (
          <div
            ref={noteRef}
            data-slot="browser-design-note"
            role="dialog"
            aria-label="Note about the selected elements"
            // Positioned once measured; rendered invisible for that first frame so it never
            // flashes in a corner it is not staying in.
            style={notePosition ? { left: notePosition.left, top: notePosition.top } : { left: 0, top: 0, visibility: 'hidden' }}
            className="absolute z-20 w-[min(360px,calc(100%-16px))] rounded-xl border border-border bg-background shadow-lg"
          >
            {renderDesignNote({ close: closeNote })}
          </div>
        ) : null}
      </div>
      {designDock !== undefined && designAllowed ? (
        <div data-slot="browser-design-dock" className="shrink-0 border-t border-border/70">
          {designDock}
        </div>
      ) : null}
    </div>
  )
}

function ToolbarButton({
  label,
  icon,
  onClick,
  disabled,
}: {
  label: string
  icon: React.ReactNode
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="disabled:opacity-40"
    >
      {icon}
    </Button>
  )
}

/** Where a marked element is, in the framed document's viewport. */
interface MarkRect {
  x: number
  y: number
  width: number
  height: number
}

/** The page's report of its marks. From a page cezar does not control: anything malformed is
 *  dropped, and what is kept is numbers only. */
function parseMarkRects(raw: unknown): Record<string, MarkRect> {
  const out: Record<string, MarkRect> = {}
  if (!Array.isArray(raw)) return out
  for (const item of raw.slice(0, 50) as unknown[]) {
    if (item === null || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    if (typeof r.key !== 'string' || !/^[a-z0-9-]{1,24}$/.test(r.key)) continue
    const n = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
    out[r.key] = { x: n(r.x), y: n(r.y), width: n(r.width), height: n(r.height) }
  }
  return out
}

const NOTE_GAP = 10
const NOTE_MARGIN = 8

/**
 * Where the note popup goes: under its element when it fits, above when it does not, clamped
 * into the frame area either way — an element scrolled out of view keeps its note on screen at
 * the nearest edge instead of dragging it away. No rect: the bottom-right corner.
 */
export function placeNote(
  rect: MarkRect | undefined,
  area: { width: number; height: number },
  note: { width: number; height: number },
): { left: number; top: number } {
  const maxLeft = Math.max(NOTE_MARGIN, area.width - note.width - NOTE_MARGIN)
  const maxTop = Math.max(NOTE_MARGIN, area.height - note.height - NOTE_MARGIN)
  if (!rect) return { left: maxLeft, top: maxTop }
  const clamp = (value: number, max: number) => Math.min(Math.max(value, NOTE_MARGIN), max)
  const below = rect.y + rect.height + NOTE_GAP
  const above = rect.y - NOTE_GAP - note.height
  const top = below + note.height + NOTE_MARGIN <= area.height ? below : above >= NOTE_MARGIN ? above : below
  return { left: clamp(rect.x, maxLeft), top: clamp(top, maxTop) }
}

/** One tab's visited addresses and where in them it currently sits. `position` is `-1` for a tab
 *  that has never loaded anything, which is what a blank tab is. */
interface Nav {
  stack: string[]
  position: number
}

/** A tab's starting history: its saved address, or nothing at all when it is blank. */
function seedNav(address: string): Nav {
  return address === '' ? { stack: [], position: -1 } : { stack: [address], position: 0 }
}

/** Entries kept per tab. Deep enough for any real back-and-forth, bounded so a long session in
 *  one tab cannot grow without limit. */
const MAX_HISTORY = 50

/**
 * What a tab is called.
 *
 * Derived from the address, never from the page title: see the header comment — a cross-origin
 * document's title is unreadable by design, and a label that is silently wrong is worse than one
 * that is merely terse.
 */
export function tabLabel(url: string): string {
  if (url === '') return 'New tab'
  try {
    const parsed = new URL(url)
    const path = parsed.pathname === '/' ? '' : parsed.pathname
    return `${parsed.host}${path}`
  } catch {
    return url
  }
}

/**
 * A typed address → something an iframe can load, or null when there is nothing to load.
 *
 * A bare `localhost:3000` gets `http://`, because that is what a user types and what a dev
 * server prints. Only http(s) is accepted: `javascript:` and `data:` in a frame the cockpit
 * renders are script injection with extra steps, and `file:` would read the host's disk.
 */
export function normalizeAddress(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  // `scheme://` is the only shape that counts as an explicit scheme. A colon alone does not:
  // `localhost:3000` is a host and a port, and it is the single most common thing a user types
  // here — reading its host as a scheme would reject exactly the address a dev server prints.
  const hierarchical = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
  // A colon-scheme with no `//` and no port after it is an opaque scheme — `javascript:`,
  // `data:`, `mailto:` — and none of those are an address this view may load.
  if (!hierarchical && /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(trimmed)) return null
  const candidate = hierarchical ? trimmed : `http://${trimmed}`
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return parsed.toString()
}

/**
 * The origin Design Mode can mirror for this address, or null when it cannot: only a loopback
 * `http://` dev server. The server refuses everything else too (`parseDesignTarget`); this is the
 * same rule asked early, so the toggle is disabled with a reason instead of failing on click.
 */
export function designOrigin(url: string): string | null {
  if (url === '') return null
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' || !DESIGN_HOSTS.test(parsed.hostname)) return null
    return parsed.origin
  } catch {
    return null
  }
}

const DESIGN_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\])$/i

export function isLoopback(url: string): boolean {
  try {
    return LOOPBACK.test(new URL(url).hostname)
  } catch {
    return false
  }
}
