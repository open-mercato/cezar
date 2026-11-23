import type { ApiRun } from '@open-mercato/cezar-api-client'

/**
 * Whether a run's Graph view is worth showing (#2246): a node graph, or a chain of more than one
 * step. `quick-task` and skill runs persist a one-step definition whose graph is a trivial
 * start → step → end. Needs the full run: list rows drop `workflowDef`.
 * Kept out of `workflow-graph.ts` so the tab strip does not pull dagre into the main chunk.
 */
export function hasWorkflowGraph(run: Pick<ApiRun, 'workflowDef'>): boolean {
  const def = run.workflowDef
  return Boolean(def?.graph) || (def?.steps.length ?? 0) > 1
}
