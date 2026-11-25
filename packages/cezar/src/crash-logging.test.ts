import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { describeError, installCrashLogging } from './crash-logging.ts';

const here = dirname(fileURLToPath(import.meta.url));

describe('installCrashLogging', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => uninstall?.());

  it('logs an unhandled rejection with a timestamp and its stack', () => {
    const lines: string[] = [];
    uninstall = installCrashLogging({ write: (line) => lines.push(line), now: () => new Date('2026-11-25T12:37:33.000Z') });
    const error = new Error('boom');
    process.emit('unhandledRejection', error, Promise.resolve());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('2026-11-25T12:37:33.000Z unhandled promise rejection');
    expect(lines[0]).toContain(error.stack!);
  });

  it('removes both handlers on uninstall', () => {
    const before = [process.listenerCount('unhandledRejection'), process.listenerCount('uncaughtExceptionMonitor')];
    const remove = installCrashLogging({ write: () => {} });
    remove();
    expect([process.listenerCount('unhandledRejection'), process.listenerCount('uncaughtExceptionMonitor')]).toEqual(before);
  });

  it('describes a non-Error rejection value', () => {
    expect(describeError('plain')).toBe('plain');
    expect(describeError({ code: 42 })).toBe('{"code":42}');
    expect(describeError(undefined)).toBe('undefined');
  });

  // Real processes: Node's default for an unhandled rejection is exit 1 — the cockpit and every
  // running task with it. With the handler installed the process keeps going.
  it('keeps a process running through an unhandled rejection, and still stops on an uncaught throw', () => {
    const module = JSON.stringify(join(here, 'crash-logging.ts'));
    const run = (body: string) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e',
      `const { installCrashLogging } = await import(${module}); installCrashLogging(); ${body}`], { encoding: 'utf8', timeout: 20_000 });

    const rejected = run(`Promise.reject(new Error('lost')); setTimeout(() => console.log('still serving'), 100);`);
    expect(rejected.status).toBe(0);
    expect(rejected.stdout).toContain('still serving');
    expect(rejected.stderr).toMatch(/unhandled promise rejection — the cockpit keeps running:\nError: lost/);

    const thrown = run(`setTimeout(() => { throw new Error('fatal'); }, 10); setTimeout(() => console.log('survived'), 200);`);
    expect(thrown.status).toBe(1);
    expect(thrown.stdout).not.toContain('survived');
    expect(thrown.stderr).toMatch(/uncaught exception \(uncaughtException\) — the cockpit stops:\nError: fatal/);
  });
});
