import type { ProcessUsage, RunRecord, RunStatus } from '@open-mercato/cezar-api-client'
import { groupTitle, runTitle, type ListView } from '@/lib/task-groups'

/**
 * The pure half of the Tasks table (the `/` overview): search, the header's archive count, the
 * usage-cell decisions and the compare-variants strip. The component only paints what these say.
 *
 * The usage semantics are ported from the legacy table (`web/app.js` → `renderRunsTable` /
 * `runRowHtml`), which is R1's parity bar: a live sample is only believed while the run's own
 * process tree can exist, and a finished run falls back to its persisted peaks, dimmed.
 */

/** Statuses whose usage sample is current — a session is registered while running AND while
 *  parked at `waiting` (the CLI process stays alive). Legacy `USAGE_LIVE_STATUSES`. */
const USAGE_LIVE_STATUSES: ReadonlySet<RunStatus> = new Set(['running', 'waiting'])

/** Nothing left to observe: these runs can never report a live sample again. Legacy
 *  `TERMINAL_STATUSES` — `review` is terminal because the agent is done and a human is not. */
export const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(['done', 'failed', 'review', 'cancelled'])

/** What "Archive finished" archives (`POST /api/runs/archive-finished` server-side): outcomes,
 *  not gates — a `review` run still wants a human and must not be swept away. */
const FINISHED_STATUSES: ReadonlySet<RunStatus> = new Set(['done', 'failed', 'cancelled'])

/**
 * Humanized RSS — `612 MB`, `1.2 GB`. Ported from the legacy `fmtBytes` (ps gives KB, the store
 * keeps bytes) so both cockpits print the same number for the same sample. '' for nothing —
 * the cell renders its own em dash, `0 kB` would claim a measurement that never happened.
 */
