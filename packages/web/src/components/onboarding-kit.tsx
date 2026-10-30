import { useQueryClient } from '@tanstack/react-query'
import { ArrowRightIcon } from 'lucide-react'
import * as React from 'react'

import { putWorkspaceUiState } from '@/api/client'
import { workspaceQueryKeys } from '@/api/queries'
import type { WorkspaceUiState } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { toast } from '@/components/ui/toaster'
import { cn } from '@/lib/utils'

/**
 * The onboarding surfaces' shared grammar (spec 2026-10-26-first-run-onboarding, § Layout and
 * § Palette): a centred page with a large light title, dialogs with a header band and a footer
 * band, illustrated choice tiles and the miniature app window the pictures are drawn in. Every
 * root carries `data-onboarding`, which swaps `--primary` for the violet family on that surface
 * only. First run, the `/new` composer and the automations explainer all build from here.
 */

type OnboardingPrefs = NonNullable<WorkspaceUiState['onboarding']>

/** Merge a patch into the workspace `onboarding` prefs: optimistic, reverted with a toast on error.
 *  A function patch reads the prefs as the cache holds them NOW, so two writes in one tick do not
 *  overwrite each other's lists. */
export function useOnboardingWrite() {
  const queryClient = useQueryClient()
  return React.useCallback(
    (patch: OnboardingPrefs | ((current: OnboardingPrefs | undefined) => OnboardingPrefs)) => {
      const key = workspaceQueryKeys.uiState
      const previous = queryClient.getQueryData<WorkspaceUiState>(key)
      const onboarding = { ...previous?.onboarding, ...(typeof patch === 'function' ? patch(previous?.onboarding) : patch) }
      queryClient.setQueryData<WorkspaceUiState>(key, { ...previous, onboarding })
      putWorkspaceUiState({ onboarding })
        .then((merged) => queryClient.setQueryData(key, merged))
        .catch((error: unknown) => {
          queryClient.setQueryData(key, previous)
          toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
        })
    },
    [queryClient],
  )
}

export function OnboardingPage({
  title,
  slot,
  rail,
  why,
  subtitle,
  banner,
  wide = false,
  children,
}: {
  title: string
  slot: string
  /** The step rail of the two first-run obstacle pages; a goal page carries none. */
  rail?: React.ReactNode
  /** One line under the title: why this matters, in plain words. */
  why?: string
  subtitle?: React.ReactNode
  banner?: React.ReactNode
  /** Room for three tiles and a step row side by side. */
  wide?: boolean
  children: React.ReactNode
}) {
  return (
    <section
      data-onboarding=""
      data-slot="first-run"
      data-first-run={slot}
      className={cn(
        'mx-auto flex w-full flex-1 flex-col items-center px-1 pt-6 pb-12 text-center md:pt-12',
        wide ? 'max-w-3xl' : 'max-w-2xl',
      )}
    >
      {banner}
      {rail}
      <h2 className={cn('text-4xl font-light tracking-tight text-balance text-foreground', rail && 'mt-8')}>{title}</h2>
      {why ? <p className="mt-3 max-w-md text-[15px] text-muted-foreground">{why}</p> : null}
      {subtitle ? <p className="mt-2 text-[14px] text-muted-foreground">{subtitle}</p> : null}
      {children}
    </section>
  )
}

export const quietLink = 'inline-flex items-center gap-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground'

export const chipLink =
  'inline-flex h-[30px] items-center gap-1.5 rounded-full border border-border px-3 text-[12.5px] text-muted-foreground transition-colors hover:border-muted-foreground hover:text-foreground'

/** The welcome page's suggestion chip: an icon and a label, no border, a wash on hover. */
export const ghostChip =
  'inline-flex h-8 items-center gap-2 rounded-full px-3 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground'

/**
 * Half the desktop sidebar's width: an onboarding dialog belongs to the page it opened from, so it
 * centres over the content column, not the whole window. Zero below `md`, where the sidebar is a
 * drawer and the content is the window.
 */
