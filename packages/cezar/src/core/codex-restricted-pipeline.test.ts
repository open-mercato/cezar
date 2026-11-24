import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BrokeredShell } from './agent-runner.ts';
import { compileCodexRestrictedPolicy } from './codex-restricted-policy.ts';
import { CodexReadBroker, PIPELINE_REFUSED, runPipeline, type PipelineOptions } from './codex-restricted-tools.ts';
import { managerShellPlan } from '../managers/bash-policy.ts';

const node = process.execPath;
const dirs: string[] = [];
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }); });
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), 'cez-pipeline-')); dirs.push(dir); return dir; };
const opts = (extra: Partial<PipelineOptions> = {}): PipelineOptions => ({ cwd: process.cwd(), env: { PATH: process.env.PATH }, signal: new AbortController().signal, ...extra });

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** A killed child stays a zombie until node reaps it; give that a moment. */
async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 40 && alive(pid); i++) await new Promise((done) => setTimeout(done, 50));
  return !alive(pid);
}

/** The first stage really runs; the second fails the way `failure` says. */
function failingSecondStage(failure: 'throw' | 'no-stdio'): { spawn: typeof spawn; first: () => ChildProcess | undefined } {
  let first: ChildProcess | undefined;
  const fake = ((bin: string, args: readonly string[], options: object) => {
    if (!first) return (first = spawn(bin, args, options));
    if (failure === 'throw') throw new Error('spawn E2BIG');
    return Object.assign(new EventEmitter(), { stdin: null, stdout: null, stderr: null, pid: undefined, exitCode: null, signalCode: null, kill: () => true });
  }) as unknown as typeof spawn;
  return { spawn: fake, first: () => first };
}

