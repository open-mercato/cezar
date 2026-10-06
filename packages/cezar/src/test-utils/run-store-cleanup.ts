import { RunStore } from '../runs/store.ts';

const openedStores = new Set<RunStore>();
const openStore = RunStore.open.bind(RunStore);

// Test-only registry: production RunStore lifecycle remains unchanged. Keeping this
// in one helper makes every fixture teardown use the same late-write protection.
RunStore.open = (dataDir, opts) => {
  const store = openStore(dataDir, opts);
  openedStores.add(store);
  return store;
};

/** Flush stores before fixture removal and reject saves scheduled afterwards. */
export function cleanupRunStores(): void {
  for (const store of openedStores) {
    store.flush();
    // A manager can schedule one final save while it is being disposed. A flush
    // cannot catch that later schedule, so make the test instance inert before
    // its temporary directory is removed.
    (store as unknown as { scheduleSave: () => void }).scheduleSave = () => {};
  }
  openedStores.clear();
}
