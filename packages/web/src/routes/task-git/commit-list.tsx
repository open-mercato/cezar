import { useLayoutEffect, useRef, useState } from 'react'
import { Virtualizer } from 'virtua'

import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'

/**
 * The commit log list, shared by the task Commits tab and the repo Commits segment — one
 * `sha · subject · author·when` row per commit, deep-linking to that commit's structured diff.
 *
 * Same two-tier rule as the transcript and the diff (`components/diff/diff-scroll.ts` §"THE
 * PERFORMANCE RULE"): flat with `content-visibility: auto` up to
 * {@link COMMIT_VIRTUALIZE_THRESHOLD} rows, virtua past it. Rows are a fixed single line, which
 * makes this the easy case — `ROW_HEIGHT_PX` is exact rather than an estimate, so the flat
 * tier's placeholders and virtua's initial guesses are right the first time.
 *
 * WHICH CONSUMER ACTUALLY NEEDS THE VIRTUAL TIER — they are not symmetric, and it would be easy
 * to assume they are:
 *  - The TASK Commits tab is why this exists. `collectRunCommits` (src/server/git-changes.ts)
 *    runs `git log <merge-base>..HEAD` with NO cap, and cezar autosaves a commit per turn, so a
 *    long-running task genuinely reaches hundreds of rows.
 *  - The REPO Commits segment cannot reach the threshold today: `getLog` (src/server/git.ts)
 *    defaults to 20 and `server.ts` calls it without a count, so that list is 20 rows, full
 *    stop. It shares this component for one renderer rather than two, and for the flat tier's
 *    `content-visibility` — not because 20 rows need windowing. If that cap is ever lifted,
 *    this is already correct; until then, don't read the virtual branch as protecting it.
 */

/** Commit rows past which the list goes through virtua. */
export const COMMIT_VIRTUALIZE_THRESHOLD = 150

/** One row: `py-2.5` (20px) + a `text-[13px]`/`leading-normal` line ≈ 40px, plus the divider. */
const ROW_HEIGHT_PX = 41

export interface CommitListItem {
  sha: string
  subject: string
  author: string
  when: string
  /** Where the row links to — the two consumers have different route prefixes. */
  href: string
  /** The sha as displayed; the task list abbreviates, the repo log is already short. */
  shaLabel: string
}

export function CommitList({ slot, commits, className }: { slot: string; commits: CommitListItem[]; className?: string }) {
  const virtual = commits.length > COMMIT_VIRTUALIZE_THRESHOLD
  const containerRef = useRef<HTMLDivElement | null>(null)
  const scrollElRef = useRef<HTMLElement | null>(null)

  // Same measured `startMargin` as the thread and the diff: the distance from the shell
  // scroller's content start down to this list (headers, toolbars). See diff-view.tsx.
  const [startMargin, setStartMargin] = useState(0)
  useLayoutEffect(() => {
    if (!virtual) return
    const measure = () => {
      const container = containerRef.current
      const scroller = scrollElRef.current
      if (!container || !scroller) return
      setStartMargin(
        Math.max(
          0,
          Math.round(
            container.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop,
          ),
        ),
      )
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [virtual])

  const rows = commits.map((commit) => <CommitRow key={commit.sha} commit={commit} />)

  return (
    <div
      ref={(el) => {
        containerRef.current = el
        if (el) scrollElRef.current = el.closest<HTMLElement>('[data-slot="main"]')
      }}
      data-slot={slot}
      data-virtualized={virtual}
      className={cn('flex flex-col divide-y divide-border px-2 py-1 md:px-4', className)}
    >
      {virtual ? (
        // No `shift`: commit logs are newest-first and only ever grow at the start on a
        // refetch that REPLACES the list, so there is no prepend to anchor against.
        <Virtualizer scrollRef={scrollElRef} startMargin={startMargin} itemSize={ROW_HEIGHT_PX}>
          {rows}
        </Virtualizer>
      ) : (
        rows
      )}
    </div>
  )
}

function CommitRow({ commit }: { commit: CommitListItem }) {
  return (
    // Not a <ul>/<li>: virtua inserts its own positioned wrapper between the list and the
    // items, which would break that parent/child contract. A plain list of links reads the
    // same to a screen reader here — each row's accessible name is its own link text.
    <div className="[contain-intrinsic-block-size:auto_41px] [content-visibility:auto]">
      <Link
        data-slot="commit-row"
        data-sha={commit.sha}
        to={commit.href}
        className="flex min-w-0 items-baseline gap-3 rounded-sm px-2 py-2.5 hover:bg-muted"
      >
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{commit.shaLabel}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{commit.subject}</span>
        <span className="hidden shrink-0 text-[11px] text-soft-foreground sm:inline">
          {commit.author} · {commit.when}
        </span>
      </Link>
    </div>
  )
}
