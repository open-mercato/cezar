import {
  ArrowLeftIcon,
  ArrowRightIcon,
  GlobeIcon,
  PlusIcon,
  RotateCwIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { useHealth } from '@/api/queries'
import { CenteredState } from '@/components/centered-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

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
}: {
  state: BrowserState
  /** Persisted into the column (spec §7). Called only for changes worth keeping — a successful
   *  load, a tab opened or closed — never for a failed attempt. */
  onChange: (state: BrowserState) => void
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
    [active, current],
  )

  /** Back (`-1`) and Forward (`+1`) — a move along this tab's own stack. */
  const go = useCallback(
    (delta: -1 | 1) => {
      const position = nav.position + delta
      const url = nav.stack[position]
      if (url === undefined) return
      setNavByTab((byTab) => ({ ...byTab, [active]: { stack: nav.stack, position } }))
      setTarget(url)
      setDraft(url)
      setStatus('loading')
      setReloadToken((token) => token + 1)
    },
    [active, nav.position, nav.stack],
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
      </div>

      <div className="relative min-h-0 flex-1">
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
            <iframe
              // Keyed by the address AND the reload token so Reload really re-fetches.
              key={`${target}#${reloadToken}`}
              src={target}
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
            {status === 'loading' ? (
              <p className="absolute inset-0 grid place-items-center text-xs text-soft-foreground">
                Loading…
              </p>
            ) : null}
          </>
        )}
      </div>
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

export function isLoopback(url: string): boolean {
  try {
    return LOOPBACK.test(new URL(url).hostname)
  } catch {
    return false
  }
}
