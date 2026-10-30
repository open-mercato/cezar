import { CheckIcon, LightbulbIcon, XIcon } from 'lucide-react'
import * as React from 'react'

import { quietLink } from '@/components/onboarding-kit'
import { Button } from '@/components/ui/button'
import { COMPOSER_TIPS, allTipsSeen, tipsForVisit, type ComposerTip, type TipPictureId } from '@/lib/composer-tips'
import { cn } from '@/lib/utils'

/**
 * Composer tips on `/new` (spec 2026-10-26-first-run-onboarding, § Composer tips): one card under
 * the composer that explains the control it points at, a halo on that control, and a small
 * moving picture of what it does. One or two per visit, chosen once the pills are on screen;
 * "Got it" and "Next tip" close them for good, "Don't show tips" closes all of them, and the quiet
 * "Tips" link that remains walks every tip again. A tip left on screen for a while counts as read
 * when the user leaves, so nobody meets the same card on every visit.
 */

/** A tip on screen this long when the user leaves is taken as read. */
const READ_AFTER_MS = 5_000

interface Rect {
  top: number
  left: number
  width: number
  height: number
}

export function ComposerTips({
  anchorRoot,
  ready,
  loaded,
  seen,
  off,
  onSeen,
  onOff,
}: {
  /** The positioned element the halo is placed in; the composer must be inside it. */
  anchorRoot: React.RefObject<HTMLElement | null>
  /** The pills are rendered and the composer is usable. */
  ready: boolean
  /** The workspace ui-state has answered — nothing shows before `seen` and `off` are known. */
  loaded: boolean
  seen: readonly string[] | undefined
  off: boolean | undefined
  onSeen: (id: string) => void
  onOff: (off: boolean) => void
}) {
  const [visit, setVisit] = React.useState<ComposerTip[] | null>(null)
  const [index, setIndex] = React.useState(0)
  const [present, setPresent] = React.useState<ReadonlySet<string>>(() => new Set())
  const [anchor, setAnchor] = React.useState<Rect | null>(null)
  const [arrowLeft, setArrowLeft] = React.useState<number | null>(null)
  const cardRef = React.useRef<HTMLDivElement>(null)
  const shownAt = React.useRef<number | null>(null)

  const composer = React.useCallback(() => anchorRoot.current?.querySelector<HTMLElement>('[data-slot="composer"]') ?? null, [anchorRoot])
  const presentAnchors = React.useCallback(() => {
    const root = composer()
    return new Set(root ? COMPOSER_TIPS.filter((tip) => root.querySelector(tip.anchor) !== null).map((tip) => tip.anchor) : [])
  }, [composer])

  // The visit's tips are picked ONCE, when the pills are first on screen; a pill that appears
  // later (health answering) joins the next visit rather than reshuffling this one.
  React.useEffect(() => {
    if (!ready || !loaded || visit !== null) return
    const onScreen = presentAnchors()
    setPresent(onScreen)
    setVisit(tipsForVisit({ seen, off, present: onScreen }))
  }, [ready, loaded, visit, seen, off, presentAnchors])

  const current = visit && ready ? visit[index] : undefined
  const currentId = current?.id

  // Where the control is, relative to the anchor root; re-measured when the row reflows.
  React.useLayoutEffect(() => {
    if (!current) {
      setAnchor(null)
      setArrowLeft(null)
      return
    }
    const root = anchorRoot.current
    const measure = () => {
      const element = composer()?.querySelector<HTMLElement>(current.anchor)
      if (!root || !element) {
        setAnchor(null)
        setArrowLeft(null)
        return
      }
      const base = root.getBoundingClientRect()
      const rect = element.getBoundingClientRect()
      setAnchor({ top: rect.top - base.top, left: rect.left - base.left, width: rect.width, height: rect.height })
      const card = cardRef.current?.getBoundingClientRect()
      setArrowLeft(card ? Math.min(Math.max(rect.left + rect.width / 2 - card.left, 18), Math.max(card.width - 18, 18)) : null)
    }
    measure()
    window.addEventListener('resize', measure)
    const observer = root && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    if (root) observer?.observe(root)
    return () => {
      window.removeEventListener('resize', measure)
      observer?.disconnect()
    }
  }, [current, anchorRoot, composer])

  const advance = React.useCallback(() => {
    if (!currentId) return
    onSeen(currentId)
    setIndex((at) => at + 1)
  }, [currentId, onSeen])

  // Using the control is the best "got it" there is — except the textarea, which the page
  // focuses on its own and which every task starts in.
  React.useEffect(() => {
    if (!current || current.anchor === 'textarea') return
    const element = composer()?.querySelector<HTMLElement>(current.anchor)
    if (!element) return
    element.addEventListener('click', advance)
    return () => element.removeEventListener('click', advance)
  }, [current, composer, advance])

  // A card that stayed up while the user wrote their task was read; closing the page says so.
  React.useEffect(() => {
    shownAt.current = currentId ? Date.now() : null
  }, [currentId])
  const latest = React.useRef({ currentId, onSeen })
  latest.current = { currentId, onSeen }
  React.useEffect(
    () => () => {
      const { currentId: id, onSeen: mark } = latest.current
      if (id && shownAt.current !== null && Date.now() - shownAt.current >= READ_AFTER_MS) mark(id)
    },
    [],
  )

  if (!loaded || !ready || visit === null) return null

  if (!current) {
    // Nothing (more) to show this visit: the quiet way back in. "Tips" brings the next ones;
    // once every tip on this screen has been closed, "Show me around" walks all of them again.
    const everything = allTipsSeen(seen, present) || off === true
    return (
      <div className="mt-3 flex justify-center">
        <button
          type="button"
          data-slot="composer-tips-link"
          onClick={() => {
            if (off) onOff(false)
            const onScreen = presentAnchors()
            setPresent(onScreen)
            setVisit(tipsForVisit({ seen, off: false, present: onScreen, replay: everything }))
            setIndex(0)
          }}
          className={cn(quietLink, 'text-[12px] text-soft-foreground')}
        >
          <LightbulbIcon className="size-3.5" aria-hidden="true" />
          {everything ? 'Show me around' : 'Tips'}
        </button>
      </div>
    )
  }

  const last = index >= visit.length - 1
  const large = anchor !== null && anchor.height > 40
  return (
    <>
      {anchor ? (
        <span
          data-slot="composer-tip-halo"
          aria-hidden="true"
          className={cn('composer-tip-halo pointer-events-none absolute z-10', large ? 'rounded-xl' : 'rounded-full')}
          style={{ top: anchor.top - 4, left: anchor.left - 4, width: anchor.width + 8, height: anchor.height + 8 }}
        />
      ) : null}
      <div data-slot="composer-tip" data-tip={current.id} role="note" aria-label={`Tip: ${current.title}`} className="relative mt-3">
        {arrowLeft !== null ? <span aria-hidden="true" className="composer-tip-arrow z-10" style={{ left: arrowLeft }} /> : null}
        <div ref={cardRef} className="onboarding-announcement relative flex items-stretch overflow-hidden rounded-xl border text-left">
          <div className="flex min-w-0 flex-1 flex-col justify-center p-5 pr-10 sm:pr-5">
            <span className="text-[11px] tracking-wide text-violet uppercase">
              Tip {index + 1} of {visit.length}
            </span>
            <span className="mt-1 text-lg font-light tracking-tight text-foreground">{current.title}</span>
            <p className="mt-1 max-w-md text-[13px] text-muted-foreground">{current.body}</p>
            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
              <Button size="sm" className="font-normal" onClick={advance}>
                {last ? 'Got it' : 'Next tip'}
              </Button>
              <button
                type="button"
                className={quietLink}
                onClick={() => {
                  onOff(true)
                  setIndex(visit.length)
                }}
              >
                Don’t show tips
              </button>
            </div>
          </div>
          <TipPicture id={current.picture} />
          <button
            type="button"
            onClick={advance}
            aria-label="Close tip"
            className="absolute top-3 right-3 grid size-7 place-items-center rounded-full text-soft-foreground hover:text-foreground"
          >
            <XIcon className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>
    </>
  )
}

