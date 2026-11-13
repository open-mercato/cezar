import type { RunRecord } from '../runs/store.ts';
import type { GraphNode } from './graph.ts';

/** The runner/model that owns a graph node's resumed session. Explicit node pins win. */
export function graphAgentAffinity(
  node: Extract<GraphNode, { type: 'agent' }>,
  record: RunRecord | undefined,
  resuming: boolean,
): { runner?: NonNullable<RunRecord['runner']>; model?: string } {
  const targetId = resuming ? node.id : node.session?.continue;
  const owner = targetId ? record?.steps.find((step) => step.id === targetId) : undefined;
  const sameRunner = !node.runner || !owner?.backend || node.runner === owner.backend;
  const model = node.model ?? (sameRunner ? owner?.model : undefined);
  return {
    ...(node.runner ?? owner?.backend ? { runner: node.runner ?? owner?.backend } : {}),
    ...(model ? { model } : {}),
  };
}
