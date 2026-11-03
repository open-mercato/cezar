// Real RunManager persistence boundary, in a disposable process and CEZ_HOME.
import { join } from 'node:path';
import { RunManager } from '../../workflows/run.ts';
import { RunStore } from '../../runs/store.ts';
import { AutomationStore } from '../store.ts';
import { ScheduleRunner } from '../schedule-runner.ts';
const [dir, boundary] = process.argv.slice(2);
process.env.CEZ_HOME = join(dir, 'home');
process.env.CEZ_DRY_RUN = '1';
process.env.CEZ_AUTONAME = '0';
process.env.CEZ_NO_BANNER = '1';
const store = AutomationStore.open(dir);
const runs = RunStore.open(dir);
const manager = new RunManager(runs, dir);
const flush = runs.flush.bind(runs);
let writes = 0;
runs.flush = options => {
  if (!options?.throwOnError) return flush(options);
  if (boundary === 'before') process.kill(process.pid, 'SIGKILL');
  flush(options);
  writes++;
  if (boundary === 'partial' || writes === 2) process.kill(process.pid, 'SIGKILL');
};
const definition = store.list()[0];
const runner = new ScheduleRunner({ projectId: 'fixture', store, timeZone: 'UTC', validateDeferred: async () => {},
  launch: async (def, occurrence, receiptId) => {
    for (const id of def.deferredStart.runIds) manager.startRun({ name: 'fixture', source: 'built-in', steps: [{ id: 'task', prompt: 'fixture' }] }, {
      task: def.task.prompt, runner: 'claude', worktree: false,
      scheduledLaunch: { id, binding: def.deferredStart.binding, provenance: { automationId: def.id, automationRevision: def.revision, receiptId, trigger: occurrence.trigger, occurrenceAt: occurrence.at } },
    });
    throw new Error('Fault boundary was not reached');
  },
});
await runner.runNow(definition);
manager.dispose();
process.exit(2);
