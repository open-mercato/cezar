import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendExitRecord, exitLogPath, formatExitLine } from './exit-diagnostics.ts';

const here = new URL('.', import.meta.url).pathname;
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cez-exitlog-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('exit diagnostics', () => {
  it('places the log under the cezar home', () => {
    expect(exitLogPath({ CEZ_HOME: dir })).toBe(join(dir, 'logs', 'server-exit.log'));
  });

  it('formats one JSON line with pid, reason and memory', () => {
    const line = formatExitLine('signal', { signal: 'SIGHUP' });
    expect(line.endsWith('\n')).toBe(true);
    const rec = JSON.parse(line);
    expect(rec).toMatchObject({ reason: 'signal', signal: 'SIGHUP', pid: process.pid });
    expect(typeof rec.rssMb).toBe('number');
  });

  it('creates the directory, appends, and rotates past the cap', () => {
    const path = join(dir, 'logs', 'x.log');
    appendExitRecord(path, 'a\n', 10);
    appendExitRecord(path, 'b\n', 10);
    expect(readFileSync(path, 'utf8')).toBe('a\nb\n');
    appendExitRecord(path, 'cccccc\n', 10);
    expect(readFileSync(`${path}.1`, 'utf8')).toBe('a\nb\n');
    expect(readFileSync(path, 'utf8')).toBe('cccccc\n');
  });

  it('never throws when the path is unwritable', () => {
    const file = join(dir, 'f');
    writeFileSync(file, '');
    expect(() => appendExitRecord(join(file, 'sub', 'x.log'), 'a\n')).not.toThrow();
  });

  function runChild(body: string) {
    rmSync(join(dir, 'logs'), { recursive: true, force: true });
    const script = join(dir, 'child.ts');
    writeFileSync(script, `import { installExitDiagnostics } from ${JSON.stringify(join(here, 'exit-diagnostics.ts'))};
installExitDiagnostics(); ${body}`);
    const r = spawnSync(process.execPath, ['--experimental-strip-types', script], {
      env: { ...process.env, CEZ_HOME: dir }, encoding: 'utf8', timeout: 20_000,
    });
    const log = exitLogPath({ CEZ_HOME: dir });
    return { r, lines: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [] };
  }

  it('records an uncaught exception and still exits non-zero with the stack on stderr', () => {
    const { r, lines } = runChild(`setTimeout(() => { throw new Error('boom'); }, 1);`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('boom');
    expect(lines.map((l) => l.reason)).toEqual(['uncaughtException', 'exit']);
    expect(lines[0].error).toContain('boom');
  });

  it('records an unhandled rejection', () => {
    const { r, lines } = runChild(`Promise.reject(new Error('nope'));`);
    expect(r.status).not.toBe(0);
    expect(lines[0].reason).toBe('unhandledRejection');
  });

  it('records a non-zero exit code and nothing for a clean exit', () => {
    expect(runChild(`process.exitCode = 3;`).lines.map((l) => l.code ?? l.reason)).toEqual([3]);
    expect(runChild(`process.exitCode = 0;`).lines).toEqual([]);
  });

  it('installs once: a second call returns false and records each exit once', () => {
    const { lines, r } = runChild(`console.log(installExitDiagnostics()); process.exitCode = 4;`);
    expect(r.stdout.trim()).toBe('false');
    expect(lines.map((l) => l.code)).toEqual([4]);
  });

  it.skipIf(process.platform === 'win32')('records a lone SIGHUP and still dies from it', () => {
    const { r, lines } = runChild(`process.kill(process.pid, 'SIGHUP'); setTimeout(() => {}, 5000);`);
    expect(r.signal).toBe('SIGHUP');
    expect(lines[0]).toMatchObject({ reason: 'signal', signal: 'SIGHUP' });
  });
});
