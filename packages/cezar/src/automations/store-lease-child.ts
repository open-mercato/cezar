import { AutomationStore } from './store.ts';

const dir = process.argv[2]!;
const at = Number(process.argv[3]);
const store = AutomationStore.open(dir);
while (Date.now() < at) {
  // Synchronize contenders at one wall-clock instant, like two pollers waking together.
}
const lease = store.acquireLease();
process.stdout.write(`${JSON.stringify({ held: Boolean(lease) })}\n`);
setTimeout(() => lease?.release(), 1_000);
