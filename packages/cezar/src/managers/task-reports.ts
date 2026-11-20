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
  engine: Pick<ManagerEngine, 'taskChanged' | 'reconcileProject'> & Partial<Pick<ManagerEngine, 'taskEnded'>>;
  /** `CEZ_MANAGERS=0` posts nothing. */
  enabled: () => boolean;
}

/** The event's identity without the project id: only a change of it is worth a look. */
const signature = (run: RunRecord): string | undefined => taskEventOf('', run)?.ledger;

/** What ends a manager card about the run (Questions inbox spec): archived, done, review, cancelled. */
const endOf = (run: RunRecord): string | undefined =>
  run.archived ? 'archived' : run.status === 'done' || run.status === 'review' || run.status === 'cancelled' ? run.status : undefined;

/** Returns the unsubscribe. At attach it hands the engine the whole list, for what happened unheard. */
export function watchTaskReports(watch: TaskReportWatch): () => void {
  const seen = new Map(watch.store.listRuns().map((run) => [run.id, signature(run)] as const));
  const ends = new Map(watch.store.listRuns().map((run) => [run.id, endOf(run)] as const));
  const warn = (error: unknown) => console.warn(`[cezar] task report: ${error instanceof Error ? error.message : String(error)}`);
  setImmediate(() => {
    if (!watch.enabled()) return;
    void Promise.resolve(watch.projectId())
      .then((projectId) => watch.engine.reconcileProject(projectId, watch.dataDir, watch.store.listRuns()))
      .catch(warn);
  });
  const ended = (runId: string, run: RunRecord | undefined) => {
    if (!watch.engine.taskEnded || !watch.enabled()) return;
    setImmediate(() => {
      void Promise.resolve(watch.projectId())
        .then((projectId) => watch.engine.taskEnded?.(projectId, runId, run))
        .catch(warn);
    });
  };
  const onRun = (run: RunRecord) => {
    const end = endOf(run);
    if (ends.get(run.id) !== end) {
      ends.set(run.id, end);
      if (end !== undefined) ended(run.id, run);
    }
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
  const onDeleted = (runId: string) => {
    seen.delete(runId);
    ends.delete(runId);
    ended(runId, undefined);
  };
  watch.store.on('run', onRun);
  watch.store.on('deleted', onDeleted);
  return () => {
    watch.store.off('run', onRun);
    watch.store.off('deleted', onDeleted);
  };
}
