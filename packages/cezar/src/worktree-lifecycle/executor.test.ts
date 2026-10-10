import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeLifecycleCommand, probeLifecycleProcess, type LifecycleExecutorOutput } from './executor.ts';

let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), 'lifecycle-executor-')); vi.stubEnv('CEZ_DRY_RUN', '0'); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(cwd, { recursive: true, force: true }); });
describe('supervised lifecycle executor', () => {
  it('runs in the given cwd, closes stdin, and emits stdout/stderr', async () => {
    const frames: LifecycleExecutorOutput[] = [];
    const result = await executeLifecycleCommand({ command: 'pwd; echo err >&2; read ignored || echo closed', cwd, onOutput: frame => { frames.push(frame); } });
    expect(result).toMatchObject({ state: 'succeeded', exitCode: 0, quiescent: true });
    expect(frames.map(frame => frame.text).join('')).toContain(cwd);
    expect(frames).toContainEqual({ stream: 'stderr', text: 'err\n' });
    expect(frames.map(frame => frame.text).join('')).toContain('closed');
    expect(await probeLifecycleProcess(result.identity!)).toBe('quiescent');
  });
  it('does not execute the command until its start identity is durably saved', async () => {
    const result = await executeLifecycleCommand({ command: 'echo unsafe > marker', cwd, onStart: async () => { throw new Error('read-only state'); } });
    expect(result).toMatchObject({ state: 'failed', quiescent: true });
    await expect(readFile(join(cwd, 'marker'))).rejects.toThrow();
  });
  it('records nonzero exit and missing Bash without throwing', async () => {
    expect(await executeLifecycleCommand({ command: 'exit 7', cwd })).toMatchObject({ state: 'failed', exitCode: 7 });
    expect(await executeLifecycleCommand({ command: 'true', cwd, bashPath: '/missing/cezar-bash' })).toMatchObject({ state: 'failed', quiescent: true });
  });
  it('times out silent children and confirms process-group quiescence', async () => {
    const result = await executeLifecycleCommand({ command: 'sleep 30 & wait', cwd, timeoutSeconds: 1 });
    expect(result).toMatchObject({ state: 'interrupted', quiescent: true });
    expect(result.reason).toContain('timeout');
  });
  it('stops on abort and dry-run never launches commands', async () => {
    const controller = new AbortController();
    const running = executeLifecycleCommand({ command: 'sleep 30', cwd, signal: controller.signal, onStart: async () => { setTimeout(() => controller.abort(), 100); } });
    expect(await running).toMatchObject({ state: 'interrupted', quiescent: true });
    expect(await executeLifecycleCommand({ command: 'touch marker', cwd, dryRun: true })).toMatchObject({ state: 'succeeded' });
    await expect(readFile(join(cwd, 'marker'))).rejects.toThrow();
  });
  it('redacts known secrets and token patterns split across pipe frames', async () => {
    const secret = 'a-very-private-secret-value'; vi.stubEnv('LIFECYCLE_TEST_TOKEN', secret);
    const frames: LifecycleExecutorOutput[] = [];
    const result = await executeLifecycleCommand({ command: "printf a-very-private-; sleep 0.15; printf 'secret-value\\n'; printf ghp_abcdefghijk; sleep 0.15; printf 'lmnopqrstuvwxyz\\n'", cwd, onOutput: frame => { frames.push(frame); } });
    expect(result.state).toBe('succeeded');
    const output = frames.map(frame => frame.text).join('');
    expect(output).not.toContain(secret); expect(output).not.toContain('ghp_');
    expect(output).toContain('[REDACTED]');
  });
  it('reports output persistence failure after exit without leaving a timer', async () => {
    const result = await executeLifecycleCommand({ command: 'echo output', cwd, onOutput: async () => { throw new Error('disk full'); } });
    expect(result).toMatchObject({ state: 'failed', quiescent: true, reason: 'Could not persist lifecycle output' });
  });
  it('bounds output while draining chatty processes and overlong lines', async () => {
    const frames: LifecycleExecutorOutput[] = [];
    const result = await executeLifecycleCommand({ command: "head -c 1800000 /dev/zero | tr '\\0' x; echo; yes short | head -n 200000", cwd, onOutput: frame => { frames.push(frame); } });
    expect(result).toMatchObject({ state: 'succeeded', truncated: true, quiescent: true });
    expect(frames.every(frame => Buffer.byteLength(frame.text) <= 16384)).toBe(true);
    expect(frames.reduce((sum, frame) => sum + Buffer.byteLength(frame.text), 0)).toBeLessThanOrEqual(1048700);
  });
});


describe('Windows supervision with a taskkill fixture', () => {
  async function taskkillFixture(fail = false): Promise<void> {
    const path = join(cwd, 'taskkill');
    await writeFile(path, '#!/bin/bash\nprintf "%s\\n" "$@" > "$(dirname "$0")/taskkill-args"\n' + (fail ? 'exit 1\n' : 'kill -KILL -- "-$2"\n'));
    await chmod(path, 0o700);
    vi.stubEnv('PATH', `${cwd}:${process.env.PATH}`);
  }
  it('terminates the captured live supervisor tree and preserves the command exit code', async () => {
    await taskkillFixture();
    const frames: LifecycleExecutorOutput[] = [];
    const result = await executeLifecycleCommand({command: 'echo command; exit 7', cwd, platform: 'win32', onOutput: frame => { frames.push(frame); }});
    expect(result).toMatchObject({state: 'failed', exitCode: 7, quiescent: true});
    expect((await readFile(join(cwd, 'taskkill-args'), 'utf8')).trim().split('\n')).toEqual(['/PID', String(result.identity!.pid), '/T', '/F']);
    expect(frames.map(frame => frame.text).join('')).toContain('command');
    expect(frames.map(frame => frame.text).join('')).not.toContain('__cezar_');
  });
  it('returns uncertain quiescence when native taskkill fails', async () => {
    await taskkillFixture(true);
    const result = await executeLifecycleCommand({command: 'true', cwd, platform: 'win32'});
    expect(result).toMatchObject({state: 'failed', quiescent: false});
    expect(result.reason).toContain('directory retained');
  });
  it('uses tree termination on stop while the Bash command is running', async () => {
    await taskkillFixture();
    const controller = new AbortController();
    const result = await executeLifecycleCommand({command: 'sleep 30', cwd, platform: 'win32', signal: controller.signal, onStart: async () => { setTimeout(() => controller.abort(), 100); }});
    expect(result).toMatchObject({state: 'interrupted', quiescent: true});
  });
});
