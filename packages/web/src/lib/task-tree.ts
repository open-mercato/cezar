/**
 * Task dispatch, as a tree (spec `.ai/specs/2026-09-10-dispatch.md`).
 *
 * A task may dispatch child tasks, and the child's record says so — `dispatch.parentRunId`. Every
 * task list in the cockpit paints those children NESTED under the parent that ordered them rather
 * than as separate top-level rows, or a parent that dispatched four reviews would bury itself
 * under its own work.
 *
 * Pure on purpose, and the ONLY place the nesting rule lives: three surfaces render it (the
 * project table and its card view, the cross-project list, the sidebar quick-list) and a rule
 * spelled three times is three rules. Nothing here touches React, the router or the clock, so the
 * behavior worth testing is testable as a table.
 *
 * ORDER IS THE CALLER'S. This takes an ALREADY-ORDERED list and preserves it: roots keep their
 * relative order (so each surface's own sort — `sortRuns`, `groupRuns`, the global page's
 * grouping — still decides the list), and a parent's children keep theirs, directly beneath it.
 * Re-sorting here would silently override the sort the caller chose.
 */

/**
 * What this module needs of a run: its id, and who dispatched it.
 *
 * Structural rather than `RunRecord`, for the same reason `RunTitleInput` is: the cross-project
 * page's rows are `RunIndexEntry`, a slim row, and the sidebar's are records. A row type that
 * carries no `dispatch` at all is a valid input — every one of its rows is simply a root, which
 * is exactly right for a wire that does not carry the parentage.
 */
export interface TaskTreeInput {
  id: string
  dispatch?: { parentRunId?: string | undefined } | undefined
}

/** One run in the tree, with everything a row needs to paint itself in place. */
export interface TaskTreeNode<T extends TaskTreeInput> {
  run: T
  /** 0 for a root; +1 per level. Rows render this as an indent and a `data-depth` attribute. */
  depth: number
  children: TaskTreeNode<T>[]
  /** Direct children only — what a parent row's "N subtasks" count means. */
  childCount: number
  /** Every descendant, at any depth. */
  descendantCount: number
}

/**
 * Nest `runs` by `dispatch.parentRunId`.
 *
 * Two rules decide what is a root, and both are about staying honest with the list the caller
 * actually has:
 *
 *  - A run whose parent is NOT in this list stands as a top-level row. That covers the parent
 *    filtered out by a search or an Active/Archived tab, the parent in another project, and the
 *    parent that was deleted. The alternative — hiding the child with its absent parent — makes
 *    rows vanish from a list that has no way to explain why.
 *  - A run that is its own ancestor stands as a top-level row too. A cycle cannot be drawn, and
 *    a store hand-edited into one must not hang the cockpit; `seen` below is that brake.
 */
export function buildTaskTree<T extends TaskTreeInput>(runs: readonly T[]): TaskTreeNode<T>[] {
  const nodes = new Map<string, TaskTreeNode<T>>()
  for (const run of runs) {
    // First entry wins on a duplicate id, so a list that somehow carries one paints it once.
    if (!nodes.has(run.id)) {
      nodes.set(run.id, { run, depth: 0, children: [], childCount: 0, descendantCount: 0 })
    }
  }

  /** The nearest ancestor present in this list, or null when this run is a root here. */
  const parentOf = (run: T): TaskTreeNode<T> | null => {
    const parentId = run.dispatch?.parentRunId
    if (parentId === undefined || parentId === run.id) return null
    const parent = nodes.get(parentId)
    if (parent === undefined) return null
    // Walk up from the parent looking for `run` itself: finding it means attaching here would
    // close a cycle, so this run roots instead.
    const seen = new Set<string>([run.id])
    let cursor: TaskTreeNode<T> | undefined = parent
    while (cursor !== undefined) {
      if (seen.has(cursor.run.id)) return null
      seen.add(cursor.run.id)
      const nextId: string | undefined = cursor.run.dispatch?.parentRunId
      cursor = nextId === undefined ? undefined : nodes.get(nextId)
    }
    return parent
  }

  const roots: TaskTreeNode<T>[] = []
  for (const run of runs) {
    const node = nodes.get(run.id)
    // Only the entry this run created — a duplicate id has already been placed.
    if (node === undefined || node.run !== run) continue
    const parent = parentOf(run)
    if (parent === null) roots.push(node)
    else parent.children.push(node)
  }

  // Depths and counts in one pass down from each root, now that the shape is settled.
  const measure = (node: TaskTreeNode<T>, depth: number): number => {
    node.depth = depth
    node.childCount = node.children.length
    let descendants = 0
    for (const child of node.children) descendants += 1 + measure(child, depth + 1)
    node.descendantCount = descendants
    return descendants
  }
  for (const root of roots) measure(root, 0)

  return roots
}

/** The tree as a flat list in render order: every node immediately followed by its subtree. */
export function flattenTaskTree<T extends TaskTreeInput>(
  nodes: readonly TaskTreeNode<T>[],
): TaskTreeNode<T>[] {
  const flat: TaskTreeNode<T>[] = []
  const walk = (level: readonly TaskTreeNode<T>[]) => {
    for (const node of level) {
      flat.push(node)
      walk(node.children)
    }
  }
  walk(nodes)
  return flat
}

/**
 * `buildTaskTree` + `flattenTaskTree` — what a row-per-run renderer actually wants: the same runs
 * the caller passed, reordered so each child follows its parent, each carrying its `depth` and
 * its subtask count.
 */
export function taskTreeRows<T extends TaskTreeInput>(runs: readonly T[]): TaskTreeNode<T>[] {
  return flattenTaskTree(buildTaskTree(runs))
}

/** "3 subtasks" — the count a parent row prints, or null when the run dispatched nothing. */
export function subtaskLabel(childCount: number): string | null {
  if (childCount <= 0) return null
  return `${childCount} subtask${childCount === 1 ? '' : 's'}`
}
