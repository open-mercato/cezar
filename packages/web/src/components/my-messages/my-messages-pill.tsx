import { ArrowDownIcon, ChevronDownIcon, ChevronUpIcon, ImageIcon, MessageSquareTextIcon, PaperclipIcon } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type Ref } from 'react'

import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { useMediaQuery } from '@/lib/use-media-query'
import { cn } from '@/lib/utils'

import { myMessageDay, myMessagePreview, myMessageTime, type MyMessage } from './my-messages'
import type { MyMessagesNav } from './use-my-messages-nav'

/**
 * The "Jump to latest" control grown into `▲ · 💬 · ▼ | ↓` once the reader is away from the tail
 * (spec 2026-11-17-my-message-navigation). No numbers: the list marks every message on screen.
 */
export function MyMessagesPill({
  nav,
  onLatest,
  latestLabel = 'Jump to latest',
  latestSlot = 'my-messages-latest',
}: {
  nav: MyMessagesNav
  onLatest: () => void
  /** The view's existing wording and slot for the button this pill grew out of. */
  latestLabel?: string
  latestSlot?: string
}) {
  // A pointer that can hover gets the popover with its hover peek; touch gets the bottom sheet.
  const canHover = useMediaQuery('(hover: hover)')
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const pinnedRef = useRef(false)
  const jumped = useRef(false)
  pinnedRef.current = pinned
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const { refresh, targets } = nav
  useEffect(() => () => clearTimeout(timer.current), [])

  const show = (pin: boolean) => {
    clearTimeout(timer.current)
    refresh()
    if (pin) {
      pinnedRef.current = true
      setPinned(true)
    }
    setOpen(true)
  }
  const hide = (refocus = false) => {
    clearTimeout(timer.current)
    setOpen(false)
    setPinned(false)
    if (refocus) triggerRef.current?.focus()
  }
  const peek = () => {
    if (!canHover) return
    clearTimeout(timer.current)
    if (!open) timer.current = setTimeout(() => show(false), 150)
  }
  const leave = () => {
    clearTimeout(timer.current)
    if (open && !pinned) timer.current = setTimeout(() => hide(), 250)
  }
  // A pinned list takes the keyboard; a hover peek leaves focus where it was.
  useEffect(() => {
    if (open && pinned) listRef.current?.focus({ preventScroll: true })
  }, [open, pinned])

  const list = (
    <MyMessagesList
      ref={listRef}
      items={nav.items}
      onScreen={targets.onScreen}
      onPick={(id, done) => nav.jumpTo(id, () => {
        // The jump hands focus to the message: the closing sheet must not take it back.
        jumped.current = true
        hide()
        done()
      })}
      onEscape={() => hide(true)}
    />
  )
  const segment =
    'inline-flex w-8 shrink-0 items-center justify-center outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-35 pointer-coarse:max-md:w-11'

  return (
    <div
      role="group"
      aria-label="Your messages"
      data-slot="my-messages"
      onPointerLeave={leave}
      className="pointer-events-auto inline-flex h-8 items-stretch overflow-hidden rounded-full border border-border bg-background text-xs font-medium text-muted-foreground shadow-modal pointer-coarse:max-md:h-10"
    >
      <button type="button" data-slot="my-messages-prev" aria-label="Previous message of yours" disabled={!targets.prev} onClick={() => void nav.prev()} className={cn(segment, 'pl-0.5')}>
        <ChevronUpIcon aria-hidden="true" className="size-4" />
      </button>
      {canHover ? (
        <Popover open={open} onOpenChange={(next) => (next ? show(true) : hide())} modal={false}>
          <PopoverAnchor asChild>
            <button
              ref={triggerRef}
              type="button"
              data-slot="my-messages-list-button"
              aria-label="Your messages"
              title="Your messages"
              aria-haspopup="listbox"
              aria-expanded={open}
              onPointerEnter={(event) => { if (event.pointerType === 'mouse') peek() }}
              onClick={() => (open && pinned ? hide() : show(true))}
              onKeyDown={(event) => {
                if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                  event.preventDefault()
                  show(true)
                }
              }}
              className={cn(segment, 'border-x border-border aria-expanded:bg-muted aria-expanded:text-foreground')}
            >
              <MessageSquareTextIcon aria-hidden="true" className="size-4" />
            </button>
          </PopoverAnchor>
          <PopoverContent
            side="top"
            sideOffset={8}
            data-slot="my-messages-popover"
            onOpenAutoFocus={(event) => {
              event.preventDefault()
              if (pinnedRef.current) listRef.current?.focus({ preventScroll: true })
            }}
            onCloseAutoFocus={(event) => event.preventDefault()}
            onPointerEnter={() => clearTimeout(timer.current)}
            onPointerLeave={leave}
            className="w-[340px] max-w-[calc(100vw-24px)] overflow-hidden rounded-lg p-0 shadow-modal"
          >
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <span className="eyebrow text-muted-foreground">Your messages</span>
            </div>
            {list}
          </PopoverContent>
        </Popover>
      ) : (
        <>
          <button
            ref={triggerRef}
            type="button"
            data-slot="my-messages-list-button"
            aria-label="Your messages"
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => show(true)}
            className={cn(segment, 'border-x border-border')}
          >
            <MessageSquareTextIcon aria-hidden="true" className="size-4" />
          </button>
          <Sheet open={open} onOpenChange={(next) => (next ? show(true) : hide())}>
            <SheetContent
              side="bottom"
              // The list takes focus, as the popover's does: the close button stays a tap target.
              onOpenAutoFocus={(event) => {
                event.preventDefault()
                listRef.current?.focus({ preventScroll: true })
              }}
              onCloseAutoFocus={(event) => {
                if (!jumped.current) return
                jumped.current = false
                event.preventDefault()
              }}
              data-slot="my-messages-sheet" className="max-h-[72dvh] gap-0 rounded-t-2xl pb-[env(safe-area-inset-bottom)] [&_[data-slot=my-messages-day]]:bg-background">
              <SheetHeader className="border-b border-border px-4 py-3">
                <SheetTitle>Your messages</SheetTitle>
                <SheetDescription className="sr-only">Pick a message to jump to it.</SheetDescription>
              </SheetHeader>
              {list}
            </SheetContent>
          </Sheet>
        </>
      )}
      <button type="button" data-slot="my-messages-next" aria-label="Next message of yours" disabled={!targets.next} onClick={() => void nav.next()} className={segment}>
        <ChevronDownIcon aria-hidden="true" className="size-4" />
      </button>
      <span aria-hidden="true" className="w-px shrink-0 bg-border" />
      <button
        type="button"
        data-slot={latestSlot}
        data-my-messages-latest=""
        aria-label={latestLabel}
        onClick={() => { hide(); onLatest() }}
        className={cn(segment, 'w-auto gap-1.5 pr-3.5 pl-2.5 max-md:w-8 max-md:px-0 pointer-coarse:max-md:w-11')}
      >
        <ArrowDownIcon aria-hidden="true" className="size-3.5" />
        <span className="max-md:hidden">Latest</span>
      </button>
    </div>
  )
}

