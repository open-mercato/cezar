import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AutomationStore } from '../store.ts';
import { ScheduleRunner } from '../schedule-runner.ts';
const [dir, mode, at] = process.argv.slice(2);
const store = AutomationStore.open(dir);
const definition = store.list()[0];
if (!definition) process.exit(0);
const runner = new ScheduleRunner({ projectId: 'p', store, timeZone: 'UTC', now: () => Number(at),
  validateDeferred: async () => { await new Promise(resolve => setTimeout(resolve, 100)); },
  launch: async def => {
    appendFileSync(join(dir, 'launch-evidence.ndjson'), JSON.stringify(def.deferredStart.runIds) + '\n');
    return { runId: def.deferredStart.runIds[0] };
  },
  deferredRunIds: async (_, ids) => {
    try { return readFileSync(join(dir, 'launch-evidence.ndjson'), 'utf8').trim().split('\n').flatMap(JSON.parse).filter(id => ids.includes(id)); }
    catch { return []; }
  },
});
if (mode === 'cancel' || mode === 'reschedule') {
  const lease = store.acquireLease();
  if (lease) try {
    const fresh = store.get(definition.id);
    if (fresh?.revision === definition.revision && !fresh.deferredStart.runIds.length) {
      if (mode === 'cancel') store.finishDeferred(fresh.id, 'cancelled');
      else store.update(fresh.id, fresh.revision, { ...fresh, deferredStart: { ...fresh.deferredStart, notBefore: new Date(Number(at) + 86400000).toISOString() } });
    }
  } finally { lease.release(); }
} else await (mode === 'manual' ? runner.runNow(definition) : runner.fire(definition));
