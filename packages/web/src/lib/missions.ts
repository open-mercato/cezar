import type { ApiRun, RunUnit, UnitRole } from '@open-mercato/cezar-api-client'
import { deriveAttention, type Attention } from '@/lib/attention'

/**
 * The mission tree, as a PURE function over the run list (spec
 * `.ai/specs/2026-09-08-units-hierarchy.md` §Cockpit: "tree grouping is a pure function with
 * tests").
 *
 * There is no `/missions` READ route and deliberately so: a mission is not a second kind of
 * record, it is the shape a set of runs already has through `unit.missionId` / `unit.parentRunId`.
 * Deriving it here means the Missions page, the Guard inbox and the thread's parent/children
 * lines all read the ONE `useRuns()` cache — already live over the run stream — instead of three
 * polls that could disagree about which child settled first.
 *
 * UI-free on purpose, exactly like `lib/attention.ts` (which it calls): no React, no class names,
 * no tokens. Components decide what a `needsGuard` node looks like; this module only says which
 * nodes are one.
 */

/** The instant a row's "Updated" column reports — the same fallback ladder the global Tasks
 *  table uses (`finishedAt ?? startedAt ?? createdAt`), so ages never disagree between pages. */
export function missionUpdatedAt(run: Pick<ApiRun, 'createdAt' | 'startedAt' | 'finishedAt'>): string {
  return run.finishedAt ?? run.startedAt ?? run.createdAt
}

/** A run WITH a `unit` — the only kind of run this module reasons about. `unit` is optional on
 *  the record (that is what keeps the feature additive), so the tree narrows it once, here, and
 *  every consumer below reads `node.unit` without a guard. */
export type UnitRun = ApiRun & { unit: RunUnit }

/** True for a run that takes part in a hierarchy. The type predicate is the point: it is what
 *  lets `runs.filter(isUnitRun)` produce `UnitRun[]` rather than `ApiRun[]`. */
export function isUnitRun(run: ApiRun): run is UnitRun {
  return run.unit !== undefined
}

export interface MissionNode {
  run: UnitRun
  unit: RunUnit
  role: UnitRole
  /** 0 for the mission root, +1 per level — the row's 22px indent multiplier. */
  depth: number
  /** The canonical status derivation, so a mission row's dot and a task row's dot agree. */
  attention: Attention
  /** This node's own spend, 0 when the run has recorded none. */
  costUsd: number
  /** This node's own ceiling, absent when it has none of its own. */
  budgetUsd?: number
  /** `costUsd / budgetUsd`, absent without a budget. NOT clamped: the meter needs to know it is
   *  over (> 1) to paint danger, and clamping here would hide exactly that. */
  budgetRatio?: number
  /** Direct children only — what the Agents column counts. */
  childCount: number
  /**
   * This run is parked waiting for a human (spec Q4: "Guard inbox = unit runs at `waiting` with
   * a pending ask").
   *
   * `status === 'waiting'` alone for the MVP, because the record carries no pending-ask flag —
   * `lib/attention.ts` says the same thing about its reserved `permission` bucket, and inventing
   * the distinction here would put a filter in the UI that no data backs. A unit run only parks
   * at `waiting` when it asked something, so the two coincide today; when a flag lands, this is
   * the only line that changes.
   */
  needsGuard: boolean
  children: MissionNode[]
}

export interface MissionTree {
  root: MissionNode
  /** The mission's id — the root run's own id (`unit.missionId` on every node below it). */
  missionId: string
  /** Roll-up: any node in this tree, at any depth, is waiting for the Guard. */
  needsGuard: boolean
  /** Every node's `costUsd`, the root's included. */
  totalCostUsd: number
  /** Every node's own `budgetUsd`, summed; absent when no node in the tree declares one. A SUM
   *  rather than the root's ceiling: a child's budget is carved out of its parent's, so the
   *  root's number alone would under-report a tree whose children were given ceilings directly. */
  totalBudgetUsd?: number
  /** Every node in the tree, the root included. */
  nodeCount: number
  /** `missionUpdatedAt` of the freshest node — what the tree list sorts on. */
  updatedAt: string
}

