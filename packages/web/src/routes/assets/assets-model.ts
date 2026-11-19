import type { ProjectAsset, RunStatus } from '@open-mercato/cezar-api-client'

/** The project Assets page's pure half (spec 2026-10-22-html-artifacts-and-impact, Phase 3). */

export type AssetFilter = 'all' | 'impact' | 'html' | 'markdown' | 'image'

export const ASSET_FILTERS: readonly { id: AssetFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'impact', label: 'Impact' },
  { id: 'html', label: 'HTML' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'image', label: 'Images' },
]

/** Impact = a run that assessed a subject; the rest filter by kind. */
export function filterAssets(rows: readonly ProjectAsset[], filter: AssetFilter): ProjectAsset[] {
  if (filter === 'all') return [...rows]
  if (filter === 'impact') return rows.filter((row) => row.subject !== undefined)
  return rows.filter((row) => row.kind === filter)
}

export type AssetState = 'running' | 'stale' | 'current' | 'none'

/** A live run is still writing; otherwise the subject's staleness, `none` when it cannot be told. */
export function assetState(row: Pick<ProjectAsset, 'stale'>, status: RunStatus): AssetState {
  if (status === 'running' || status === 'queued') return 'running'
  if (row.stale === true) return 'stale'
  if (row.stale === false) return 'current'
  return 'none'
}

export function taskAssetPath(row: Pick<ProjectAsset, 'runId' | 'name'>): string {
  return `/tasks/${encodeURIComponent(row.runId)}/assets/${encodeURIComponent(row.name)}`
}

/** Where a subject lives in the cockpit: the PR in the GitHub tab, the spec in Git → Files. */
export function subjectLink(subject: NonNullable<ProjectAsset['subject']>): { to: string; label: string; title: string } {
  if (subject.kind === 'pr') return { to: `/github/prs/${subject.number}`, label: `PR #${subject.number}`, title: `Pull request #${subject.number}` }
  return {
    to: `/git/files/${subject.path.split('/').map(encodeURIComponent).join('/')}`,
    label: `spec ${subject.path.split('/').pop() ?? subject.path}`,
    title: subject.path,
  }
}
