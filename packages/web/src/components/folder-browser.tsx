import { ChevronRightIcon, CornerLeftUpIcon, FolderIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { useFsBrowse } from '@/api/queries'
import type { FsBrowseDir } from '@open-mercato/cezar-api-client'
import { cn } from '@/lib/utils'

/**
 * The server-side folder picker, shared by "Add project" and "Add agent account".
 *
 * Extracted from `add-project-dialog.tsx` when accounts needed the same browse (spec
 * 2026-07-29-agent-profiles) — every `data-slot` is unchanged, because they are what the
 * existing suites and the e2e specs address rows by.
 *
 * Three shapes of `GET /api/v1/fs/browse` this is deliberately faithful to, because each is a
 * place a picker usually lies:
 *
 * - **`parent === null` means the browse root.** No "up" row is rendered there — the root's
 *   parent is not part of the surface, and a row that 400s is worse than no row.
 * - **`truncated`** is surfaced as a visible note. A silently short listing in a huge directory
 *   would read as "the folder isn't there".
 * - **Any folder is selectable.** `isRepo` only earns a badge; nothing here invents a
 *   restriction the server does not have.
 *
 * Browse errors are shown VERBATIM — the server writes them for the person reading them.
 */
export function FolderBrowser({
  path,
  selected,
  onSelect,
  onEnter,
  decorate,
  emptyHint,
  showHidden = false,
}: {
  /** `null` = the independently configured browse root. Callers never spell that path. */
  path: string | null
  selected: FsBrowseDir | null
  onSelect: (dir: FsBrowseDir) => void
  onEnter: (path: string) => void
  /** Extra badges for a row — e.g. "already added". */
  decorate?: (dir: FsBrowseDir) => ReactNode
  /** What an empty directory says; the caller words it for its own confirm button. */
  emptyHint: string
  /** Include dot-directories. Off for projects, which are not hidden; ON for agent accounts,
   *  where every candidate is a dotfolder (`~/.claude-klaudiusz`) and hiding them made the picker
   *  unable to show the only thing it existed to show. */
  showHidden?: boolean
}) {
  const listing = useFsBrowse(path, showHidden)
  const parent = listing.data?.parent ?? null

  return (
    <>
      {/* The breadcrumb is the server's realpath'd answer, not the spelling we asked for. */}
      <p
        data-slot="fs-breadcrumb"
        className="truncate font-mono text-[11.5px] text-soft-foreground"
        title={listing.data?.path ?? undefined}
      >
        {listing.data?.path ?? (listing.isError ? '' : 'Loading…')}
      </p>

      {listing.isError ? (
        <p data-slot="fs-error" className="min-w-0 break-words text-[13px] text-danger">
          {listing.error instanceof Error ? listing.error.message : 'could not list that folder'}
        </p>
      ) : (
        <ul
          data-slot="fs-listing"
          className="max-h-64 divide-y divide-border/60 overflow-y-auto overscroll-contain rounded-md border border-border"
        >
          {/* Only when the server said there IS a parent — at the root there is no up. */}
          {parent !== null ? (
            <li className="flex">
              <button
                type="button"
                data-slot="fs-up"
                onClick={() => onEnter(parent)}
                className="flex flex-1 items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-muted"
              >
                <CornerLeftUpIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                Up one level
              </button>
            </li>
          ) : null}
          {(listing.data?.dirs ?? []).map((dir) => (
            <li key={dir.path} className="flex items-stretch">
              <button
                type="button"
                data-slot="fs-dir"
                aria-pressed={selected?.path === dir.path}
                onClick={() => onSelect(dir)}
                onDoubleClick={() => onEnter(dir.path)}
                className={cn(
                  'flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-muted',
                  selected?.path === dir.path && 'bg-muted',
                )}
              >
                <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="truncate">{dir.name}</span>
                {decorate?.(dir)}
              </button>
              {/* Navigating IN is its own control rather than a click-to-enter row: the row
                  click has to stay "select this one", or the folder you actually want (the one
                  you can see) would be the one you cannot choose. Double-click enters too. */}
              <button
                type="button"
                data-slot="fs-enter"
                aria-label={`Open ${dir.name}`}
                onClick={() => onEnter(dir.path)}
                className="flex shrink-0 items-center px-2.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <ChevronRightIcon className="size-3.5" aria-hidden="true" />
              </button>
            </li>
          ))}
          {listing.data && listing.data.dirs.length === 0 ? (
            <li className="px-3 py-2 text-[13px] text-muted-foreground">{emptyHint}</li>
          ) : null}
        </ul>
      )}

      {listing.data?.truncated ? (
        <p data-slot="fs-truncated" className="text-[11.5px] text-muted-foreground">
          Too many folders to list — only the first ones are shown.
        </p>
      ) : null}
    </>
  )
}

/** The folder a picker would act on: the explicit selection, else the one being viewed. */
export function useBrowseTarget(
  path: string | null,
  selected: FsBrowseDir | null,
  showHidden = false,
): string | null {
  const listing = useFsBrowse(path, showHidden)
  return selected?.path ?? listing.data?.path ?? null
}
