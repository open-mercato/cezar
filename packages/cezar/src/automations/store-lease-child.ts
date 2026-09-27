import { AutomationStore } from './store.ts';

const dir = process.argv[2]!;
const store = AutomationStore.open(dir);
process.stdout.write('ready\n');
process.stdin.once('data', () => {
  const lease = store.acquireLease();
  process.stdout.write(`${JSON.stringify({ held: Boolean(lease) })}\n`);
  setTimeout(() => lease?.release(), 1_000);
});
