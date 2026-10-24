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
import { formatChord } from '@/lib/keybindings'
import { cn } from '@/lib/utils'

import {
  emptyBrowserState,
  MAX_BROWSER_TABS,
  MAX_TAB_URL_LENGTH,
  reviveBrowserState,
  type BrowserState,
} from '../task-workspace/layout-state'
import { parseDesignPick, type NewDesignPick } from './design-picks'

/**
 * The task's Preview tab (spec `.ai/specs/2026-10-09-design-mode.md`): its own tabs,
 * Back/Forward/Reload, an address bar, and an `<iframe>`. Only addresses that LOADED are kept; a
 * tab whose last attempt failed comes back blank.
 *
 * What an embedder cannot do, and why this view says so rather than pretending:
 *
 *  - A cross-origin page's TITLE is unreadable, so a tab's label is derived from its address.
 *  - A page that refuses to be framed (`X-Frame-Options`, `frame-ancestors`) fires `load` for the
 *    refusal too. The timeout below is the only signal available, and its message says so.
 *  - On a HOSTED cockpit a loopback address means the VIEWER's machine, not the host the task
 *    runs on, so it is never framed there — the case is refused with the reason.
 */

/** How long a page gets to fire `load` before the view calls it a failure. Generous: a cold dev
 *  server can take a while to answer its first request. */
const LOAD_TIMEOUT_MS = 12_000

// One state shape with the workspace's Browser column, which saves it with the layout (spec
// 2026-10-07-task-workspace §7), so the host's bounds apply here too.
export { emptyBrowserState, MAX_BROWSER_TABS, MAX_TAB_URL_LENGTH, reviveBrowserState, type BrowserState }

/** Hosts that mean "the machine cezar runs on". Framing one of these from a remote cockpit would
 *  resolve on the VIEWER's machine instead — a different computer entirely. */
const LOOPBACK = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?|.+\.local)$/i

