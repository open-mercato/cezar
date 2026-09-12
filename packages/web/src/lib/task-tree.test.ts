import { describe, expect, it } from 'vitest'

import {
  buildTaskTree,
  dispatchKindLabel,
  flattenTaskTree,
  subtaskLabel,
  taskTreeRows,
  type TaskTreeInput,
} from './task-tree'

/**
 * The nesting rule every task list shares (spec `.ai/specs/2026-09-10-dispatch.md`): a dispatched
 * child renders under the task that ordered it, in that task's own place in the list, and never
 * as a second top-level row.
 *
 * Tabled rather than DOM-tested because that is the whole point of the module — three surfaces
 * paint this, and only one of them has to be rendered to prove the rule.
 */

/** A run, spelled as tersely as the cases below need it. `parent` omitted = a root. */
function run(id: string, parent?: string): TaskTreeInput {
  return parent === undefined ? { id } : { id, dispatch: { parentRunId: parent } }
}

/** The flattened tree as `id@depth`, which is exactly what a row renderer consumes. */
const shape = (runs: readonly TaskTreeInput[]): string[] =>
  taskTreeRows(runs).map((node) => `${node.run.id}@${node.depth}`)

describe('buildTaskTree', () => {
  it('leaves a list with no dispatch alone — every row is a root, in the caller order', () => {
    const runs = [run('a'), run('b'), run('c')]
    expect(buildTaskTree(runs).map((node) => node.run.id)).toEqual(['a', 'b', 'c'])
    expect(shape(runs)).toEqual(['a@0', 'b@0', 'c@0'])
  })

  it('nests a child under its parent instead of leaving it a top-level row', () => {
    const roots = buildTaskTree([run('parent'), run('child', 'parent')])
    expect(roots.map((node) => node.run.id)).toEqual(['parent'])
    expect(roots[0]?.children.map((node) => node.run.id)).toEqual(['child'])
    expect(roots[0]?.children[0]?.depth).toBe(1)
  })

  // The ordering promise: the parent keeps the slot the CALLER's sort gave it, and its children
  // arrive there with it rather than wherever their own timestamps would have put them.
  it('a child renders in its parent’s position, not its own', () => {
    const runs = [run('newest'), run('parent'), run('child', 'parent'), run('oldest')]
    expect(shape(runs)).toEqual(['newest@0', 'parent@0', 'child@1', 'oldest@0'])
  })

  it('keeps sibling children in the order they were given', () => {
    expect(shape([run('p'), run('c1', 'p'), run('c2', 'p'), run('c3', 'p')])).toEqual([
      'p@0',
      'c1@1',
      'c2@1',
      'c3@1',
    ])
  })

  it('nests to any depth, subtree by subtree', () => {
    const runs = [run('root'), run('mid', 'root'), run('leaf', 'mid'), run('other', 'root')]
    expect(shape(runs)).toEqual(['root@0', 'mid@1', 'leaf@2', 'other@1'])
  })

  it('places a child that appears BEFORE its parent in the input under it all the same', () => {
    expect(shape([run('child', 'parent'), run('parent')])).toEqual(['parent@0', 'child@1'])
  })

  // The rule that keeps a filtered list honest: hiding a child whose parent a search or the
  // Archived tab removed would make rows disappear with nothing to explain it.
  it('a child whose parent is not in the list stands as a top-level row', () => {
    expect(shape([run('orphan', 'elsewhere'), run('b')])).toEqual(['orphan@0', 'b@0'])
  })

  it('a run that names itself as its parent is a root, not a loop', () => {
    expect(shape([run('self', 'self')])).toEqual(['self@0'])
  })

  it('a cycle cannot hang the list — its members all root, and every row still paints', () => {
    // a → b → a. Neither can hang under the other without orphaning it, so both stand as roots
    // and the list stays complete. The alternative — recursing the ring — hangs the cockpit.
    expect(shape([run('a', 'b'), run('b', 'a')])).toEqual(['a@0', 'b@0'])
    expect(shape([run('x', 'y'), run('y', 'z'), run('z', 'x')])).toHaveLength(3)
  })

  it('paints a duplicated id once', () => {
    expect(shape([run('a'), run('a'), run('b', 'a')])).toEqual(['a@0', 'b@1'])
  })

  it('counts direct children and every descendant separately', () => {
    const [root] = buildTaskTree([
      run('root'),
      run('mid', 'root'),
      run('leaf', 'mid'),
      run('other', 'root'),
    ])
    expect(root?.childCount).toBe(2)
    expect(root?.descendantCount).toBe(3)
    expect(root?.children[0]?.childCount).toBe(1)
    expect(root?.children[1]?.descendantCount).toBe(0)
  })

  it('never invents or drops a row — the flattened tree is a permutation of the input', () => {
    const runs = [
      run('a'),
      run('b', 'a'),
      run('c', 'missing'),
      run('d'),
      run('e', 'b'),
      run('f', 'd'),
    ]
    const rows = taskTreeRows(runs)
    expect(rows).toHaveLength(runs.length)
    expect(rows.map((node) => node.run.id).sort()).toEqual(runs.map((r) => r.id).sort())
  })

  it('a child always follows its parent in the flattened order', () => {
    const runs = [run('a'), run('b', 'a'), run('c'), run('d', 'c'), run('e', 'b')]
    const ids = taskTreeRows(runs).map((node) => node.run.id)
    for (const r of runs) {
      const parentId = r.dispatch?.parentRunId
      if (parentId === undefined) continue
      expect(ids.indexOf(parentId)).toBeLessThan(ids.indexOf(r.id))
    }
  })

  it('is pure — the input array and its members are untouched', () => {
    const runs = [run('a'), run('b', 'a')]
    const snapshot = JSON.stringify(runs)
    buildTaskTree(runs)
    expect(JSON.stringify(runs)).toBe(snapshot)
  })
})

describe('flattenTaskTree', () => {
  it('emits each node immediately before its own subtree', () => {
    const roots = buildTaskTree([run('p'), run('c', 'p'), run('g', 'c'), run('q')])
    expect(flattenTaskTree(roots).map((node) => node.run.id)).toEqual(['p', 'c', 'g', 'q'])
  })

  it('an empty tree flattens to nothing', () => {
    expect(flattenTaskTree(buildTaskTree([]))).toEqual([])
  })
})

describe('subtaskLabel', () => {
  it('is null for a task that dispatched nothing — no "0 subtasks" anywhere', () => {
    expect(subtaskLabel(0)).toBeNull()
    expect(subtaskLabel(-1)).toBeNull()
  })

  it('agrees with itself about the plural', () => {
    expect(subtaskLabel(1)).toBe('1 subtask')
    expect(subtaskLabel(3)).toBe('3 subtasks')
  })
})

describe('dispatchKindLabel', () => {
  it('is null for a task a person created — a root says nothing, even one that dispatched', () => {
    expect(dispatchKindLabel(run('plain'))).toBeNull()
    expect(dispatchKindLabel({ id: 'root', dispatch: { kind: 'review' } })).toBeNull()
  })

  it('names a child by its kind', () => {
    expect(dispatchKindLabel({ id: 'c', dispatch: { parentRunId: 'p', kind: 'review' } })).toBe('review')
    expect(dispatchKindLabel({ id: 'c', dispatch: { parentRunId: 'p', kind: 'implement' } })).toBe(
      'implement',
    )
  })

  // The contract's default, made visible: a child with no `kind` is an implement task, and the
  // list says so rather than leaving one kind labelled and the other bare.
  it('reads an absent kind as implement', () => {
    expect(dispatchKindLabel(run('c', 'p'))).toBe('implement')
  })
})