export function formatMem(bytes: number | undefined): string {
  if (!bytes) return ''
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`
  return `${Math.round(bytes / 1024)} kB`
}

/** `$0.31` / `$12` — two decimals until the cents stop mattering. Legacy `fmtCost`; '' when the
 *  run has no recorded spend, because `$0.00` reads as "measured: free" and it was not measured. */
export function formatCost(usd: number | undefined): string {
  if (!usd) return ''
  return `$${usd >= 10 ? usd.toFixed(0) : usd.toFixed(2)}`
}

/** The Workflow column's text. `(planned)` chains and inbox runs carry their meaning in their
 *  first agent step, so that name reads better than the placeholder. Legacy `workflowLabel`. */
export function workflowLabel(run: RunRecord): string {
  if (run.workflow === '(planned)' || run.workflow === '(inbox)') {
    const agent = run.steps.find((step) => step.kind === 'agent')
    if (agent?.name) return agent.name
  }
  return run.workflow
}

/**
 * The header search: case-insensitive substring over what the table actually shows — the
 * displayed title (`runTitle`: the auto-summary when one exists, per R2 #389), branch and
 * workflow (both the raw name and the label the column prints). Not the task prompt, and not a
 * raw `title` hidden behind a summary: matching on text the table never displays makes rows
 * appear for no visible reason.
 */
export function filterRuns(runs: readonly RunRecord[], query: string): RunRecord[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...runs]
  return runs.filter((run) =>
    [runTitle(run), run.branch ?? '', run.workflow, workflowLabel(run)].some((text) =>
      text.toLowerCase().includes(needle),
    ),
  )
}

/** How many active runs "Archive finished" would sweep. The button only exists when this is
 *  nonzero — a broom over an empty floor is noise (legacy showed the same count-gated button). */
export function finishedRunCount(runs: readonly RunRecord[]): number {
  return runs.filter((run) => !run.archived && FINISHED_STATUSES.has(run.status)).length
}

/** A git remote as a GitHub web root (`https://github.com/owner/repo`) — the caller passes the
 *  remote `/api/v1/health` reports (`repo.remote`), via `useProjectRepoBase`. Handles the scheme forms
 *  (`https://`, `ssh://`, credentials, port) and the scp-like `git@github.com:owner/repo.git`;
 *  undefined for every non-github.com host, local path, or absent remote — the cockpit only knows
 *  how to spell GitHub issue URLs. Mirrors the server's `parseRemote` (`src/server/forge/index.ts`),
 *  duplicated rather than imported because that module is server-only. */
export function githubRepoBase(remote: string | undefined): string | undefined {
  if (!remote) return undefined
  const trimmed = remote.trim().replace(/\/+$/, '')
  const url = /^(?:https?|ssh|git|git\+ssh):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/.exec(trimmed)
  // scp-like: [user@]host:owner/repo(.git) — a leading '/' (local path) can't match the host group.
  const scp = url ? null : /^(?:[^@/:]+@)?([^:/]+):(.+)$/.exec(trimmed)
  const match = url ?? scp
  if (!match) return undefined
  const [, host, path] = match
  if (!path || host?.toLowerCase() !== 'github.com') return undefined
  const parts = path.replace(/\.git$/i, '').split('/').filter(Boolean)
  const owner = parts[parts.length - 2]
  const repo = parts[parts.length - 1]
  return owner && repo ? `https://github.com/${owner}/${repo}` : undefined
}

/** The URL a PR *display* chip shows: the PR the task created, else the PR the conversation
 *  is about (#407 — review/continue tasks reference an existing PR instead of opening one).
 *  Action gates (Draft PR, Create PR→View PR) must keep reading `pullRequestUrl` directly:
 *  a task that reviewed PR X must still be able to open its own PR from its branch. */
export function taskPrUrl(run: RunRecord): string | undefined {
  if (run.pullRequestUrl) return run.pullRequestUrl
  // #526: a run whose declared subject is an ISSUE (CEZ:ISSUE) and that declared no PR must
  // not adopt an incidental transcript PR as "its" PR — an `om-prepare-issue` run linking a
  // stray PR that merely appeared in its output is a false, misleading association.
  if (run.markerRefs?.issue !== undefined && run.markerRefs?.pr === undefined) return undefined
  return run.referencedPullRequestUrl
}

/** Display-only issue association. Action gates must continue to use their created-resource
 * fields directly; this accessor exists only for links painted by the cockpit.
 *
 * `repoBase` is the repository of the project on screen (`useProjectRepoBase()`) and is the only
 * authority a *synthesized* link may be built on. Callers without it get today's behavior:
 * a discovered URL or nothing. */
export function taskIssueUrl(run: RunRecord, repoBase?: string): string | undefined {
  if (run.referencedIssueUrl) return run.referencedIssueUrl
  // #526: an issue-subject run (om-prepare-issue) knows its issue number from the CEZ:ISSUE
  // marker even when no full `…/issues/N` link was ever scanned into referencedIssueUrl.
  // Synthesize the link from the PROJECT's repo only — never from `referenced*Candidates` or
  // `referenced*Url`, which are transcript scrapings that routinely name other repositories:
  // `CEZ:ISSUE=524` beside an incidental `github.com/other/repo/pull/1` would rebuild the exact
  // wrong-link defect #526 exists to kill, just pointing at an issue instead of a PR.
  const number = run.markerRefs?.issue ?? run.issueNumber
  if (!number || !repoBase) return undefined
  return `${repoBase}/issues/${number}`
}

export interface TaskReference {
  kind: 'PR' | 'Issue'
  number: number
  url?: string
}

/** The strongest known tracker reference for a task. PRs win once one exists;
 * issue-driven queued runs still expose their already-known issue immediately. */
export function taskReference(run: RunRecord): TaskReference | undefined {
  const pullRequestUrl = taskPrUrl(run)
  const pullRequestNumber = pullRequestUrl ? Number(prNumber(pullRequestUrl)) : run.prNumber
  if (pullRequestNumber && Number.isInteger(pullRequestNumber)) {
    return { kind: 'PR', number: pullRequestNumber, ...(pullRequestUrl ? { url: pullRequestUrl } : {}) }
  }
  const issueUrl = taskIssueUrl(run)
  const issueNumber = run.issueNumber ?? (issueUrl ? Number(prNumber(issueUrl)) : undefined)
  if (issueNumber && Number.isInteger(issueNumber)) {
    return { kind: 'Issue', number: issueNumber, ...(issueUrl ? { url: issueUrl } : {}) }
  }
  return undefined
}

/** The PR chip's `#402`. Null when the URL's last segment is not a number — a forge we don't
 *  recognize still gets a working chip, just without a number we'd be inventing. */
export function prNumber(url: string): string | null {
  const last = url.split('/').pop() ?? ''
  return /^\d+$/.test(last) ? last : null
}

/** One cell of the CPU/Mem pair. `text` is '' when there is nothing true to print. */
export interface UsageCell {
  text: string
  /** live: a current sample, emphasized. peak: a finished run's persisted high-water mark,
   *  dimmed. none: an honest em dash. */
  kind: 'live' | 'peak' | 'none'
  /** Tooltip for the peak cell — says the number is history, not a reading. */
  title?: string
}

/**
 * What the CPU and Mem columns say for one run.
 *
 * A sample is only believed while the run's process tree can exist (`USAGE_LIVE_STATUSES`) — the
 * usage stream is a snapshot broadcast, and a tick that raced the run's exit must not paint a
 * finished row as live. With no live sample, Mem falls back to the persisted `peakRssBytes`
 * (dimmed, labeled `peak`); CPU has no persisted peak, so its cell goes empty rather than
 * inventing one. Exactly the legacy table's fallbacks.
 */
export function usageCells(
  run: RunRecord,
  sample: ProcessUsage | undefined,
): { cpu: UsageCell; mem: UsageCell } {
  const live = USAGE_LIVE_STATUSES.has(run.status) ? sample : undefined
  if (live) {
    return {
      cpu: { text: `${live.cpuPct.toFixed(0)}%`, kind: 'live' },
      mem: { text: formatMem(live.rssBytes), kind: 'live' },
    }
  }
  const peakMem = formatMem(run.peakRssBytes)
  return {
    cpu: { text: '', kind: 'none' },
    mem: peakMem
      ? {
          text: `peak ${peakMem}`,
          kind: 'peak',
          title: `peak — run finished${run.peakProcCount ? ` · ${run.peakProcCount} procs` : ''}`,
        }
      : { text: '', kind: 'none' },
  }
}

/** One compare-variants strip below the table. */
export interface CompareGroup {
  groupId: string
  /** The shared task title, without the ` (A)` suffix. */
  title: string
  count: number
}

/**
 * The variant groups whose members are all terminal — the ones a Compare link can honestly
 * offer, because every diff it would show is final. Groups still in flight get no strip: a
 * comparison that changes under the reader is worse than none (the mockup's disabled strip is a
 * later refinement; R1 shows only what works).
 *
 * Scoped to the view like everything else on this screen: an archived group belongs to the
 * Archived tab. A `groupId` with one member left in view is a picked winner, not a comparison.
 */
export function compareGroups(runs: readonly RunRecord[], view: ListView): CompareGroup[] {
  const inView = runs.filter((run) => (view === 'archived' ? run.archived : !run.archived))
  const byGroup = new Map<string, RunRecord[]>()
  for (const run of inView) {
    if (!run.groupId) continue
    const members = byGroup.get(run.groupId)
    if (members) members.push(run)
    else byGroup.set(run.groupId, [run])
  }
  return [...byGroup.entries()].flatMap(([groupId, members]) => {
    const first = members[0]
    if (!first || members.length < 2) return []
    if (!members.every((member) => TERMINAL_STATUSES.has(member.status))) return []
    return [{ groupId, title: groupTitle(first), count: members.length }]
  })
}
