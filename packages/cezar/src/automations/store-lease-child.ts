import { AutomationStore } from './store.ts';

const dir = process.argv[2]!;
const store = AutomationStore.open(dir);
process.stdout.write('ready\n');
let started = false;
process.stdin.once('data', () => {
  if (started) return;
  started = true;
  const lease = store.acquireLease();
  process.stdout.write(`${JSON.stringify({ held: Boolean(lease) })}\n`);
  setTimeout(() => lease?.release(), 1_000);
});