/** The listbox both the popover and the sheet hold. Oldest at the top, like the transcript. */
export function MyMessagesList({
  items,
  onScreen,
  onPick,
  onEscape,
  ref,
}: {
  items: readonly MyMessage[]
  onScreen: readonly string[]
  onPick: (id: string, done: () => void) => Promise<void>
  onEscape: () => void
  ref?: Ref<HTMLDivElement>
}) {
  const baseId = useId()
  const optionId = (id: string) => `${baseId}-${id.replace(/[^A-Za-z0-9_-]/g, '_')}`
  // Opens on the message on screen, else the newest.
  const [active, setActive] = useState(() => onScreen[0] ?? items.at(-1)?.id)
  const [loading, setLoading] = useState<string | undefined>(undefined)
  const groups = useMemo(() => {
    const out: { day: string; items: MyMessage[] }[] = []
    for (const item of items) {
      const day = myMessageDay(item.ts)
      if (out.at(-1)?.day !== day) out.push({ day, items: [] })
      out.at(-1)!.items.push(item)
    }
    return out
  }, [items])
  useEffect(() => {
    if (active === undefined) return
    document.getElementById(optionId(active))?.scrollIntoView?.({ block: "nearest" })
    // Only on a move: re-running per render would fight the reader's own scroll.
  }, [active]) // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (id: string) => {
    if (loading !== undefined) return
    setLoading(id)
    void onPick(id, () => setLoading(undefined)).finally(() => setLoading(undefined))
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const ids = items.filter((item) => !item.pending).map((item) => item.id)
    const at = active === undefined ? ids.length : ids.indexOf(active)
    const move = (to: number) => {
      event.preventDefault()
      const id = ids[Math.max(0, Math.min(ids.length - 1, to))]
      if (id !== undefined) setActive(id)
    }
    if (event.key === 'ArrowDown') move(at + 1)
    else if (event.key === 'ArrowUp') move(at - 1)
    else if (event.key === 'Home') move(0)
    else if (event.key === 'End') move(ids.length - 1)
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (active !== undefined) pick(active)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onEscape()
    }
  }

  return (
    <div
      ref={ref}
      role="listbox"
      tabIndex={-1}
      aria-label="Your messages"
      aria-activedescendant={active !== undefined ? optionId(active) : undefined}
      data-slot="my-messages-list"
      onKeyDown={onKeyDown}
      className="max-h-[328px] overflow-y-auto overscroll-contain p-1 outline-none [scrollbar-width:thin] max-md:max-h-none max-md:flex-1"
    >
      {groups.map((group, index) => (
        // A queued message is stamped later than the turns below it, so a day label can recur.
        <div key={`${index}:${group.day}`} role="presentation">
          <div role="presentation" data-slot="my-messages-day" className="sticky top-0 z-[1] bg-popover px-2 pt-2 pb-1 text-meta font-medium text-soft-foreground">
            {group.day}
          </div>
          {group.items.map((item) => {
            const here = onScreen.includes(item.id)
            const preview = myMessagePreview(item.text)
            return (
              <div
                key={item.id}
                id={optionId(item.id)}
                role="option"
                aria-selected={item.id === active}
                aria-current={here || undefined}
                aria-disabled={item.pending ? true : undefined}
                data-slot="my-messages-item"
                data-message-id={item.id}
                title={item.text}
                onPointerMove={() => { if (!item.pending) setActive(item.id) }}
                onClick={() => { if (!item.pending) pick(item.id) }}
                className={cn(
                  'relative grid cursor-pointer grid-cols-[40px_1fr_auto] items-start gap-x-2.5 rounded-sm py-1.5 pr-2 pl-2.5 aria-disabled:cursor-default pointer-coarse:max-md:min-h-11 pointer-coarse:max-md:grid-cols-[44px_1fr_auto] pointer-coarse:max-md:py-2.5',
                  item.id === active && 'bg-muted ring-1 ring-ring/55 ring-inset',
                  here && 'before:absolute before:top-2 before:bottom-2 before:left-0.5 before:w-[3px] before:rounded-full before:bg-violet',
                )}
              >
                <span className={cn('pt-px text-meta tabular-nums text-soft-foreground', here && 'text-violet')}>{myMessageTime(item.ts)}</span>
                <span className={cn('line-clamp-2 text-label leading-snug break-words text-foreground/85 pointer-coarse:max-md:text-sm', preview === '' && 'text-muted-foreground italic')}>
                  {item.pending ? <span className="mr-1.5 rounded-sm bg-muted px-1 text-micro font-semibold text-muted-foreground not-italic">Queued</span> : null}
                  {preview !== '' ? preview : item.images > 0 ? 'Image' : item.files > 0 ? 'File' : 'Empty message'}
                </span>
                <span className="flex items-center gap-1.5 pt-0.5 text-meta text-soft-foreground">
                  {item.images > 0 ? <span className="inline-flex items-center gap-0.5" aria-label={`${item.images} image${item.images > 1 ? 's' : ''}`}><ImageIcon aria-hidden="true" className="size-3" />{item.images}</span> : null}
                  {item.files > 0 ? <span className="inline-flex items-center gap-0.5" aria-label={`${item.files} file${item.files > 1 ? 's' : ''}`}><PaperclipIcon aria-hidden="true" className="size-3" />{item.files}</span> : null}
                </span>
                {loading === item.id ? (
                  <span className="col-span-2 col-start-2 mt-1 flex items-center gap-1.5 text-meta text-muted-foreground">
                    <Spinner className="size-3" />
                    Loading earlier messages…
                  </span>
                ) : null}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}
