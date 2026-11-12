import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { SecretStore } from './secrets.ts';

it('keeps queued local secret writes when their total fsync time exceeds the lock retry budget', async () => {
  const home = await fs.mkdtemp(join(tmpdir(), 'cez-ci-lock-'));
  const root = await fs.mkdtemp(join(tmpdir(), 'cez-ci-root-'));
  const env = { ...process.env, CEZ_HOME: home };
  const scope = { kind: 'project', projectId: 'demo', root } as const;
  const store = () => new SecretStore(env, {keychain: async () => null});
  await store().set(scope, 'SEED', 'seed-value');
  // Thirty 100ms fsyncs exceed the cross-process lock's 200 × 10ms retry budget.
  const open = fs.open.bind(fs);
  const delayed = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const file = await open(...args);
    if (String(args[0]).endsWith('.tmp')) {
      const sync = file.sync.bind(file);
      file.sync = async () => { await new Promise(resolve => setTimeout(resolve, 100)); await sync(); };
    }
    return file;
  });
  try {
    const names = Array.from({length: 30}, (_, i) => `KEY_${i}`);
    const results = await Promise.allSettled(names.map(name => store().set(scope, name, `${name}-value`)));
    const failures = results.filter(result => result.status === 'rejected');
    expect(failures).toEqual([]);
    expect(Object.keys((await store().read(scope)).values).sort()).toEqual(['SEED', ...names].sort());
  } finally {
    delayed.mockRestore();
    await fs.rm(home, {recursive: true, force: true});
    await fs.rm(root, {recursive: true, force: true});
  }
}, 10_000);
