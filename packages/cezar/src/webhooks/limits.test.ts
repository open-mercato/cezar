import { realpathSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import * as module from './limits.ts';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe('webhook persistent request limits', () => {
  it('persists the three-tests-per-host limit across restart and endpoint recreation', async () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'webhook-limits-')); dirs.push(dir);
    const limits = await module.ProjectLimits.open(dir);
    for (let i = 0; i < 3; i++) expect(await limits.take({ host: 'example.com', test: true }, 100000)).toEqual({ allowed: true });
    const restored = await module.ProjectLimits.open(dir);
    expect(await restored.take({ host: 'example.com', test: true }, 100000)).toEqual({ allowed: false, retryAt: 160000 });
    expect(await restored.take({ host: 'other.example.com', test: true }, 100000)).toEqual({ allowed: true });
    expect(await restored.take({ host: 'example.com', test: true }, 160000)).toEqual({ allowed: true });
  });
  it('enforces project burst and manual failure rate for retries too', async () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'webhook-limits-')); dirs.push(dir);
    const limits = await module.ProjectLimits.open(dir);
    for (let i = 0; i < 10; i++) expect(await limits.take({ host: 'example.com', manualFailure: true }, 100000)).toEqual({ allowed: true });
    expect(await limits.take({ host: 'example.com' }, 100000)).toEqual({ allowed: false, retryAt: 100500 });
    expect(await limits.take({ host: 'example.com', manualFailure: true }, 101000)).toEqual({ allowed: false, retryAt: 160000 });
    expect(await limits.take({ host: 'example.com' }, 101000)).toEqual({ allowed: true });
  });
  // A hostname is a valid record key but can collide with Object.prototype. Reading it as a
  // plain property used to throw ("hostTests is not iterable"), which broke the service and
  // livelocked delivery on the same pending event.
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])('accepts a hostname named %s without touching Object.prototype', async host => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'webhook-limits-')); dirs.push(dir);
    const limits = await module.ProjectLimits.open(dir);
    expect(await limits.take({ host, test: true }, 100000)).toEqual({ allowed: true });
    expect(await limits.take({ host, test: true }, 100001)).toEqual({ allowed: true });
    expect(await limits.take({ host: 'example.com', test: true }, 100001)).toEqual({ allowed: true });
    expect(({} as Record<string, unknown>).constructor).toBe(Object);
  });
});

describe('backward clock recovery', () => {
  it('rebases an exhausted burst on denial, persists it, and never refills on repeated rollback', async () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'webhook-limits-')); dirs.push(dir);
    let limits = await module.ProjectLimits.open(dir);
    for (let i = 0; i < 10; i++) await limits.take({ host: 'example.com' }, 100000);
    expect(await limits.take({ host: 'example.com' }, 10000)).toEqual({ allowed: false, retryAt: 10500 });
    limits = await module.ProjectLimits.open(dir);
    expect(await limits.take({ host: 'example.com', preview: true }, 10000)).toEqual({ allowed: false, retryAt: 10500 });
    expect(await limits.take({ host: 'example.com' }, 9000)).toEqual({ allowed: false, retryAt: 9500 });
    expect(await limits.take({ host: 'example.com' }, 9500)).toEqual({ allowed: true });
    expect(await limits.take({ host: 'example.com' }, 9500)).toEqual({ allowed: false, retryAt: 10000 });
  });
  it('preserves test and manual-failure window ages across rollback, preview and restart', async () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'webhook-limits-')); dirs.push(dir);
    let limits = await module.ProjectLimits.open(dir);
    for (let i = 0; i < 10; i++) await limits.take({ host: 'example.com', test: i < 3, manualFailure: true }, 100000 + i * 1000);
    expect(await limits.take({ host: 'example.com', test: true, preview: true }, 20000)).toEqual({ allowed: false, retryAt: 71000 });
    limits = await module.ProjectLimits.open(dir);
    expect(await limits.take({ host: 'example.com', manualFailure: true }, 20000)).toEqual({ allowed: false, retryAt: 71000 });
    expect(await limits.take({ host: 'other.example.com', test: true }, 20000)).toEqual({ allowed: true });
    expect(await limits.take({ host: 'example.com', test: true, manualFailure: true }, 71000)).toEqual({ allowed: true });
  });
  it('tracks forward denials before rebasing, and does not consume a successful preview', async () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'webhook-limits-')); dirs.push(dir);
    const limits = await module.ProjectLimits.open(dir);
    for (let i = 0; i < 10; i++) await limits.take({ host: 'example.com' }, 100000);
    expect(await limits.take({ host: 'example.com' }, 100250)).toEqual({ allowed: false, retryAt: 100500 });
    expect(await limits.take({ host: 'example.com' }, 10000)).toEqual({ allowed: false, retryAt: 10250 });
    expect(await limits.take({ host: 'example.com', preview: true }, 10250)).toEqual({ allowed: true });
    expect(await limits.take({ host: 'example.com' }, 10250)).toEqual({ allowed: true });
    expect(await limits.take({ host: 'example.com' }, 10250)).toEqual({ allowed: false, retryAt: 10750 });
  });
  it('bounds epoch-crossing windows and expires them at exactly sixty seconds', async () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'webhook-limits-')); dirs.push(dir);
    let limits = await module.ProjectLimits.open(dir);
    for (let i = 0; i < 3; i++) await limits.take({ host: 'example.com', test: true }, 100000 + i * 1000);
    expect(await limits.take({ host: 'example.com', test: true }, 0)).toEqual({ allowed: false, retryAt: 60000 });
    limits = await module.ProjectLimits.open(dir);
    expect(await limits.take({ host: 'example.com', test: true }, 59999)).toEqual({ allowed: false, retryAt: 60000 });
    expect(await limits.take({ host: 'example.com', test: true }, 60000)).toEqual({ allowed: true });
    expect(await limits.take({ host: 'example.com', test: true }, 1000000)).toEqual({ allowed: true });
    for (let i = 0; i < 9; i++) expect(await limits.take({ host: 'other.example.com' }, 1000000)).toEqual({ allowed: true });
    expect(await limits.take({ host: 'other.example.com' }, 1000000)).toEqual({ allowed: false, retryAt: 1000500 });
  });

});