function nodeOf(run: UnitRun, depth: number, children: MissionNode[]): MissionNode {
  const costUsd = run.costUsd ?? 0
  const budgetUsd = run.unit.budgetUsd
  return {
    run,
    unit: run.unit,
    role: run.unit.role,
    depth,
    attention: deriveAttention(run),
    costUsd,
    // A ZERO ceiling is not "no ceiling" — it is a node forbidden to spend, so it sits exactly at
    // its limit until it spends anything and is over the moment it does. Dividing by it would
    // give NaN (0/0) or Infinity, neither of which a meter can render, so it is answered here.
    ...(budgetUsd === undefined
      ? {}
      : {
          budgetUsd,
          budgetRatio: budgetUsd > 0 ? costUsd / budgetUsd : costUsd > 0 ? Number.POSITIVE_INFINITY : 1,
        }),
    childCount: children.length,
    needsGuard: run.status === 'waiting',
    children,
  }
}

/** Newest first, on the same instant the Updated column prints.
 *
 *  Ties break on the id so the order is TOTAL: two runs created in the same millisecond — or two
 *  whose stamps are unparseable, which `stamp` floors to 0 rather than letting NaN poison the
 *  comparator — must not swap places between renders of the same data. */
function stamp(run: UnitRun): number {
  const at = Date.parse(missionUpdatedAt(run))
  return Number.isNaN(at) ? 0 : at
}

function byNewest(a: UnitRun, b: UnitRun): number {
  const delta = stamp(b) - stamp(a)
  return delta !== 0 ? delta : a.id.localeCompare(b.id)
}

/**
 * `ApiRun[]` → the mission forest.
 *
 * Roots are the runs with a `unit` and no `parentRunId`. Everything else nests under the run its
 * `parentRunId` names.
 *
 * **Orphans** — a child whose named parent is not in the list (archived, deleted, or simply
 * filtered out before we got here) — are not dropped: they attach under their own
 * `unit.missionId` root when that root IS present, and otherwise stand as roots of their own.
 * Losing a running child because its parent was archived would hide live spend, and hiding a
 * waiting child would hide something asking for a human.
 *
 * **Cycles** should not happen — a parent id is written at spawn, before the child exists — but a
 * hand-edited or corrupt `runs.json` can still name one, and a cycle names NO root: every member
 * is somebody's child, so the first pass files each one under another and the whole mission
 * would disappear from the page. Any node whose ancestor chain revisits a node it has already
 * walked is therefore promoted to a root, and the build below emits each node once — so a
 * 2-cycle surfaces as one tree broken at whichever member sorts first, never as nothing.
 */
