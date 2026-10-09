import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * The page frame every routed view shares (cockpit concept 2).
 *
 * The shell's top bar already says WHERE you are (the breadcrumb), so a page header here is for
 * what the page IS and what you can do on it: one title, an optional one-line description, and
 * the page's actions on the right. Everything below sits on one centred column with generous,
 * consistent gutters — the single biggest lever on "calm" is that no page invents its own.
 *
 *   <Page>
 *     <PageHeader title="Skills" description="Playbooks your agents can follow." actions={…} />
 *     <PageToolbar>…filters, search, view switch…</PageToolbar>
 *     <PageBody>…</PageBody>
 *   </Page>
 */

const WIDTHS = {
  /** Reading and forms: settings panes, a single document. */
  narrow: 'max-w-3xl',
  /** The default: lists, tables, card grids. */
  default: 'max-w-6xl',
  /** Dense tables and dashboards that want the room. */
  wide: 'max-w-[1400px]',
  /** Edge to edge: canvases, split panes, the task workspace. */
  full: 'max-w-none',
} as const

export type PageWidth = keyof typeof WIDTHS

const PageWidthContext = React.createContext<PageWidth>('default')

export function Page({
  width = 'default',
  className,
  children,
  ...props
}: React.ComponentProps<'div'> & { width?: PageWidth }) {
  return (
    <PageWidthContext.Provider value={width}>
      <div data-slot="page" className={cn('flex min-h-full flex-col', className)} {...props}>
        {children}
      </div>
    </PageWidthContext.Provider>
  )
}

/** One row of the page column: applies the page's width and gutters. */
export function PageRow({ className, ...props }: React.ComponentProps<'div'>) {
  const width = React.useContext(PageWidthContext)
  return <div className={cn('mx-auto w-full px-4 sm:px-6 lg:px-8', WIDTHS[width], className)} {...props} />
}

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
  className,
  children,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  /** Right-aligned controls — at most one solid button; the rest outline or ghost. */
  actions?: React.ReactNode
  /** A small line above the title: a status, a parent, a count. */
  eyebrow?: React.ReactNode
  className?: string
  /** Rendered under the title row, inside the header: tabs, a summary strip. */
  children?: React.ReactNode
}) {
  return (
    <PageRow data-slot="page-header" className={cn('pt-6 pb-4 sm:pt-8', className)}>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1 space-y-1">
          {eyebrow ? <div className="text-xs font-medium text-muted-foreground">{eyebrow}</div> : null}
          <h1 className="truncate text-[22px] leading-7 font-semibold text-foreground">{title}</h1>
          {description ? (
            <p className="max-w-2xl text-sm text-pretty text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children ? <div className="pt-4">{children}</div> : null}
    </PageRow>
  )
}

/** Filters, search and view switches: one quiet row between the header and the content. */
export function PageToolbar({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <PageRow
      data-slot="page-toolbar"
      className={cn('flex flex-wrap items-center gap-2 pb-4', className)}
      {...props}
    />
  )
}

export function PageBody({ className, ...props }: React.ComponentProps<'div'>) {
  return <PageRow data-slot="page-body" className={cn('flex-1 pb-10', className)} {...props} />
}

/** A titled block inside a page body. Sections are separated by space, not by boxes. */
export function PageSection({
  title,
  description,
  actions,
  className,
  children,
}: {
  title?: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  return (
    <section data-slot="page-section" className={cn('space-y-3 not-first:pt-8', className)}>
      {title || actions ? (
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0 space-y-0.5">
            {title ? <h2 className="text-[15px] font-semibold text-foreground">{title}</h2> : null}
            {description ? <p className="text-[13px] text-muted-foreground">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  )
}
