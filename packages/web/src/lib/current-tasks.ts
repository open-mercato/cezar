import type { RunRecord } from '@open-mercato/cezar-api-client'

import { ATTENTION_RANK, deriveAttention, type AttentionBucket } from './attention'
import { compareIsoDesc, lastActivityAt } from './task-groups'

/** The sidebar's "Current tasks" cap (redesign, Proposal 1). */
export const CURRENT_TASKS_LIMIT = 6

/** Needs-you first, then running, then everything else — the Now view's own order. */
const TIER: Record<AttentionBucket, number> = {
  permission: 0,
  error: 0,
  waiting: 0,
  running: 1,
  unseen: 2,
  none: 2,
}

/**
 * The rows the sidebar lists for the active project: tasks that need you, then running ones,
 * then the most recent finished ones, capped. Within a tier the attention ladder
 * (`ATTENTION_RANK`) and then recency decide, with a pinned task ahead of its unpinned peers —
 * a pin is the one explicit "keep this in view" the user can give. Archived runs never show.
 */
export function currentTasks(runs: readonly RunRecord[], limit = CURRENT_TASKS_LIMIT): RunRecord[] {
  return runs
    .filter((run) => !run.archived)
    .map((run) => ({ run, rank: ATTENTION_RANK[deriveAttention(run).bucket] }))
    .sort((a, b) => {
      const tier = TIER[deriveAttention(a.run).bucket] - TIER[deriveAttention(b.run).bucket]
      if (tier !== 0) return tier
      const pinned = Number(Boolean(b.run.pinned)) - Number(Boolean(a.run.pinned))
      if (pinned !== 0) return pinned
      if (a.rank !== b.rank) return a.rank - b.rank
      return compareIsoDesc(lastActivityAt(a.run), lastActivityAt(b.run))
    })
    .slice(0, limit)
    .map(({ run }) => run)
}