// ---- pictures -----------------------------------------------------------------------------------
// Drawn from plain boxes, like the "What's new" miniatures, with one small movement each
// (`tip-rise`, `tip-progress`, `tip-draw`, `tip-drop` in index.css); still under reduced motion.

const line = 'h-1.5 rounded bg-muted'
const rowBase = 'tip-rise flex items-center gap-2 rounded-md px-2 py-1 text-[10.5px]'

function Stage({ children }: { children: React.ReactNode }) {
  return (
    <div className="onboarding-picture hidden w-60 shrink-0 items-end justify-center pt-5 pr-5 sm:flex" aria-hidden="true">
      <div className="w-full rounded-t-lg border border-b-0 border-border bg-background p-3 shadow-[0_-12px_40px_-20px_var(--violet)]">{children}</div>
    </div>
  )
}

function Rows({ rows, pick = 0, start = 0 }: { rows: readonly string[]; pick?: number; start?: number }) {
  return (
    <div className="flex flex-col gap-0.5">
      {rows.map((row, at) => (
        <div
          key={row}
          style={{ '--i': start + at } as React.CSSProperties}
          className={cn(rowBase, at === pick ? 'bg-violet/15 text-foreground' : 'text-muted-foreground')}
        >
          <span className={cn('size-1.5 rounded-full', at === pick ? 'bg-violet' : 'bg-muted-foreground/40')} />
          {row}
        </div>
      ))}
    </div>
  )
}

