import type { RunnerId } from '../core/agent-runner.ts';
import { taskAgentSelection } from '../runs/agent-selection.ts';
import type { RunRecord } from '../runs/store.ts';

/** One project's runs and how to read its default runner. */
export interface ActiveRunSource {
  root: string;
  listRuns: () => RunRecord[];
}

/**
 * Tasks running on `provider` right now, across the given projects (spec
 * 2026-11-25-agent-cli-install-and-update: an update waits for them). Which agent a run is on is
 * `taskAgentSelection`'s answer, so a run with no `runner` counts against its project's default
 * and a workflow step on its own backend counts against that backend.
 */
export async function countActiveRuns(
  sources: readonly ActiveRunSource[],
  provider: RunnerId,
  defaultRunner: (root: string) => Promise<RunnerId>,
): Promise<number> {
  let count = 0;
  for (const source of sources) {
    const running = source.listRuns().filter((run) => run.status === 'running');
    if (running.length === 0) continue;
    const fallback = await defaultRunner(source.root).catch((): RunnerId => 'claude');
    for (const run of running) if (taskAgentSelection(run, fallback).runner === provider) count += 1;
  }
  return count;
}