export function useContentCenterOffset(): number {
  const [offset, setOffset] = React.useState(0)
  React.useLayoutEffect(() => {
    const measure = () => {
      const sidebar = document.querySelector<HTMLElement>('aside[data-slot="sidebar"]')
      setOffset(sidebar ? Math.max(0, sidebar.getBoundingClientRect().right) / 2 : 0)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])
  return offset
}

/** Every onboarding dialog: a header band (title, one line), a body, a footer band with the buttons. */
export function OnboardingDialog({
  title,
  description,
  onOpenChange,
  onSubmit,
  footer,
  wide = false,
  children,
}: {
  title: string
  description: string
  /** Room for a picture: "What's new" draws each feature. */
  wide?: boolean
  onOpenChange: (open: boolean) => void
  /** Cmd/Ctrl+Enter. */
  onSubmit?: () => void
  footer: React.ReactNode
  children: React.ReactNode
}) {
  const contentOffset = useContentCenterOffset()
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        data-onboarding=""
        className={cn('gap-0 p-0', wide ? 'sm:max-w-lg' : 'sm:max-w-md')}
        style={contentOffset ? { left: `calc(50% + ${contentOffset}px)` } : undefined}
        onKeyDown={(event) => {
          if (onSubmit && event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            onSubmit()
          }
        }}
      >
        <DialogHeader className="border-b border-border px-6 py-5 text-left">
          <DialogTitle className="text-xl font-light tracking-tight">{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="px-6 py-5 text-left">{children}</div>
        <DialogFooter className="border-t border-border px-6 py-4">{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export interface GuidePage {
  id: string
  title: string
  body: string
  /** A miniature drawn with the cockpit's own surfaces, on the violet stage. */
  picture: React.ReactNode
  /** A way to the thing explained, when it has a place. */
  action?: { label: string; onClick: () => void }
}

/**
 * One idea per page (the "What's new" shape, HubSpot and Relume's pattern): a picture, a title,
 * one or two sentences. Page dots and Back/Next in the footer; arrow keys page, ⌘↵ goes on.
 */
export function GuideDialog({
  title,
  description,
  pages,
  slot,
  onOpenChange,
}: {
  title: string
  description: string
  pages: readonly GuidePage[]
  slot: string
  onOpenChange: (open: boolean) => void
}) {
  const [index, setIndex] = React.useState(0)
  const page = pages[Math.min(index, pages.length - 1)]
  if (!page) return null
  const last = index >= pages.length - 1
  const next = () => (last ? onOpenChange(false) : setIndex(index + 1))
  return (
    <OnboardingDialog
      wide
      title={title}
      description={description}
      onOpenChange={onOpenChange}
      onSubmit={next}
      footer={
        <div className="flex w-full items-center gap-2">
          <span className="mr-auto flex items-center gap-1.5" aria-label={`${index + 1} of ${pages.length}`}>
            {pages.map((entry, at) => (
              <span key={entry.id} aria-hidden="true" className={cn('h-1.5 rounded-full transition-all', at === index ? 'w-4 bg-violet' : 'w-1.5 bg-border')} />
            ))}
          </span>
          {index > 0 ? (
            <Button variant="outline" className="font-normal" onClick={() => setIndex(index - 1)}>
              Back
            </Button>
          ) : null}
          <Button className="font-normal" onClick={next}>
            {last ? 'Done' : 'Next'}
          </Button>
        </div>
      }
    >
      <div
        data-slot={slot}
        data-page={page.id}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight' && !last) setIndex(index + 1)
          if (event.key === 'ArrowLeft' && index > 0) setIndex(index - 1)
        }}
      >
        <div aria-hidden="true" className="onboarding-preview flex h-44 items-end justify-center overflow-hidden rounded-lg border border-border px-8 pt-6">
          {page.picture}
        </div>
        <div className="mt-5 flex min-h-28 flex-col">
          <h3 className="text-lg font-light tracking-tight text-foreground">{page.title}</h3>
          <p className="mt-1 text-[13px] text-muted-foreground">{page.body}</p>
          {page.action ? (
            <button
              type="button"
              onClick={() => {
                onOpenChange(false)
                page.action?.onClick()
              }}
              className="mt-3 inline-flex items-center gap-1 self-start text-[13px] text-violet hover:underline"
            >
              {page.action.label}
              <ArrowRightIcon className="size-3.5" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>
    </OnboardingDialog>
  )
}

export function ChoiceTile({
  title,
  description,
  picture,
  recommended = false,
  badge = 'Start here',
  onClick,
}: {
  title: string
  description: string
  picture: React.ReactNode
  recommended?: boolean
  /** The corner label a recommended tile wears. */
  badge?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-recommended={recommended || undefined}
      className={cn(
        'group relative flex flex-col items-center gap-4 rounded-xl border px-4 pt-7 pb-5 text-center transition-colors',
        recommended ? 'onboarding-announcement' : 'border-border bg-card hover:border-muted-foreground',
      )}
    >
      {recommended ? <span className="absolute top-3 right-3 text-[11px] tracking-wide text-violet uppercase">{badge}</span> : null}
      <span className="grid h-16 place-items-center" aria-hidden="true">
        {picture}
      </span>
      <span className="flex flex-col gap-1">
        <span className="text-lg font-light text-foreground">{title}</span>
        <span className="text-[12.5px] text-muted-foreground">{description}</span>
      </span>
    </button>
  )
}

/** A tiny app window the feature pictures are drawn in: three dots, an optional bar, a body. */
export function PreviewWindow({ bar, children, className }: { bar?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('w-full max-w-xs rounded-t-lg border border-b-0 border-border bg-background shadow-[0_-12px_40px_-20px_var(--violet)]', className)}>
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-2">
        <span className="size-1.5 rounded-full bg-muted-foreground/40" />
        <span className="size-1.5 rounded-full bg-muted-foreground/40" />
        <span className="size-1.5 rounded-full bg-muted-foreground/40" />
        {bar}
      </div>
      <div className="p-3">{children}</div>
    </div>
  )
}

export const previewLine = 'h-2 rounded bg-muted'