function TipPicture({ id }: { id: TipPictureId }) {
  switch (id) {
    case 'slash':
      return (
        <Stage>
          <div className="flex items-center gap-1 rounded-md border border-violet/60 px-2 py-1.5 font-mono text-[11px] text-foreground">
            <span className="text-violet">/</span>fix<span className="tip-caret ml-px h-3 w-px bg-violet" />
          </div>
          <div className="mt-2">
            <Rows rows={['fix-issue', 'write-tests', 'review-pr']} />
          </div>
        </Stage>
      )
    case 'source':
      return (
        <Stage>
          <div className="flex items-center py-3">
            {['Plan', 'Build', 'Review'].map((step, at) => (
              <React.Fragment key={step}>
                {at > 0 ? <span className="h-px flex-1 bg-muted-foreground/40" /> : null}
                <span
                  style={{ '--i': at } as React.CSSProperties}
                  className={cn('tip-rise rounded-md border px-2 py-1 text-[10.5px]', at === 1 ? 'border-violet text-foreground' : 'border-border text-muted-foreground')}
                >
                  {step}
                </span>
              </React.Fragment>
            ))}
          </div>
        </Stage>
      )
    case 'worktree':
    case 'base':
      return (
        <Stage>
          <svg viewBox="0 0 200 64" className="h-16 w-full" fill="none" strokeWidth="2" strokeLinecap="round">
            <path d="M12 48 H188" className="stroke-muted-foreground/50" />
            <path d="M60 48 C 80 48, 84 20, 104 20 H188" pathLength={1} className="tip-draw stroke-violet" />
            <circle cx="60" cy="48" r="3.5" className="fill-background stroke-muted-foreground/70" />
            <circle cx="150" cy="20" r="3.5" style={{ '--i': 2 } as React.CSSProperties} className="tip-rise fill-violet" />
          </svg>
          <div className="flex justify-between font-mono text-[10px] text-soft-foreground">
            <span>{id === 'base' ? 'base: main' : 'main'}</span>
            <span className="text-violet">{id === 'base' ? 'cez/1a2b' : 'worktree'}</span>
          </div>
        </Stage>
      )
    case 'autonomous':
      return (
        <Stage>
          <div className={cn(line, 'w-3/4')} />
          <div className={cn(line, 'mt-1.5 w-1/2')} />
          <div className="mt-3 h-1.5 w-full overflow-hidden rounded bg-muted">
            <div className="tip-progress h-full rounded bg-violet" />
          </div>
          <div className="mt-2 flex items-center justify-between text-[10.5px]">
            <span className="text-muted-foreground">No questions asked</span>
            <span style={{ '--i': 10 } as React.CSSProperties} className="tip-rise inline-flex items-center gap-1 text-success">
              <CheckIcon className="size-3" /> done
            </span>
          </div>
        </Stage>
      )
    case 'variants':
      return (
        <Stage>
          <div className="grid grid-cols-3 gap-1.5">
            {[0, 1, 2].map((at) => (
              <div
                key={at}
                style={{ '--i': at } as React.CSSProperties}
                className={cn('tip-rise rounded-md border p-1.5', at === 1 ? 'border-violet' : 'border-border')}
              >
                <div className={cn(line, 'w-full')} />
                <div className={cn(line, 'mt-1 w-2/3')} />
                <div className="mt-2 flex justify-end">
                  {at === 1 ? <CheckIcon className="size-3 text-violet" /> : <span className="size-3" />}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-2 text-center font-mono text-[10px] text-soft-foreground">×3 · keep one</div>
        </Stage>
      )
    case 'model':
      return (
        <Stage>
          <Rows rows={['auto', 'opus · hard work', 'haiku · small fixes']} pick={1} />
        </Stage>
      )
    case 'attachments':
      return (
        <Stage>
          <div className="flex items-center gap-2">
            <span className="tip-drop grid size-9 place-items-center rounded-md border border-violet/60 bg-violet/15">
              <span className="size-4 rounded-sm bg-violet/60" />
            </span>
            <span className="tip-drop grid h-9 items-center rounded-md border border-border px-2 text-[10.5px] text-muted-foreground" style={{ animationDelay: '900ms' }}>
              design.pdf
            </span>
          </div>
          <div className={cn(line, 'mt-3 w-2/3')} />
        </Stage>
      )
    case 'schedule':
      return (
        <Stage>
          <Rows rows={['Now', 'Tonight at 23:00', 'When the usage limit resets']} pick={1} />
        </Stage>
      )
    case 'dispatch':
      return (
        <Stage>
          <svg viewBox="0 0 200 72" className="h-[72px] w-full" fill="none" strokeWidth="2" strokeLinecap="round">
            <rect x="12" y="28" width="44" height="16" rx="4" className="stroke-violet" />
            {[12, 36, 60].map((y, at) => (
              <React.Fragment key={y}>
                <path d={`M56 36 C 90 36, 100 ${y}, 128 ${y}`} pathLength={1} style={{ '--i': at } as React.CSSProperties} className="tip-draw stroke-muted-foreground/60" />
                <rect x="128" y={y - 7} width="56" height="14" rx="4" style={{ '--i': at + 2 } as React.CSSProperties} className="tip-rise stroke-border fill-card" />
              </React.Fragment>
            ))}
          </svg>
        </Stage>
      )
    case 'ask':
      return (
        <Stage>
          <div className="ml-auto w-3/4 rounded-lg rounded-br-sm bg-violet/15 px-2 py-1 text-[10.5px] text-foreground">Where is the retry logic?</div>
          <div style={{ '--i': 2 } as React.CSSProperties} className="tip-rise mt-2 w-5/6 rounded-lg rounded-bl-sm border border-border px-2 py-1 text-[10.5px] text-muted-foreground">
            <span className="font-mono text-foreground">src/runs/retry.ts</span>, nothing changed.
          </div>
        </Stage>
      )
    case 'followups':
      return (
        <Stage>
          <div className="mb-1 text-[10px] tracking-wide text-soft-foreground uppercase">Inbox</div>
          <Rows rows={['Add a test for the empty case', 'Document the new flag', 'Remove the old helper'] as const} pick={0} />
        </Stage>
      )
    case 'templates':
      return (
        <Stage>
          <div className={cn(line, 'w-3/4')} />
          <div style={{ '--i': 1 } as React.CSSProperties} className="tip-rise mt-1.5 rounded-sm border border-violet/60 bg-violet/15 px-1.5 py-1 text-[10.5px] text-foreground">
            Run the tests and report what you ran.
          </div>
          <div className={cn(line, 'mt-1.5 w-1/2')} />
        </Stage>
      )
    case 'project':
      return (
        <Stage>
          <Rows rows={['shop-web', 'billing-api', 'docs']} pick={1} />
        </Stage>
      )
  }
}
