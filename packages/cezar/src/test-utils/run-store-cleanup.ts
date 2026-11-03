import { RunStore } from '../runs/store.ts';

const openedStores = new Set<RunStore>();

/** Register a fixture store for explicit teardown. The helper deliberately does not
 * intercept RunStore.open: a test must retain the real save lifecycle it is trying to
 * exercise, and a late write must remain observable rather than being silently dropped. */
export function registerRunStore(store: RunStore): RunStore {
  openedStores.add(store);
  return store;
}

/** Flush stores before fixture removal. Callers must dispose/drain their managers first. */
export function cleanupRunStores(): void {
  for (const store of openedStores) {
    store.flush();
  }
  openedStores.clear();
}
