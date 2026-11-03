import { describe, expect, it } from 'vitest';
import * as module from './scheduler.ts';
describe('webhook fair process slots', () => {
  it('holds one slot per project and host, giving queued work the released slot', async () => {
    const scheduler = new module.WebhookScheduler(); const seen: string[] = [];
    const release = await scheduler.acquire('a', 'host1');
    const second = scheduler.acquire('a', 'host2').then(value => { seen.push('second'); return value; });
    const third = scheduler.acquire('b', 'host1').then(value => { seen.push('third'); return value; });
    await Promise.resolve(); expect(seen).toEqual([]);
    release!(); const releaseSecond = await second; const releaseThird = await third;
    expect(seen).toEqual(['second', 'third']); releaseSecond!(); releaseThird!();
  });
  it('caps the process at four and removes cancelled waiters', async () => {
    const scheduler = new module.WebhookScheduler();
    const releases = await Promise.all([0, 1, 2, 3].map(i => scheduler.acquire('p' + i, 'h' + i)));
    const controller = new AbortController(); const cancelled = scheduler.acquire('p4', 'h4', controller.signal);
    controller.abort(); expect(await cancelled).toBeUndefined();
    let entered = false; const fifth = scheduler.acquire('p5', 'h5').then(value => { entered = true; return value; });
    await Promise.resolve(); expect(entered).toBe(false);
    releases[0]!(); const releaseFifth = await fifth; expect(entered).toBe(true);
    releases.forEach(release => release!()); releaseFifth!();
  });
});
