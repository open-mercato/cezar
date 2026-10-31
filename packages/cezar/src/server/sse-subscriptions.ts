import type { RunEvent, RunStore } from '../runs/store.ts';

export type RunEventListener = (event: RunEvent) => void;
export type RunDeletedListener = (runId: string) => void;

type EventPayload = { runId: string; event: RunEvent };

interface EventHub {
  listeners: Map<string, Set<RunEventListener>>;
  dispatch: (payload: EventPayload) => void;
}

interface DeletedHub {
  listeners: Set<RunDeletedListener>;
  dispatch: (runId: string) => void;
}

const eventHubs = new WeakMap<RunStore, EventHub>();
const deletedHubs = new WeakMap<RunStore, DeletedHub>();

export function onRunEvent(store: RunStore, runId: string, listener: RunEventListener): () => void {
  let hub = eventHubs.get(store);
  if (!hub) {
    const dispatch = (payload: EventPayload): void => {
      const listeners = hub?.listeners.get(payload.runId);
      if (!listeners) return;
      for (const each of [...listeners]) each(payload.event);
    };
    hub = { listeners: new Map(), dispatch };
    eventHubs.set(store, hub);
    store.on('event', dispatch);
  }
  let listeners = hub.listeners.get(runId);
  if (!listeners) {
    listeners = new Set();
    hub.listeners.set(runId, listeners);
  }
  listeners.add(listener);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const current = eventHubs.get(store);
    const currentListeners = current?.listeners.get(runId);
    if (!currentListeners) return;
    currentListeners.delete(listener);
    if (currentListeners.size > 0) return;
    current?.listeners.delete(runId);
    if (current && current.listeners.size === 0) {
      store.off('event', current.dispatch);
      eventHubs.delete(store);
    }
  };
}

export function onRunDeleted(store: RunStore, listener: RunDeletedListener): () => void {
  let hub = deletedHubs.get(store);
  if (!hub) {
    const dispatch = (runId: string): void => {
      const listeners = hub?.listeners;
      if (!listeners) return;
      for (const each of [...listeners]) each(runId);
    };
    hub = { listeners: new Set(), dispatch };
    deletedHubs.set(store, hub);
    store.on('deleted', dispatch);
  }
  hub.listeners.add(listener);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const current = deletedHubs.get(store);
    if (!current) return;
    current.listeners.delete(listener);
    if (current.listeners.size === 0) {
      store.off('deleted', current.dispatch);
      deletedHubs.delete(store);
    }
  };
}
