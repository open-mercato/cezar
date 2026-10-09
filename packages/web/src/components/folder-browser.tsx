import { ChevronRightIcon, CornerLeftUpIcon, FolderIcon, FolderOpenIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { ApiError } from '@/api/client'
import { useFsBrowse } from '@/api/queries'
import type { FsBrowseDir } from '@open-mercato/cezar-api-client'
import { cn } from '@/lib/utils'

/** System Settings ▸ Privacy & Security ▸ Files & Folders. */
const PRIVACY_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders'
const errorAction =
  'inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-card px-2.5 font-medium text-foreground shadow-2xs hover:bg-muted'

/** The folder a failed listing can step back to — the same path minus its last segment. */
function parentOf(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (cut < 0) return null
  return cut === 0 ? trimmed.slice(0, 1) : trimmed.slice(0, cut)
}

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
        className="flex min-w-0 items-center gap-1.5 rounded-md bg-muted px-2.5 py-1.5 font-mono text-xs text-muted-foreground"
        title={listing.data?.path ?? undefined}
      >
        <FolderOpenIcon className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{listing.data?.path ?? (listing.isError ? '' : 'Loading…')}</span>
      </p>

      {listing.isError ? (
        <div className="flex min-w-0 flex-col gap-2">
          <p data-slot="fs-error" className="min-w-0 break-words text-[13px] text-danger">
            {listing.error instanceof Error ? listing.error.message : 'could not list that folder'}
          </p>
          {/* macOS remembers a "Don't Allow" and never asks again — the switch is in System
              Settings. The desktop shell hands a `_blank` link to `open`, which opens the pane. */}
          {listing.error instanceof ApiError && listing.error.status === 403 ? (
            <p data-slot="fs-privacy-hint" className="text-[13px] text-muted-foreground">
              Allow it under Privacy &amp; Security ▸ Files &amp; Folders, then try again.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2 text-[13px]">
            {path !== null && parentOf(path) !== null ? (
              <button type="button" data-slot="fs-error-back" onClick={() => onEnter(parentOf(path)!)} className={errorAction}>
                <CornerLeftUpIcon className="size-3.5" aria-hidden />
                Back
              </button>
            ) : null}
            {listing.error instanceof ApiError && listing.error.status === 403 ? (
              <>
                <a data-slot="fs-privacy-settings" href={PRIVACY_SETTINGS_URL} target="_blank" rel="noreferrer" className={errorAction}>
                  Open Privacy Settings
                </a>
                <button type="button" data-slot="fs-retry" onClick={() => void listing.refetch()} className={errorAction}>
                  Try again
                </button>
              </>
            ) : null}
          </div>
        </div>
      ) : (
        <ul
          data-slot="fs-listing"
          className="max-h-64 overflow-y-auto overscroll-contain rounded-lg border border-border bg-card p-1"
        >
          {/* Only when the server said there IS a parent — at the root there is no up. */}
          {parent !== null ? (
            <li className="flex">
              <button
                type="button"
                data-slot="fs-up"
                onClick={() => onEnter(parent)}
                className="flex h-9 flex-1 items-center gap-2 rounded-md px-2.5 text-left text-[13.5px] text-muted-foreground hover:bg-muted hover:text-foreground"
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
                  'flex h-9 min-w-0 flex-1 items-center gap-2 rounded-l-md px-2.5 text-left text-[13.5px] hover:bg-muted',
                  selected?.path === dir.path && 'bg-muted font-medium',
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
                className={cn(
                  'flex shrink-0 items-center rounded-r-md px-2.5 text-muted-foreground hover:bg-muted hover:text-foreground',
                  selected?.path === dir.path && 'bg-muted',
                )}
              >
                <ChevronRightIcon className="size-3.5" aria-hidden="true" />
              </button>
            </li>
          ))}
          {listing.data && listing.data.dirs.length === 0 ? (
            <li className="px-2.5 py-2 text-[13px] text-muted-foreground">{emptyHint}</li>
          ) : null}
        </ul>
      )}

      {listing.data?.truncated ? (
        <p data-slot="fs-truncated" className="text-xs text-muted-foreground">
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