describe.skipIf(process.platform === 'win32')('runPipeline', () => {
  it.each([
    ['an argv', [['touch', 'STARTED'], ['cat', 'a\0b']], undefined],
    ['the heredoc stdin', [['touch', 'STARTED'], ['cat']], 'a\0b'],
  ])('refuses a control character in %s before spawning anything', async (_where, pipeline, stdin) => {
    let spawned = 0;
    const counting = ((...args: Parameters<typeof spawn>) => { spawned++; return spawn(...args); }) as typeof spawn;
    const ran = await runPipeline(pipeline, stdin, opts({ cwd: tempDir(), spawn: counting }));
    expect(ran).toEqual({ ok: false, text: PIPELINE_REFUSED });
    expect(spawned).toBe(0);
  });

  it('ends a hung stage at the timeout and settles', async () => {
    const started = Date.now();
    const ran = await runPipeline([['sleep', '30']], undefined, opts({ timeoutMs: 200 }));
    expect(ran.ok).toBe(false);
    expect(ran.text).toContain('command timed out after 0.2s');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('settles at the timeout even when a forked grandchild holds the pipe, and kills it', async () => {
    const started = Date.now();
    const ran = await runPipeline([['sh', '-c', 'sleep 30 & echo $!']], undefined, opts({ timeoutMs: 300 }));
    expect(ran.ok).toBe(false);
    expect(ran.text).toContain('timed out');
    expect(Date.now() - started).toBeLessThan(5_000);
    const grandchild = Number(ran.text.split('\n')[0]);
    expect(grandchild).toBeGreaterThan(0);
    expect(await gone(grandchild)).toBe(true);
  });

  it('reports output over the cap as truncated success, like the read path', async () => {
    const ran = await runPipeline([[node, '-e', "process.stdout.write('x'.repeat(300000))"]], undefined, opts());
    expect(ran.ok).toBe(true);
    expect(ran.text.startsWith('x'.repeat(256_000))).toBe(true);
    expect(ran.text.endsWith('[cezar: output truncated; narrow the pattern, path or range]')).toBe(true);
    expect(ran.text).not.toContain('[exit');
  });

  it('decodes multibyte UTF-8 split across chunk boundaries', async () => {
    const expected = `a${'€'.repeat(60_000)}`;
    const ran = await runPipeline([[node, '-e', "process.stdout.write('a' + '€'.repeat(60000))"]], undefined, opts());
    expect(ran).toEqual({ ok: true, text: expected });
  });

  it.each(['throw', 'no-stdio'] as const)('kills a started stage when a later one cannot start (%s)', async (failure) => {
    const fake = failingSecondStage(failure);
    const started = Date.now();
    const ran = await runPipeline([['sleep', '30'], ['cat']], undefined, opts({ spawn: fake.spawn }));
    expect(ran.ok).toBe(false);
    expect(ran.text).toContain('cezar: could not start cat');
    expect(ran.text).toContain(failure === 'throw' ? 'spawn E2BIG' : 'no stdio');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await gone(fake.first()!.pid!)).toBe(true);
  });

  it('ends started stages when a later stage is missing', async () => {
    const started = Date.now();
    const ran = await runPipeline([['sleep', '30'], ['cez-no-such-binary-2458']], undefined, opts());
    expect(ran.ok).toBe(false);
    expect(ran.text).toContain('cez-no-such-binary-2458');
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('ends the writers of a pipeline whose reader quits early, as a shell would', async () => {
    const started = Date.now();
    const ran = await runPipeline([['yes'], ['head', '-1']], undefined, opts());
    expect(ran).toEqual({ ok: true, text: 'y\n' });
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe.skipIf(process.platform === 'win32')('the broker running a manager shell', () => {
  const call = (broker: CodexReadBroker, command: string) =>
    broker.call({ tool: 'cezar_read', arguments: { tool: 'Bash', command } }).then((reply) => ({ success: reply.success, text: reply.contentItems[0]!.text }));
  const brokerFor = (shell: BrokeredShell, githubReadsAllowed: boolean, limits?: { shellTimeoutMs?: number; backstopMs?: number }) =>
    new CodexReadBroker(compileCodexRestrictedPolicy({ allowedTools: ['Read', 'Bash'], brokeredShell: shell })!, { cwd: tempDir() }, {}, githubReadsAllowed, limits);

  it('closes the broker at its backstop when a command outlives it', async () => {
    const pidFile = join(tempDir(), 'pid');
    const shell: BrokeredShell = { describe: 'x', env: { PATH: process.env.PATH }, verify: () => ({ ok: true, pipeline: [['sh', '-c', `echo $$ > ${pidFile}; exec sleep 30`]] }) };
    const broker = brokerFor(shell, true, { shellTimeoutMs: 30_000, backstopMs: 300 });
    const started = Date.now();
    expect(await call(broker, 'hang')).toEqual({ success: false, text: 'cezar: read timed out; this broker is closed' });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await call(broker, 'again')).toMatchObject({ success: false, text: expect.stringContaining('session is closed') });
    const { readFileSync } = await import('node:fs');
    expect(await gone(Number(readFileSync(pidFile, 'utf8')))).toBe(true);
  });

  it('under CEZ_CODEX_NETWORK=0 runs only offline programs: no gh, user-allowed patterns included', async () => {
    const stubs = join(tempDir(), 'bin');
    mkdirSync(stubs);
    for (const name of ['gh', 'cez-manager']) {
      writeFileSync(join(stubs, name), `#!/bin/sh\necho "${name} $*"\n`);
      chmodSync(join(stubs, name), 0o755);
    }
    const shell: BrokeredShell = {
      describe: 'x',
      env: { PATH: `${stubs}${delimiter}${process.env.PATH}` },
      verify: (command) => managerShellPlan(command, ['gh label list']),
      offlinePrograms: ['cez-manager', 'jq', 'grep', 'head'],
    };
    const offline = brokerFor(shell, false);
    expect(await call(offline, 'cez-manager tasks')).toEqual({ success: true, text: 'cez-manager tasks\n' });
    for (const command of ['gh pr view 1', 'gh label list', 'gh pr view 1 | head -1']) {
      expect(await call(offline, command)).toEqual({ success: false, text: expect.stringContaining('network commands are disabled by CEZ_CODEX_NETWORK=0 (`gh` may reach the network)') });
    }
    // A shell that names no offline programs runs nothing with the network off.
    const { offlinePrograms: _offline, ...unnamed } = shell;
    expect((await call(brokerFor(unnamed, false), 'cez-manager tasks')).success).toBe(false);
    // With the network on, the user's allowed pattern runs.
    expect(await call(brokerFor(shell, true), 'gh label list')).toEqual({ success: true, text: 'gh label list\n' });
  });
});
