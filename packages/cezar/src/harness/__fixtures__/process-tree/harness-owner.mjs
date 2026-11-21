// Plays cezar: starts a real detached process and registers it with the same tracker used by
// validation, probes, and runtime ops. Then leaves as the test asks — `exit` calls process.exit on SIGUSR2;
// `handled` owns SIGINT/SIGTERM like serve/run, turning SIGINT into a delayed process.exit;
// `signal` waits for a signal it does not handle (default death).
// proper-lockfile is loaded as serve/run load it: its signal-exit adds listeners that own nothing.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'proper-lockfile';
import { AGENT_PROCESS_DETACHED, ownProcessShutdown, trackAgentProcessTree } from '../../process-tree.ts';

const [cwd, mode] = process.argv.slice(2);
if (mode === 'exit') process.on('SIGUSR2', () => process.exit(0));
if (mode === 'handled') {
  ownProcessShutdown();
  process.on('SIGINT', () => setTimeout(() => process.exit(130), 50));
}
// Use a host process group so the recorded PIDs belong to the test's namespace.
// Linux's validation sandbox uses a separate session and PID namespace.
const fakeAgent = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));
const agent = spawn(process.execPath, [fakeAgent], {
  cwd,
  detached: AGENT_PROCESS_DETACHED,
  stdio: 'ignore',
});
trackAgentProcessTree(agent);

const started = setInterval(() => {
  if (!existsSync(join(cwd, 'pids.json'))) return;
  clearInterval(started);
  process.stdout.write('ready\n');
}, 20);
setInterval(() => {}, 60_000);
