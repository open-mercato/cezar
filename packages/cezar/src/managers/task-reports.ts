import type { RunRecord, RunStore } from '../runs/store.ts';
import type { ManagerEngine } from './engine.ts';
import { taskEventOf } from './snapshot.ts';

/**
 * Tells the manager engine when a run changes into something a follower hears about (spec
 * 2026-10-31-managers § Followed tasks). One listener per project run store; which manager follows
 * what, and idempotency, are the engine's.
 */

export interface TaskReportWatch {
  /** The project's id as `[[task:…]]` cards name it; async because the boot id resolves late. */
  projectId: () => string | Promise<string>;
  dataDir: string;
  store: RunStore;
  engine: Pick<ManagerEngine, 'taskChanged' | 'reconcileProject'>;
  /** `CEZ_MANAGERS=0` posts nothing. */
  enabled: () => boolean;
}

/** The event's identity without the project id: only a change of it is worth a look. */
const signature = (run: RunRecord): string | undefined => taskEventOf('', run)?.ledger;

/** Returns the unsubscribe. At attach it hands the engine the whole list, for what happened unheard. */
export function watchTaskReports(watch: TaskReportWatch): () => void {
  const seen = new Map(watch.store.listRuns().map((run) => [run.id, signature(run)] as const));
  const warn = (error: unknown) => console.warn(`[cezar] task report: ${error instanceof Error ? error.message : String(error)}`);
  setImmediate(() => {
    if (!watch.enabled()) return;
    void Promise.resolve(watch.projectId())
      .then((projectId) => watch.engine.reconcileProject(projectId, watch.dataDir, watch.store.listRuns()))
      .catch(warn);
  });
  const onRun = (run: RunRecord) => {
    const next = signature(run);
    if (seen.get(run.id) === next) return;
    seen.set(run.id, next);
    if (next === undefined || !watch.enabled()) return;
    // Off the store's emit: the run's final events and index write land first.
    setImmediate(() => {
      void Promise.resolve(watch.projectId())
        .then((projectId) => watch.engine.taskChanged(projectId, watch.dataDir, run, (runId) => watch.store.getRun(runId)))
        .catch(warn);
    });
  };
  watch.store.on('run', onRun);
  return () => {
    watch.store.off('run', onRun);
  };
}