export function BrowserView({
  state,
  onChange,
  onPickElement,
  designMarks,
  renderDesignNote,
  onDesignEscape,
  designTray,
  renderEmpty,
}: {
  state: BrowserState
  /** Called only for changes worth keeping — a successful load, a tab opened or closed — never
   *  for a failed attempt. */
  onChange: (state: BrowserState) => void
  /**
   * Design Mode (spec `.ai/specs/2026-10-09-design-mode.md`): given, the toolbar offers a picker
   * and every element the user clicks in the page is handed here. Answers whether it was kept.
   * Absent, the view has no Design Mode at all — a host with nowhere to send an element.
   */
  onPickElement?: (pick: NewDesignPick) => boolean
  /**
   * Every element with a note on it — what the page keeps framed. A draft's frame is plain and
   * carries how to find the element again after a reload; a sent note's wears its number.
   */
  designMarks?: readonly DesignMark[]
  /**
   * The note about one element, as a popup under its frame. Rendered by the host — what a note
   * is, and where it goes, is its business; this view only decides WHEN it shows (the element
   * was picked, or its frame clicked) and WHERE (anchored to the element, following it as the
   * page scrolls). `close` hides it.
   */
  renderDesignNote?: (controls: { mark: string; close: () => void }) => React.ReactNode
  /** Esc was pressed in the page while the note for `mark` was open. The view closes the popup;
   *  the host decides what else that means (a draft is discarded). */
  onDesignEscape?: (mark: string) => void
  /** The host's batch send for its notes, floated in the frame's corner while Design Mode is on;
   *  `null` when there is nothing to send. */
  designTray?: React.ReactNode
  /** What an empty tab shows instead of the bare hint — the task's "Run the app". Handed the
   *  same `open` the address bar uses. Only on a cockpit that can frame a local address. */
  renderEmpty?: (open: (url: string) => void) => React.ReactNode
}) {
  const tabs = state.tabs.length > 0 ? state.tabs : ['']
  const active = Math.min(state.active, tabs.length - 1)
  const current = tabs[active] ?? ''

  // What the address bar shows. Separate from the loaded address because a failed attempt stays
  // in the bar for correction while the tab's saved address does not change.
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
   * A successful load writes its address into the tabs (only loaded addresses are
   * kept), and that write comes straight back as a new `current`. Without recognising the echo,
   * the re-point effect below treated it as a tab switch and reset a FINISHED load to `loading`.
   * No second `load` event can follow — the iframe is already sitting on that exact address — so
   * the timeout then declared a page that had rendered perfectly a failure.
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
   * So the history is the addresses THIS VIEW pointed the frame at, plus the moves a page with
   * cezar's location reporter tells it about (`followPage`). Without one, a link followed inside
   * the page is unobservable for the same reason its title is; Back then returns to the previous
   * address the bar held, which is the honest meaning of a history an embedder may keep.
   *
   * Session-lifetime, deliberately not persisted: the tabs save ADDRESSES, and a back stack is where
   * you have been rather than what the tab is.
   */
  const [navByTab, setNavByTab] = useState<Record<number, Nav>>({})
  const nav = navByTab[active] ?? seedNav(current)
  const canBack = nav.position > 0
  const canForward = nav.position >= 0 && nav.position < nav.stack.length - 1

  /**
   * Where the framed document says it is now — moved by `pushState`, `replaceState` or a hash
   * change, which fire no `load`. Null until it says so, and for every page that cannot: only a
   * page carrying cezar's location reporter (the desktop shell's frame script, Design Mode's
   * picker) speaks, because a cross-origin frame's `location` is unreadable from here.
   */
  const [live, setLive] = useState<string | null>(null)
  /** Documents the current frame element has finished loading — a report from the second one on
   *  is a link followed inside the page, not the redirect of the address this view asked for. */
  const loads = useRef(0)

  // Switching tabs re-points everything at that tab's own address — but the echo of this view's
  // own successful-load write is not a tab switch, and must not re-point anything.
  const mounted = useRef(false)
  useEffect(() => {
    if (echo.current && echo.current.index === active && echo.current.url === current) {
      echo.current = null
      return
    }
    echo.current = null
    setDraft(current)
    setTarget(current)
    setStatus(current === '' ? 'idle' : 'loading')
    // A fresh document even when the address matches the frame's, or differs from it by the hash
    // alone — either would otherwise fire no `load` and time out as a failure.
    if (mounted.current) setReloadToken((token) => token + 1)
    mounted.current = true
  }, [active, current])

  // A loopback address this cockpit cannot honestly show: on a hosted cockpit it would open on
  // the viewer's machine. `localHandoff` is the server's own "this cockpit is local" answer.
  const canPreview = health.data?.capabilities?.localHandoff ?? true
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
  const addressRef = useRef<HTMLInputElement>(null)
  // The toggle shows wherever a host takes picks; the server's capability only decides whether it
  // can be switched on, so an unavailable Design Mode says why instead of vanishing.
  const designOffered = onPickElement !== undefined
  const designAllowed = designOffered && (health.data?.capabilities?.designMode ?? false)
  const designUnavailable = !designAllowed
    ? health.data?.capabilities?.localHandoff === false
      ? "Design Mode needs a local cockpit — a hosted one cannot reach the task's local dev server"
      : 'Design Mode is turned off on this cockpit (CEZ_DESIGN_MODE=0)'
    : null
  const targetOrigin = designOrigin(target)
  const designActive = designAllowed && design && targetOrigin !== null
  // ⌥D / Alt+D switches it — from any field too, so it works wherever the focus is in the cockpit.
  // Inside the page only the mirror's picker can hear it (and forwards it): a directly framed
  // page is another origin, whose keys never reach this window.
  const toggleDesign = useRef<() => boolean>(() => false)
  toggleDesign.current = () => {
    if (!designAllowed || targetOrigin === null) return false
    setDesign((on) => !on)
    return true
  }
  useEffect(() => {
    if (!designOffered) return
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || event.defaultPrevented || !isDesignKey(event)) return
      // A dialog owns the keyboard (Radix sets no `aria-modal`); the note popup does not.
      if (document.querySelector('[role="dialog"]:not([data-slot="browser-design-note"]), [role="alertdialog"]')) return
      // Swallowed only when it switched something: unavailable, ⌥D still types its `∂`.
      if (toggleDesign.current()) event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [designOffered])
  const mirror = proxy !== null && proxy.upstream === targetOrigin ? proxy.origin : null
  // Asked for but not answered yet: nothing is framed, so the page is not loaded directly only to
  // be loaded again a moment later through the mirror.
  const awaitingProxy = designActive && mirror === null
  const framed = useCallback(
    (url: string) => (mirror !== null && targetOrigin !== null ? mirror + url.slice(targetOrigin.length) : url),
    [mirror, targetOrigin],
  )
  const frameSrc = framed(target)
  /** One per DOCUMENT: a hash-only move re-points `src` without changing it, so the browser
   *  navigates to the fragment in place instead of the frame being rebuilt. */
  const frameKey = `${withoutHash(frameSrc)}#${reloadToken}`
  /** The address the frame is showing — what Reload reopens and the bar follows. */
  const shown = live ?? target

  useEffect(() => {
    setLive(null)
    loads.current = 0
  }, [frameKey])

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
  useEffect(() => setPickerReady(false), [frameKey])

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
  /** The page of THIS document has said where its frames are at least once — before that, a
   *  draft with no rect is not "lost", it is merely not reported yet. */
  const [rectsReported, setRectsReported] = useState(false)
  const areaRef = useRef<HTMLDivElement>(null)
  const noteRef = useRef<HTMLDivElement>(null)
  const [notePosition, setNotePosition] = useState<{ left: number; top: number } | null>(null)
  const closeNote = useCallback(() => setNoteOpen(false), [])
  const marks = designMarks ?? NO_MARKS
  const anchored = anchor !== null && marks.some((mark) => mark.key === anchor)
  const noteVisible = hasNote && designAllowed && noteOpen && anchored
  const anchorRect = anchor !== null ? rects[anchor] : undefined
  /** Drafts whose element the page could not find again (it changed, or this is another page).
   *  The note is not lost — it is offered from a corner instead of from a frame. */
  const adrift = hasNote && mirror !== null && rectsReported ? marks.filter((mark) => mark.draft && !(mark.key in rects)) : NO_MARKS

  // The note it was showing is gone (sent and closed, discarded, withdrawn): nothing to show.
  // "Gone" means it WAS there: a pick opens the popup in the same breath as the host creates the
  // note, and the popup must not close itself in the instant before the host's list catches up.
  const seenAnchored = useRef<string | null>(null)
  useEffect(() => {
    if (anchored) seenAnchored.current = anchor
    else if (noteOpen && seenAnchored.current === anchor) setNoteOpen(false)
  }, [anchor, anchored, noteOpen])

  // A new document knows nothing of the old one's frames.
  useEffect(() => {
    setRects({})
    setRectsReported(false)
  }, [frameKey])

  // Under the element when there is room, above it when there is not, and always inside the
  // frame area. Without a known rect it parks in the bottom-right corner rather than guess.
  useLayoutEffect(() => {
    if (!noteVisible) return
    const area = areaRef.current
    const note = noteRef.current
    if (!area || !note) return
    setNotePosition(placeNote(anchorRect, { width: area.clientWidth, height: area.clientHeight }, { width: note.offsetWidth, height: note.offsetHeight }))
  }, [anchor, anchorRect, noteVisible])

  // The click that opened the note happened INSIDE the frame, so that is where the keyboard
  // still is — and the note is drawn hidden until it is placed, which defeats `autoFocus`. Once
  // it is placed, the cursor is put in it: point, type.
  const placed = notePosition !== null
  useEffect(() => {
    if (noteVisible && placed) noteRef.current?.querySelector<HTMLElement>('textarea')?.focus()
  }, [anchor, noteVisible, placed])

  const marksKey = JSON.stringify(marks.map(({ key, n, selector, path }) => ({ key, n, selector, path })))
  const sendMarks = useCallback(() => {
    if (mirror === null) return
    frameRef.current?.contentWindow?.postMessage(
      { source: 'cezar-design-host', type: 'set-marks', marks: JSON.parse(marksKey) as unknown },
      mirror,
    )
  }, [marksKey, mirror])
  useEffect(() => {
    if (pickerReady) sendMarks()
  }, [pickerReady, sendMarks])

  // What Esc in the page means depends on state the listener below must read fresh.
  const openNote = useRef<string | null>(null)
  openNote.current = noteVisible ? anchor : null

  useEffect(() => {
    if (mirror === null) return
    const onMessage = (event: MessageEvent) => {
      // The mirror's origin AND this view's own frame: another Preview may be mirroring the same
      // app, and its picks are not this view's to report.
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
      // Only ever OFF from the page: its own script could post this too, and switching Design
      // Mode on takes the user's own action (spec §7a).
      else if (data.type === 'toggle') setDesign(false)
      else if (data.type === 'cancel') {
        // Esc in the page: with a note open it closes that note (the host discards a draft);
        // with none it leaves Design Mode.
        if (openNote.current !== null) {
          onDesignEscape?.(openNote.current)
          setNoteOpen(false)
        } else setDesign(false)
      } else if (data.type === 'mark-clicked' && typeof data.key === 'string') {
        setAnchor(data.key)
        setNoteOpen(true)
      } else if (data.type === 'rects') {
        setRects(parseMarkRects(data.rects))
        setRectsReported(true)
      }
      else if (data.type === 'picked') {
        const pick = parseDesignPick(data.element)
        if (!pick || !onPickElement?.(pick)) {
          // The page framed the element the moment it was clicked. It was not kept (malformed,
          // or the host refused it), so the page is told what IS selected and drops the frame.
          sendMarks()
          return
        }
        if (!hasNote) {
          // No note popup on this host: the pick went to the host, out of sight.
          toast('Element picked.')
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
  }, [hasNote, mirror, onDesignEscape, onPickElement, sendMarks])

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

  /** Save `url` as the active tab's address. An address past the cap is shown but not kept. */
  const keep = useCallback(
    (url: string) => {
      if (tabs[active] === url || url.length > MAX_TAB_URL_LENGTH) return
      echo.current = { index: active, url }
      onChange({ ...state, tabs: tabs.map((tab, index) => (index === active ? url : tab)) })
    },
    [active, onChange, state, tabs],
  )

  /**
   * Point the frame at `url`. An address that differs from the page on show by its hash alone is
   * a same-document move, as in any browser: `src` changes, the page gets `hashchange`, nothing
   * reloads and no `load` follows — so it is kept at once.
   */
  const point = useCallback(
    (url: string) => {
      if (status === 'idle' && !refused && url !== shown && sameDocument(shown, url)) {
        setLive(null)
        setTarget(url)
        setDraft(url)
        // `src` already holds this address (the page moved away from it on its own), so React
        // will not touch it: setting it again is what navigates the frame to the fragment.
        if (url === target && frameRef.current) frameRef.current.src = framed(url)
        keep(url)
        return
      }
      releaseMirror()
      setLive(null)
      setTarget(url)
      setDraft(url)
      setStatus('loading')
      setReloadToken((token) => token + 1)
    },
    [framed, keep, refused, releaseMirror, shown, status, target],
  )

  const commit = useCallback(
    (raw: string) => {
      const url = normalizeAddress(raw)
      if (url === null) return
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
      point(url)
    },
    [active, current, point],
  )

  /** Back (`-1`) and Forward (`+1`) — a move along this tab's own stack. */
  const go = useCallback(
    (delta: -1 | 1) => {
      const position = nav.position + delta
      const url = nav.stack[position]
      if (url === undefined) return
      setNavByTab((byTab) => ({ ...byTab, [active]: { stack: nav.stack, position } }))
      point(url)
    },
    [active, nav.position, nav.stack, point],
  )

  /** A load succeeded: only now is the address worth keeping. */
  const onLoaded = useCallback(() => {
    if (target === '') return
    loads.current += 1
    setStatus('idle')
    keep(shown)
  }, [keep, shown, target])

  /**
   * The framed page moved on its own. Pushes and hash changes become entries Back can return to,
   * a replace rewrites the entry it is on, and the bar follows — unless the user is typing in it.
   */
  const followPage = useCallback(
    (url: string, how: string) => {
      setLive(url)
      setDraft((typed) => (typed === shown || document.activeElement !== addressRef.current ? url : typed))
      setNavByTab((byTab) => {
        const base = byTab[active] ?? seedNav(current)
        if (base.stack[base.position] === url) return byTab
        let next: Nav
        if (base.stack[base.position - 1] === url && how === 'pop') next = { stack: base.stack, position: base.position - 1 }
        else if (base.stack[base.position + 1] === url && how === 'pop') next = { stack: base.stack, position: base.position + 1 }
        // A link followed inside the page is a new document in the same frame: a new entry too.
        else if (how === 'push' || (how === 'load' && loads.current > 0) || base.position < 0) {
          const stack = [...base.stack.slice(0, base.position + 1), url].slice(-MAX_HISTORY)
          next = { stack, position: stack.length - 1 }
        } else next = { stack: base.stack.map((entry, index) => (index === base.position ? url : entry)), position: base.position }
        return { ...byTab, [active]: next }
      })
      // While it is still loading the load itself keeps it — `shown` by then.
      if (status === 'idle') keep(url)
    },
    [active, current, keep, shown, status],
  )

  const frameOrigin = originOf(frameSrc)
  useEffect(() => {
    if (frameOrigin === null) return
    const onMessage = (event: MessageEvent) => {
      // This view's own frame, at the origin it was pointed at: no other window speaks for it.
      if (event.origin !== frameOrigin || event.source !== frameRef.current?.contentWindow) return
      const data = event.data as { source?: unknown; type?: unknown; url?: unknown; how?: unknown } | null
      if (data === null || typeof data !== 'object' || data.source !== 'cezar-preview' || data.type !== 'location') return
      if (typeof data.url !== 'string') return
      const url = pageAddress(data.url, frameOrigin, mirror !== null ? targetOrigin : null)
      if (url !== null) followPage(url, typeof data.how === 'string' ? data.how : 'replace')
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [followPage, frameOrigin, mirror, targetOrigin])

  const addTab = useCallback(() => {
    if (tabs.length >= MAX_BROWSER_TABS) return
    // New tabs are blank and go at the end.
    onChange({ tabs: [...tabs, ''], active: tabs.length })
  }, [onChange, tabs])

  const closeTab = useCallback(
    (index: number) => {
      const remaining = tabs.filter((_, position) => position !== index)
      // Closing the last tab creates a new blank one — a Preview is never tabless.
      if (remaining.length === 0) {
        onChange(emptyBrowserState())
        setNavByTab({})
        return
      }
      // The tab to the right, or the previous one when there is none.
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
              size="icon-sm"
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
            size="icon-sm"
            aria-label="New tab"
            title="New tab"
            onClick={addTab}
            className="size-6 rounded"
          >
            <PlusIcon aria-hidden="true" className="size-3.5" />
          </Button>
        ) : null}
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
            // The page as it is NOW — a hash or path it moved to on its own included.
            releaseMirror()
            setLive(null)
            setTarget(shown)
            setDraft(shown)
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
            ref={addressRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Enter an address, e.g. http://localhost:3000"
            aria-label="Address"
            spellCheck={false}
            className="h-8 text-[13px] focus-visible:ring-ring/30 md:text-[13px]"
          />
        </form>
        {designOffered ? (
          // The one control in this toolbar that is not navigation, and the only one a user has
          // to be told exists — so it carries its name, and wears the accent while it is on.
          <Button
            type="button"
            data-slot="browser-design-toggle"
            variant={designActive ? 'primary' : 'outline'}
            size="sm"
            aria-pressed={designActive}
            disabled={designUnavailable !== null || targetOrigin === null}
            title={
              designUnavailable ?? (targetOrigin === null ? 'Design Mode works on local http:// addresses'
              : designActive ? `Stop selecting elements (${formatChord(DESIGN_CHORD)} or Esc)`
              : `Click an element of the page to send it to the agent (${formatChord(DESIGN_CHORD)})`)
            }
            onClick={() => setDesign((on) => !on)}
            className="ml-1 disabled:opacity-40"
          >
            <MousePointerClickIcon aria-hidden="true" className="size-3.5" />
            Design Mode
            <kbd
              data-slot="browser-design-key"
              aria-hidden="true"
              className="ml-0.5 rounded border border-current/25 px-1 font-sans text-[10px] leading-4 opacity-70"
            >
              {formatChord(DESIGN_CHORD)}
            </kbd>
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
            subtitle="This cockpit runs remotely, so a local address would open on your computer rather than on the task's host. Open the cockpit on the task's machine to preview its app."
          />
        ) : target === '' && renderEmpty && canPreview ? (
          renderEmpty(commit)
        ) : target === '' ? (
          <CenteredState
            icon={<GlobeIcon />}
            tone="neutral"
            heading="h2"
            title="Empty tab"
            subtitle="Enter the address of the task's app, e.g. http://localhost:3000 — then switch on Design Mode to point at an element and tell the agent what to change."
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
            {adrift.length > 0 ? (
              <div data-slot="browser-design-adrift" className="absolute bottom-3 left-3 z-10 flex max-w-[60%] flex-wrap gap-1.5">
                {adrift.map((mark) => (
                  <Button
                    key={mark.key}
                    type="button"
                    variant="outline"
                    size="sm"
                    title="A note in progress — its element could not be found on this page"
                    onClick={() => {
                      setAnchor(mark.key)
                      setNoteOpen(true)
                    }}
                    className="max-w-48"
                  >
                    <span className="truncate">Draft · {mark.label}</span>
                  </Button>
                ))}
              </div>
            ) : null}
            {designAllowed && designTray ? (
              <div className="absolute right-3 bottom-3 z-10">{designTray}</div>
            ) : null}
            {designActive && status === 'idle' && !noteVisible && adrift.length === 0 && !designTray ? (
              <p
                data-slot="browser-design-hint"
                className="pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full border border-border bg-background/95 px-3 py-1 text-xs whitespace-nowrap text-soft-foreground shadow-sm"
              >
                {hasNote ? 'Click an element to write a note about it · Esc to stop' : 'Click an element to pick it · Esc to stop'}
              </p>
            ) : null}
            {awaitingProxy ? null : (
            <iframe
              ref={frameRef}
              // Keyed by the document (the address without its hash) AND the reload token so
              // Reload really re-fetches. It is the FRAMED address that keys it: entering Design
              // Mode swaps it for the mirror's.
              key={frameKey}
              src={frameSrc}
              title="Preview"
              onLoad={onLoaded}
              // Worktree-served content is untrusted. `allow-same-origin` keeps the page
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
            {anchor !== null ? renderDesignNote({ mark: anchor, close: closeNote }) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

const DESIGN_CHORD = 'Alt+D'

/** ⌥D / Alt+D, by the physical key: on a Mac ⌥D reports `∂`. Ctrl+Alt is AltGr off a Mac — typing. */
function isDesignKey(event: Pick<KeyboardEvent, 'code' | 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): boolean {
  const d = event.code ? event.code === 'KeyD' : event.key === 'd' || event.key === 'D'
  return d && event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey
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

/** One element the page keeps framed. Structural on purpose: this view knows frames, not notes. */
export interface DesignMark {
  key: string
  n?: number
  selector?: string
  path?: string
  label: string
  draft: boolean
}

const NO_MARKS: readonly DesignMark[] = []

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

/** `url` without its fragment — what names the document. */
function withoutHash(url: string): string {
  const at = url.indexOf('#')
  return at === -1 ? url : url.slice(0, at)
}

/** Whether moving from `from` to `to` stays in the same document: the same address up to the
 *  hash, and `to` HAS one (dropping the hash entirely is a real navigation, as in a browser). */
export function sameDocument(from: string, to: string): boolean {
  return from !== '' && to.includes('#') && withoutHash(from) === withoutHash(to)
}

function originOf(url: string): string | null {
  try {
    const origin = new URL(url).origin
    return origin === 'null' ? null : origin
  } catch {
    return null
  }
}

/**
 * What a framed page reported as its address, as an address of the APP: on the frame's own origin
 * (an in-page move cannot leave it) and, through a Design Mode mirror, renamed back to the app's
 * real origin — `tabs` never holds a mirror's port.
 */
export function pageAddress(reported: string, frameOrigin: string, appOrigin: string | null): string | null {
  let parsed: URL
  try {
    parsed = new URL(reported)
  } catch {
    return null
  }
  if (parsed.origin !== frameOrigin) return null
  const path = parsed.pathname + parsed.search + parsed.hash
  return normalizeAddress((appOrigin ?? frameOrigin) + path)
}

export function isLoopback(url: string): boolean {
  try {
    return LOOPBACK.test(new URL(url).hostname)
  } catch {
    return false
  }
}
