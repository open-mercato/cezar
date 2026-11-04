import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as storage from './storage.ts';
import { realpathSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as ownership from './ownership.ts';
const dirs: string[] = [];
const directory = () => { const d = mkdtempSync(join(realpathSync(tmpdir()), 'webhook-owner-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
describe('verified project webhook ownership', () => {
  it('allows exactly one live owner and checks its token before every mutation', async () => {
    const dir = directory(); const first = await ownership.acquireOwnership(dir);
    expect(first).toBeDefined(); expect(first!.valid()).toBe(true);
    expect(await ownership.acquireOwnership(dir)).toBeUndefined();
    const record = JSON.parse(readFileSync(join(dir, 'owner.lock'), 'utf8'));
    writeFileSync(join(dir, 'owner.lock'), JSON.stringify({ ...record, token: '00000000-0000-4000-8000-000000000001' }));
    expect(first!.valid()).toBe(false);
    await first!.release();
    expect(JSON.parse(readFileSync(join(dir, 'owner.lock'), 'utf8')).token).not.toBe(record.token);
  });
  it('reads an owner identity whose long data directory overflows the old 2 KiB cap', async () => {
    const dir = directory(); const first = await ownership.acquireOwnership(dir);
    const record = JSON.parse(readFileSync(join(dir, 'owner.lock'), 'utf8')); await first!.release();
    writeFileSync(join(dir, 'owner.lock'), JSON.stringify({ ...record, directory: 'x'.repeat(3000) }));
    // A live owner with an unusually deep project path must be recognized, not rejected forever.
    expect(await ownership.acquireOwnership(dir)).toBeUndefined();
  });
  it('recovers a provably dead PID without treating heartbeat age as proof', async () => {
    const dir = directory(); const initial = await ownership.acquireOwnership(dir);
    const record = JSON.parse(readFileSync(join(dir, 'owner.lock'), 'utf8')); await initial!.release();
    writeFileSync(join(dir, 'owner.lock'), JSON.stringify({ ...record, pid: 2147483647 }));
    const recovered = await ownership.acquireOwnership(dir);
    expect(recovered?.valid()).toBe(true); expect(recovered?.recovered).toBe(true);
    await recovered!.release();
  });
  it('distinguishes PID reuse using start ticks and handles simultaneous recovery contenders', async () => {
    const dir = directory(); const initial = await ownership.acquireOwnership(dir);
    const record = JSON.parse(readFileSync(join(dir, 'owner.lock'), 'utf8')); await initial!.release();
    writeFileSync(join(dir, 'owner.lock'), JSON.stringify({ ...record, start: '0' }));
    const results = await Promise.all([ownership.acquireOwnership(dir), ownership.acquireOwnership(dir), ownership.acquireOwnership(dir)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    await results.find(Boolean)!.release();
  });
  it('reclaims crash-orphan candidate files while preserving live contenders', async () => {
    const dir = directory(); const first = await ownership.acquireOwnership(dir);
    const record = JSON.parse(readFileSync(join(dir, 'owner.lock'), 'utf8')); await first!.release();
    const dead = { ...record, token: '00000000-0000-4000-8000-000000000001', pid: 2147483647 };
    const live = { ...record, token: '00000000-0000-4000-8000-000000000002' };
    // A successor slot is named after the dead PREDECESSOR and holds the CLAIMANT's identity, so the
    // two tokens differ — the shape a crashed recovery leaves behind.
    const deadClaimant = { ...record, token: '00000000-0000-4000-8000-00000000000b', pid: 2147483647 };
    const liveClaimant = { ...record, token: '00000000-0000-4000-8000-00000000000c' };
    writeFileSync(join(dir, `owner-record-${dead.token}.json`), JSON.stringify(dead));
    writeFileSync(join(dir, `owner-publication-${dead.token}.tmp`), JSON.stringify(dead));
    writeFileSync(join(dir, `owner-next-${dead.token}.json`), JSON.stringify(deadClaimant));
    writeFileSync(join(dir, `owner-record-${live.token}.json`), JSON.stringify(live));
    writeFileSync(join(dir, `owner-next-${live.token}.json`), JSON.stringify(liveClaimant));
    const next = await ownership.acquireOwnership(dir);
    expect(existsSync(join(dir, `owner-record-${dead.token}.json`))).toBe(false);
    expect(existsSync(join(dir, `owner-publication-${dead.token}.tmp`))).toBe(false);
    expect(existsSync(join(dir, `owner-next-${dead.token}.json`))).toBe(false);
    expect(existsSync(join(dir, `owner-record-${live.token}.json`))).toBe(true);
    expect(existsSync(join(dir, `owner-next-${live.token}.json`))).toBe(true);
    await next!.release();
  });
  it('excludes a separate live process and recovers its lock after a crash', async () => {
    const dir = directory();
    const moduleUrl = new URL('./ownership.ts', import.meta.url).href;
    const code = `import { acquireOwnership } from ${JSON.stringify(moduleUrl)}; const owner = await acquireOwnership(${JSON.stringify(dir)}); if (!owner) process.exit(2); console.log('locked'); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        once(child.stdout!, 'data').then(([chunk]) => { expect(String(chunk).trim()).toBe('locked'); }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Owner fixture did not start')), 35_000); }),
      ]);
      if (timer) clearTimeout(timer);
      expect(await ownership.acquireOwnership(dir)).toBeUndefined();
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
      const recovered = await ownership.acquireOwnership(dir);
      expect(recovered?.recovered).toBe(true); expect(recovered?.valid()).toBe(true);
      await recovered!.release();
    } finally { if (timer) clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; } }
  }, 150_000);
  it('fails closed for foreign hosts and malformed ownership metadata', async () => {
    const dir = directory(); const initial = await ownership.acquireOwnership(dir);
    const record = JSON.parse(readFileSync(join(dir, 'owner.lock'), 'utf8')); await initial!.release();
    writeFileSync(join(dir, 'owner.lock'), JSON.stringify({ ...record, host: 'another-machine' }));
    await expect(ownership.acquireOwnership(dir)).rejects.toThrow('identity');
    writeFileSync(join(dir, 'owner.lock'), '{}');
    await expect(ownership.acquireOwnership(dir)).rejects.toThrow('owner');
  });
  it('releases its unpublished live lock if durable acquisition fails', async () => {
    const dir = directory(); const failure = vi.spyOn(storage, 'syncDirectory').mockRejectedValueOnce(new Error('disk failure'));
    await expect(ownership.acquireOwnership(dir)).rejects.toThrow('disk failure'); failure.mockRestore();
    const retry = await ownership.acquireOwnership(dir); expect(retry).toBeDefined(); await retry!.release();
  });

});
