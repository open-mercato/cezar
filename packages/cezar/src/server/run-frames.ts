import { WORKSPACE_RUN_EVENT_OMITTED_KEYS, type WorkspaceRunEvent } from '@open-mercato/cezar-contract';
import type { RunRecord, RunStore } from '../runs/store.ts';

/**
 * The SSE `data:` strings for one `run` emit, each built at most once however many streams
 * relay it. `record` is the bare record (per-project and per-run streams); `workspace` is the
 * slim, project-stamped frame of `GET /api/v1/workspace/events`.
 */
export interface RunFrames {
  record(): string;
  workspace(project: string): string;
}

export type RunFrameListener = (run: RunRecord, frames: RunFrames) => void;

export function toWorkspaceRunEvent(run: RunRecord, project: string): WorkspaceRunEvent {
  const frame: Record<string, unknown> = { ...run, project };
  for (const key of WORKSPACE_RUN_EVENT_OMITTED_KEYS) delete frame[key];
  return frame as WorkspaceRunEvent;
}

const hubs = new WeakMap<RunStore, Set<RunFrameListener>>();
const dispatchers = new WeakMap<RunStore, (run: RunRecord) => void>();

/**
 * Subscribe to a store's `run` emits through one shared store listener, so N open streams cost
 * one `JSON.stringify` per frame shape instead of N. The store emits the SAME mutable record
 * object on every change, so a cache keyed on the object would serve stale text; the memo lives
 * only for the duration of one synchronous dispatch.
 */
export function onRunFrames(store: RunStore, listener: RunFrameListener): () => void {
  let listeners = hubs.get(store);
  if (!listeners) {
    const subscribed = new Set<RunFrameListener>();
    listeners = subscribed;
    hubs.set(store, subscribed);
    const dispatch = (run: RunRecord): void => {
      let record: string | undefined;
      const workspace = new Map<string, string>();
      const frames: RunFrames = {
        record: () => (record ??= JSON.stringify(run)),
        workspace: (project) => {
          let text = workspace.get(project);
          if (text === undefined) {
            text = JSON.stringify(toWorkspaceRunEvent(run, project));
            workspace.set(project, text);
          }
          return text;
        },
      };
      for (const each of [...subscribed]) each(run, frames);
    };
    store.on('run', dispatch);
    dispatchers.set(store, dispatch);
  }
  listeners.add(listener);
  return () => {
    const current = hubs.get(store);
    if (!current) return;
    current.delete(listener);
    if (current.size > 0) return;
    const dispatch = dispatchers.get(store);
    if (dispatch) store.off('run', dispatch);
    hubs.delete(store);
    dispatchers.delete(store);
  };
}
