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

import { useHostTransport } from '@/api/host-usage'
import { CenteredState } from '@/components/centered-state'
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
  const frameRef = useRef<HTMLIFrameElement>(null)
  const transport = useHostTransport()
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

  const refused = target !== '' && transport === 'remote' && isLoopback(target)

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
    },
    [],
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
        return
      }
      // The tab to the right, or the previous one when there is none (spec §7).
      const nextActive = index < active ? active - 1 : Math.min(active, remaining.length - 1)
      onChange({ tabs: remaining, active: nextActive })
    },
    [active, onChange, tabs],
  )

  return (
    <div data-slot="browser-view" className="flex h-full min-h-0 flex-col">
      <div
        role="tablist"
        aria-label="Karty przeglądarki"
        className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border px-1 py-1"
      >
        {tabs.map((tab, index) => (
          <div
            key={index}
            data-slot="browser-tab"
            data-active={index === active ? '' : undefined}
            className={cn(
              'group flex h-6 shrink-0 items-center rounded pl-2 pr-0.5 text-xs',
              index === active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <button
              type="button"
              role="tab"
              aria-selected={index === active}
              onClick={() => onChange({ ...state, active: index })}
              title={tab || 'Nowa karta'}
              className="max-w-32 truncate outline-none focus-visible:underline"
            >
              {tabLabel(tab)}
            </button>
            <button
              type="button"
              aria-label={`Zamknij kartę ${tabLabel(tab)}`}
              onClick={() => closeTab(index)}
              className={cn(
                'ml-1 grid size-4 shrink-0 place-items-center rounded opacity-0 transition-opacity hover:bg-background focus-visible:opacity-100 group-hover:opacity-100',
                index === active && 'opacity-60',
              )}
            >
              <XIcon aria-hidden="true" className="size-3" />
            </button>
          </div>
        ))}
        {tabs.length < MAX_BROWSER_TABS ? (
          <button
            type="button"
            aria-label="Nowa karta"
            title="Nowa karta"
            onClick={addTab}
            className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <PlusIcon aria-hidden="true" className="size-3.5" />
          </button>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
        {/* Back and Forward drive the IFRAME's own history, which the embedder may not read —
            so they are offered unconditionally rather than disabled on a guess about depth. */}
        <ToolbarButton
          label="Wstecz"
          onClick={() => frameRef.current?.contentWindow?.history.back()}
          icon={<ArrowLeftIcon aria-hidden="true" className="size-3.5" />}
        />
        <ToolbarButton
          label="Dalej"
          onClick={() => frameRef.current?.contentWindow?.history.forward()}
          icon={<ArrowRightIcon aria-hidden="true" className="size-3.5" />}
        />
        <ToolbarButton
          label="Odśwież"
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
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Wpisz adres, np. http://localhost:3000"
            aria-label="Adres"
            spellCheck={false}
            className="w-full rounded border border-border bg-background px-2 py-1 text-xs outline-none focus-visible:border-foreground"
          />
        </form>
      </div>

      <div className="relative min-h-0 flex-1">
        {refused ? (
          <CenteredState
            icon={<TriangleAlertIcon />}
            tone="neutral"
            heading="h2"
            title="Ten adres wskazuje na maszynę, przy której siedzisz"
            subtitle="Ten cockpit działa zdalnie, więc adres lokalny otworzyłby się na Twoim komputerze, a nie na hoście zadania. Podgląd aplikacji zadania z trybu hosted wymaga proxy, którego jeszcze nie ma."
          />
        ) : target === '' ? (
          <CenteredState
            icon={<GlobeIcon />}
            tone="neutral"
            heading="h2"
            title="Pusta karta"
            subtitle="Wpisz adres powyżej. Zadziała każdy — także adres aplikacji uruchomionej w terminalu tego zadania."
          />
        ) : (
          <>
            {status === 'failed' ? (
              <div
                data-slot="browser-failed"
                className="absolute inset-x-0 top-0 z-10 border-b border-border bg-background px-3 py-2 text-xs text-soft-foreground"
              >
                <span className="font-medium text-foreground">Nie udało się otworzyć</span> — strona nie
                odpowiedziała albo nie pozwala się osadzić. Adres został w pasku, możesz go poprawić.
              </div>
            ) : null}
            <iframe
              ref={frameRef}
              // Keyed by the address AND the reload token so Reload really re-fetches.
              key={`${target}#${reloadToken}`}
              src={target}
              title="Podgląd"
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
                Ładowanie…
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
}: {
  label: string
  icon: React.ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      {icon}
    </button>
  )
}

/**
 * What a tab is called.
 *
 * Derived from the address, never from the page title: see the header comment — a cross-origin
 * document's title is unreadable by design, and a label that is silently wrong is worse than one
 * that is merely terse.
 */
export function tabLabel(url: string): string {
  if (url === '') return 'Nowa karta'
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
