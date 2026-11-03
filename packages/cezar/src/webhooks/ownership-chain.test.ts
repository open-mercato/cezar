import { hostname } from 'node:os';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The chain walk is exercised without an OS probe per link: a long dead chain would otherwise cost
// one probe each (a cold PowerShell spawn on Windows) and make this test host-dependent.
vi.mock('./process-identity.ts', () => ({
  ownProcessIdentity: async () => ({ pid: 4242, start: '1', boot: 'boot' }),
  processStarts: async (pids: number[]) => new Map(pids.filter(pid => pid === 4242).map(pid => [pid, '1'])),
}));
import * as ownership from './ownership.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const dir = mkdtempSync(join(realpathSync(tmpdir()), 'webhook-chain-')); dirs.push(dir); return dir; };

// A successor slot is named after the dead PREDECESSOR token and holds the CLAIMANT identity.
const token = (i: number) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
const dead = (holder: string) => ({ token: holder, pid: 2147483647, start: '1', boot: 'boot', host: hostname() });
const live = (holder: string) => ({ ...dead(holder), pid: 4242 });
const slot = (dir: string, predecessor: string) => join(dir, `owner-next-${predecessor}.json`);

describe('recovery chain', () => {
  it('walks a long dead chain instead of wedging on a fixed depth bound', async () => {
    const dir = scratch();
    writeFileSync(join(dir, 'owner.lock'), JSON.stringify(dead(token(0))));
    for (let i = 0; i < 200; i++) writeFileSync(slot(dir, token(i)), JSON.stringify(dead(token(i + 1))));

    const owner = await ownership.acquireOwnership(dir);
    expect(owner?.recovered).toBe(true);
    expect(owner?.valid()).toBe(true);
    expect(readdirSync(dir).filter(name => name.startsWith('owner-next-'))).toEqual([]);
    await owner!.release();
  });

  it('fails closed on a chain that cycles instead of hanging', async () => {
    const dir = scratch();
    writeFileSync(join(dir, 'owner.lock'), JSON.stringify(dead(token(0))));
    writeFileSync(slot(dir, token(0)), JSON.stringify(dead(token(1))));
    writeFileSync(slot(dir, token(1)), JSON.stringify(dead(token(2))));
    writeFileSync(slot(dir, token(2)), JSON.stringify(dead(token(1))));

    await expect(ownership.acquireOwnership(dir)).rejects.toThrow('cycles');
    expect(existsSync(join(dir, 'owner.lock'))).toBe(true);
  });

  it('backs off while a live contender holds the successor slot, and keeps its slot', async () => {
    const dir = scratch();
    writeFileSync(join(dir, 'owner.lock'), JSON.stringify(dead(token(0))));
    writeFileSync(slot(dir, token(0)), JSON.stringify(live(token(1))));

    expect(await ownership.acquireOwnership(dir)).toBeUndefined();
    expect(JSON.parse(readFileSync(slot(dir, token(0)), 'utf8')).token).toBe(token(1));
  });

  it('removes no orphan before it has published, so a failed acquisition deletes nothing', async () => {
    const dir = scratch();
    writeFileSync(join(dir, 'owner.lock'), JSON.stringify(dead(token(0))));
    // The live claimant blocks the walk; the dead orphan is not on that path.
    writeFileSync(slot(dir, token(0)), JSON.stringify(live(token(1))));
    writeFileSync(slot(dir, token(9)), JSON.stringify(dead(token(10))));

    expect(await ownership.acquireOwnership(dir)).toBeUndefined();
    expect(existsSync(slot(dir, token(9)))).toBe(true);
  });
});
