import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { RunStore } from './store.ts';
it('redacts per-run literal and Basic secrets at persistence and live boundaries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-secrets-'));
  const store = RunStore.open(dir);
  try {
    const run = store.createRun({ title: 'test', task: 'test', workflow: 'test', steps: [{ id: 'work', name: 'work', kind: 'agent' }] });
    const token = 'synthetic-private-value';
    const basic = Buffer.from(`mail@example.com:${token}`).toString('base64');
    store.registerRunSecrets(run.id, [token, basic]);
    const seen: unknown[] = [];
    store.on('event', (event) => seen.push(event));
    store.appendEvent(run.id, { type: 'note', message: `${token} Basic ${basic}` });
    store.emitEphemeral(run.id, { type: 'delta', text: token });
    store.updateRun(run.id, { error: token });
    store.updateStep(run.id, 'work', { error: basic });
    store.flush();
    for (const text of [JSON.stringify(store.readEvents(run.id)), JSON.stringify(seen), readFileSync(join(dir, 'runs.json'), 'utf8')]) {
      expect(text).not.toContain(token);
      expect(text).not.toContain(basic);
    }
    store.clearRunSecrets(run.id);
    expect(store.appendEvent(run.id, { type: 'note', message: token }).message).toBe(token);
  } finally { store.flush(); rmSync(dir, { recursive: true, force: true }); }
});
