import type { RunRecord } from '@open-mercato/cezar-api-client'

import { ATTENTION_RANK, deriveAttention, type AttentionBucket } from './attention'
import { compareIsoDesc, lastActivityAt } from './task-groups'
import { buildTaskTree, type TaskTreeNode } from './task-tree'

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

function compareRuns(a: RunRecord, b: RunRecord): number {
  const tier = TIER[deriveAttention(a).bucket] - TIER[deriveAttention(b).bucket]
  if (tier !== 0) return tier
  const pinned = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))
  if (pinned !== 0) return pinned
  const rank = ATTENTION_RANK[deriveAttention(a).bucket] - ATTENTION_RANK[deriveAttention(b).bucket]
  if (rank !== 0) return rank
  return compareIsoDesc(lastActivityAt(a), lastActivityAt(b))
}

/** The most urgent run in a subtree — what ranks the whole group (#2383). */
function mostUrgent(node: TaskTreeNode<RunRecord>, memo: Map<string, RunRecord>): RunRecord {
  let best = node.run
  for (const child of node.children) {
    const candidate = mostUrgent(child, memo)
    if (compareRuns(candidate, best) < 0) best = candidate
  }
  memo.set(node.run.id, best)
  return best
}

/**
 * The sidebar's tree (#2383): grouping happens over EVERY non-archived run BEFORE the cap, so a
 * child never detaches from an available parent. Groups are ranked by their most urgent member
 * (a child that needs you lifts its parent), the budget counts top-level groups, and children
 * keep the same order beneath their parent. A child whose parent is absent or archived is a
 * root (`buildTaskTree`'s rule).
 */
export function currentTaskTree(runs: readonly RunRecord[], limit = CURRENT_TASKS_LIMIT): TaskTreeNode<RunRecord>[] {
  const roots = buildTaskTree(runs.filter((run) => !run.archived))
  const urgent = new Map<string, RunRecord>()
  for (const root of roots) mostUrgent(root, urgent)
  const byUrgency = (a: TaskTreeNode<RunRecord>, b: TaskTreeNode<RunRecord>) =>
    compareRuns(urgent.get(a.run.id)!, urgent.get(b.run.id)!)
  const sortLevel = (level: TaskTreeNode<RunRecord>[]) => {
    level.sort(byUrgency)
    for (const node of level) sortLevel(node.children)
  }
  sortLevel(roots)
  return roots.slice(0, limit)
}

/** Descendants that need a person (permission / error / waiting), at any depth. */
export function needsYouCount(node: TaskTreeNode<RunRecord>): number {
  let count = 0
  for (const child of node.children) {
    if (TIER[deriveAttention(child.run).bucket] === 0) count += 1
    count += needsYouCount(child)
  }
  return count
}

/** The top-level runs the sidebar lists, in order (subtasks ride under them; see `currentTaskTree`). */
export function currentTasks(runs: readonly RunRecord[], limit = CURRENT_TASKS_LIMIT): RunRecord[] {
  return currentTaskTree(runs, limit).map((node) => node.run)
}
