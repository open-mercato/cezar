// Child process for the two-process lease contention tests in store.test.ts (#998).
// `.testkit.ts` keeps it out of `tsconfig.json`'s build input, so this test-only
// entry point never reaches `dist` or the published tarball.
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
