import { afterEach } from 'vitest';
import { RunStore } from '../runs/store.ts';

const openedStores = new Set<RunStore>();
const openStore = RunStore.open.bind(RunStore);

// Track every store opened by a suite that imports this helper. The wrapper is
// deliberately test-only: production RunStore lifecycle remains unchanged.
RunStore.open = (dataDir, opts) => {
  const store = openStore(dataDir, opts);
  openedStores.add(store);
  return store;
};

/** Flush stores before fixture removal and reject saves scheduled afterwards. */
export function cleanupRunStores(): void {
  for (const store of openedStores) {
    store.flush();
    // Cancellation/disposal can touch the store after this hook returns. A
    // flush alone cannot catch that second schedule, so make this instance
    // inert for the rest of its test lifetime.
    (store as unknown as { scheduleSave: () => void }).scheduleSave = () => {};
  }
  openedStores.clear();
}

// Keep a safety net for suites that do not have a fixture-specific teardown.
// Suites with temporary directories call cleanupRunStores explicitly before rm.
afterEach(cleanupRunStores);
