// Real OS process and filesystem; only barriers/faults are injected around real I/O.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
const [dir, id, operation = 'strict', barrier = 'rename'] = process.argv.slice(2);
const wait = (name) => {
  const end = Date.now() + 15000;
  while (!fs.existsSync(join(dir, name))) {
    if (Date.now() > end) throw Error(`barrier timeout: ${name}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
};
const { RunStore } = await import('../store.ts');
const store = RunStore.open(dir, { keepLive: true });
const run = store.createRun({ id, title: id, workflow: 'test', task: 'test', steps: [] });
fs.writeFileSync(join(dir, `${id}-ready`), '');
wait(`${id}-start`);
const rename = fs.renameSync;
const read = fs.readFileSync;
const rm = fs.rmSync;
const recovery = /^(release|acquire)-(owner|peer)$/.test(operation);
let injected = false;
let acquisitionFailed = false;
fs.rmSync = (path, ...args) => {
  if (recovery && !injected && String(path).endsWith('.ticket')) {
    injected = true;
    throw Object.assign(Error('one transient release EIO'), { code: 'EIO' });
  }
  return rm(path, ...args);
};
let paused = false;
const pause = () => {
  if (paused) return;
  paused = true;
  fs.writeFileSync(join(dir, `${id}-paused`), '');
  wait(`${id}-release`);
};
fs.renameSync = (from, to) => {
  if (String(to) === join(dir, 'runs.json')) {
    if (barrier === 'rename') pause();
    if (operation === 'fail') throw Error('injected rename failure');
  }
  return rename(from, to);
};
fs.readFileSync = (path, ...args) => {
  if (operation.startsWith('acquire-') && !acquisitionFailed && String(path).endsWith('.ticket')) {
    acquisitionFailed = true;
    throw Object.assign(Error('one transient acquisition EIO'), { code: 'EIO' });
  }
  const result = read(path, ...args);
  if (String(path) === join(dir, 'runs.json') && barrier === 'read') pause();
  return result;
};
syncBuiltinESMExports();
fs.writeFileSync(join(dir, `${id}-attempt`), '');
let error;
try {
  if (operation === 'ordinary') store.flush();
  else store.flushCreatedRun(run);
} catch (e) { error = e.message; }
fs.writeFileSync(join(dir, `${id}-result.json`), JSON.stringify({
  error, retained: !!store.getRun(id),
  ids: JSON.parse(read(join(dir, 'runs.json'), 'utf8')).map(r => r.id),
}));

if (recovery) {
  fs.rmSync = rm;
  fs.readFileSync = read;
  fs.renameSync = rename;
  syncBuiltinESMExports();
  fs.writeFileSync(join(dir, `${id}-fault.json`), JSON.stringify({
    injected, tickets: fs.readdirSync(join(dir, 'runs', '.index-writers')),
  }));
  if (operation.endsWith('-owner')) {
    const next = store.createRun({ id: 'recovered', title: 'recovered', workflow: 'test', task: 'test', steps: [] });
    // Synchronous reacquisition: background cleanup has not had a chance to run.
    let retryError;
    try { store.flushCreatedRun(next); } catch (e) { retryError = e.message; }
    fs.writeFileSync(join(dir, `${id}-retry.json`), JSON.stringify({ error: retryError }));
  } else {
    // Stay alive without another store operation. A peer must recover without PID reaping.
    while (!fs.existsSync(join(dir, `${id}-stop`))) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
}