export function buildMissionTrees(runs: readonly ApiRun[]): MissionTree[] {
  const unitRuns = runs.filter(isUnitRun)
  const byId = new Map(unitRuns.map((run) => [run.id, run]))

  const childrenOf = new Map<string, UnitRun[]>()
  /** child id → the node it was filed under, which is what the cycle walk below climbs. */
  const attachedTo = new Map<string, string>()
  const roots: UnitRun[] = []
  for (const run of unitRuns) {
    const parentId = run.unit.parentRunId
    // A root: no parent named, or the parent is this run itself (a record that named its own id
    // would otherwise vanish into a self-edge).
    if (parentId === undefined || parentId === run.id) {
      roots.push(run)
      continue
    }
    // An orphan re-parented onto its mission root, when that root is here and is not this run.
    const attachTo = byId.has(parentId)
      ? parentId
      : byId.has(run.unit.missionId) && run.unit.missionId !== run.id
        ? run.unit.missionId
        : undefined
    if (attachTo === undefined) {
      roots.push(run)
      continue
    }
    attachedTo.set(run.id, attachTo)
    const siblings = childrenOf.get(attachTo)
    if (siblings) siblings.push(run)
    else childrenOf.set(attachTo, [run])
  }

  // Promote every member of a cycle. Promoting all of them rather than picking one keeps this a
  // local decision (no tie-break to get wrong): the emitted guard in the build loop collapses
  // them into a single tree, and the edges are left in place so the cycle still renders as the
  // nesting the records describe rather than as a row of flat orphans.
  for (const [childId] of attachedTo) {
    const seen = new Set<string>([childId])
    let cursor = attachedTo.get(childId)
    while (cursor !== undefined && !seen.has(cursor)) {
      seen.add(cursor)
      cursor = attachedTo.get(cursor)
    }
    if (cursor === undefined) continue // the chain reached a root — the ordinary case
    const run = byId.get(childId)
    if (run) roots.push(run)
  }

  const emitted = new Set<string>()
  const build = (run: UnitRun, depth: number): MissionNode => {
    emitted.add(run.id)
    const children = [...(childrenOf.get(run.id) ?? [])]
      .filter((child) => !emitted.has(child.id))
      .sort(byNewest)
      .map((child) => build(child, depth + 1))
    return nodeOf(run, depth, children)
  }

  const trees: MissionTree[] = []
  // Sequential, not `.filter().map()`: `filter` runs to completion before the first `build`, so
  // it reads an `emitted` set that is still empty and cannot skip a promoted cycle member that
  // an earlier tree has since absorbed.
  for (const run of [...roots].sort(byNewest)) {
    if (emitted.has(run.id)) continue
    const root = build(run, 0)
    const nodes = flattenMission(root)
    const budgets = nodes.filter((node) => node.budgetUsd !== undefined)
    trees.push({
      root,
      missionId: root.run.id,
      needsGuard: nodes.some((node) => node.needsGuard),
      totalCostUsd: nodes.reduce((sum, node) => sum + node.costUsd, 0),
      ...(budgets.length === 0
        ? {}
        : { totalBudgetUsd: budgets.reduce((sum, node) => sum + (node.budgetUsd ?? 0), 0) }),
      nodeCount: nodes.length,
      updatedAt: nodes
        .map((node) => missionUpdatedAt(node.run))
        .reduce((newest, at) => (Date.parse(at) > Date.parse(newest) ? at : newest)),
    })
  }
  return trees
}

/** One mission's nodes in DISPLAY order (parent, then its subtree) — what the table renders row
 *  by row, and what the roll-ups fold over. */
export function flattenMission(node: MissionNode): MissionNode[] {
  return [node, ...node.children.flatMap(flattenMission)]
}

/** Every node of every mission, in display order. */
export function flattenMissions(trees: readonly MissionTree[]): MissionNode[] {
  return trees.flatMap((tree) => flattenMission(tree.root))
}

/** The Guard inbox's rows: every node waiting for a human, newest first, each carrying the
 *  mission it belongs to so the row can name it. */
export function guardQueue(
  trees: readonly MissionTree[],
): Array<{ node: MissionNode; mission: MissionTree }> {
  return trees
    .flatMap((mission) => flattenMission(mission.root).map((node) => ({ node, mission })))
    .filter(({ node }) => node.needsGuard)
    .sort(
      (a, b) =>
        Date.parse(missionUpdatedAt(b.node.run)) - Date.parse(missionUpdatedAt(a.node.run)),
    )
}

/** How many nodes across every mission are waiting for the Guard — the violet banner's count. */
export function guardCount(trees: readonly MissionTree[]): number {
  return guardQueue(trees).length
}

/** The meter's tone: green until 70 % of the budget, amber from there, danger once over
 *  (spec §Cockpit, "amber ≥70 %, danger over"). `undefined` ratio has no meter at all. */
export function budgetTone(ratio: number | undefined): 'success' | 'pending' | 'danger' {
  if (ratio === undefined) return 'success'
  if (ratio > 1) return 'danger'
  return ratio >= 0.7 ? 'pending' : 'success'
}
