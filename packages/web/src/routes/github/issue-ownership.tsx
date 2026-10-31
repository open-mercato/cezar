import { GitPullRequestIcon, UserRoundIcon } from 'lucide-react'
import type { GithubItem } from '@open-mercato/cezar-api-client'
import { cn, isHttpUrl } from '@/lib/utils'

/** Sibling of the row link: PR links must remain independently keyboard reachable (#1620). */
export function IssueOwnership({ item }: { item: GithubItem }) {
  if (item.kind !== 'issue' || (item.assignees === undefined && item.linkedPrs === undefined)) return null
  const chip = 'inline-flex min-w-0 max-w-full items-center gap-1 rounded border border-border/70 px-1.5 py-0.5'
  return (
    <div aria-label={`Issue #${item.number} ownership`} role="group" className="flex min-w-0 flex-wrap items-center gap-1 px-2.5 pb-2 pl-8 text-[10.5px] text-muted-foreground">
      {item.assignees !== undefined ? (
        <span className={chip} title={item.assignees.length ? `Assigned to ${item.assignees.map(login => `@${login}`).join(', ')}` : undefined}>
          <UserRoundIcon aria-hidden="true" className="size-3 shrink-0" />
          <span className="truncate">
            {item.assignees.length ? `Assigned to ${item.assignees.map(login => `@${login}`).join(', ')}` : item.assigneesTruncated ? 'Assignees' : 'Unassigned'}
          </span>
        </span>
      ) : null}
      {item.assigneesTruncated && isHttpUrl(item.url) ? (
        <a className={cn(chip, 'hover:text-foreground focus-visible:outline focus-visible:outline-ring')} href={item.url} target="_blank" rel="noopener noreferrer" aria-label={`More assignees for issue #${item.number}`}>More assignees…</a>
      ) : null}
      {item.linkedPrs?.map(pr => {
        const state = pr.state === 'merged' ? 'Merged' : pr.state === 'closed' ? 'Closed' : pr.isDraft ? 'Draft' : 'Open'
        const content = <><GitPullRequestIcon aria-hidden="true" className="size-3 shrink-0" /><span className="truncate">PR #{pr.number} · {state}</span></>
        const className = cn(chip, pr.state === 'merged' ? 'text-violet' : pr.state === 'open' && !pr.isDraft ? 'text-success' : '')
        return isHttpUrl(pr.url) ? (
          <a key={pr.url} className={cn(className, 'hover:underline focus-visible:outline focus-visible:outline-ring')} href={pr.url} target="_blank" rel="noopener noreferrer" title={`${pr.title} — ${pr.url}`} aria-label={`PR #${pr.number} · ${state}: ${pr.title}`}>
            {content}
          </a>
        ) : <span key={pr.url} className={className}>{content}</span>
      })}
      {item.linkedPrsTruncated && isHttpUrl(item.url) ? (
        <a className={cn(chip, 'hover:text-foreground focus-visible:outline focus-visible:outline-ring')} href={item.url} target="_blank" rel="noopener noreferrer" aria-label={`More linked pull requests for issue #${item.number}`}>More linked PRs…</a>
      ) : null}
    </div>
  )
}
