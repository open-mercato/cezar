// Plays cezar: starts a harness process (validation gate, probe, runtime op) through the harness's
// own detached spawn, then leaves the way the test asks — `exit` calls process.exit on SIGUSR2;
// `handled` owns SIGINT/SIGTERM like serve/run, turning SIGINT into a delayed process.exit;
// `signal` waits for a signal it does not handle (default death).
// proper-lockfile is loaded as serve/run load it: its signal-exit adds listeners that own nothing.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import 'proper-lockfile';

const [cwd, mode] = process.argv.slice(2);
if (mode === 'exit') process.on('SIGUSR2', () => process.exit(0));
if (mode === 'handled') {
  const { ownProcessShutdown } = await import('../../process-tree.ts');
  ownProcessShutdown();
  process.on('SIGINT', () => setTimeout(() => process.exit(130), 50));
}
// A constant command, never argv (CodeQL js/indirect-command-line-injection): the test copies
// the fake agent into `cwd`.
const { runValidationCommands } = await import('../../runtime.ts');
void runValidationCommands(['./fake-agent.mjs'], cwd);

const started = setInterval(() => {
  if (!existsSync(join(cwd, 'pids.json'))) return;
  clearInterval(started);
  process.stdout.write('ready\n');
}, 20);
setInterval(() => {}, 60_000);
