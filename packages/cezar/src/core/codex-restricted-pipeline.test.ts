import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrokeredShell } from './agent-runner.ts';
import { compileCodexRestrictedPolicy } from './codex-restricted-policy.ts';
import { CodexReadBroker, killLiveStages, PIPELINE_REFUSED, runPipeline, stageKillPlan, wholeUtf8, type PipelineOptions } from './codex-restricted-tools.ts';
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

/** Records every stage it really spawns. */
function recordingSpawn(): { spawn: typeof spawn; children: ChildProcess[] } {
  const children: ChildProcess[] = [];
  const recording = ((bin: string, args: readonly string[], options: object) => {
    const child = spawn(bin, args, options);
    children.push(child);
    return child;
  }) as unknown as typeof spawn;
  return { spawn: recording, children };
}

async function waitForFile(path: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const text = existsSync(path) ? readFileSync(path, 'utf8').trim() : '';
    if (text) return text;
    await new Promise((done) => setTimeout(done, 30));
  }
  throw new Error(`${path} never appeared`);
}

/** The first stage really runs; the second fails the way `failure` says. */
function failingSecondStage(failure: 'throw' | 'no-stdio'): { spawn: typeof spawn; first: () => ChildProcess | undefined } {
  let first: ChildProcess | undefined;
  const fake = ((bin: string, args: readonly string[], options: object) => {
    if (!first) return (first = spawn(bin, args, options));
    if (failure === 'throw') throw new Error('spawn E2BIG');
    // Node reports EMFILE on the child a tick later; an unheard 'error' would crash the process.
    const broken = new EventEmitter();
    process.nextTick(() => broken.emit('error', new Error('spawn EMFILE')));
    return Object.assign(broken, { stdin: null, stdout: null, stderr: null, pid: undefined, exitCode: null, signalCode: null, kill: () => true });
  }) as unknown as typeof spawn;
  return { spawn: fake, first: () => first };
}

it('spawns each stage in its own process group except on Windows, where detached opens a console', async () => {
  const seen: Array<{ detached?: boolean; windowsHide?: boolean }> = [];
  const recording = ((bin: string, args: readonly string[], options: { detached?: boolean; windowsHide?: boolean }) => {
    seen.push({ detached: options.detached, windowsHide: options.windowsHide });
    return spawn(bin, args, options);
  }) as unknown as typeof spawn;
  const ran = await runPipeline([[node, '-e', "process.stdout.write('ok')"]], undefined, opts({ spawn: recording }));
  expect(ran).toEqual({ ok: true, text: 'ok' });
  expect(seen).toEqual([{ detached: process.platform !== 'win32', windowsHide: true }]);
});

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

  it('reports output over the cap as truncated success and stops an endless writer', async () => {
    const started = Date.now();
    const ran = await runPipeline([[node, '-e', "const more = () => process.stdout.write('x'.repeat(65536), more); more()"]], undefined, opts({ timeoutMs: 20_000 }));
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(ran.ok).toBe(true);
    expect(ran.text.startsWith('x'.repeat(256_000))).toBe(true);
    expect(ran.text.endsWith('[cezar: output truncated; narrow the pattern, path or range]')).toBe(true);
    expect(ran.text).not.toContain('[exit');
  });

  it('truncates on a UTF-8 character boundary: no U+FFFD before the marker', async () => {
    // 'ab' + 3-byte '€'s: the 256,000-byte cap falls inside a character.
    const ran = await runPipeline([[node, '-e', "const more = () => process.stdout.write('€'.repeat(20000), more); process.stdout.write('ab', more)"]], undefined, opts({ timeoutMs: 20_000 }));
    expect(ran.ok).toBe(true);
    const body = ran.text.replace('\n[cezar: output truncated; narrow the pattern, path or range]', '');
    expect(body).not.toContain('\uFFFD');
    expect(body).toBe(`ab${'€'.repeat(Math.floor((256_000 - 2) / 3))}`);
  });

  it('caps stderr at exactly 16 KB, on a character boundary', async () => {
    const ran = await runPipeline([[node, '-e', "process.stderr.write('e'.repeat(100000)); process.stderr.write('é'.repeat(10))"]], undefined, opts());
    const stderr = ran.text.slice(ran.text.indexOf('[stderr]\n') + '[stderr]\n'.length);
    expect(stderr).toBe('e'.repeat(16_000));
    expect(wholeUtf8(Buffer.from('aé', 'utf8').subarray(0, 2)).toString('utf8')).toBe('a');
    expect(wholeUtf8(Buffer.from('a€', 'utf8')).toString('utf8')).toBe('a€');
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
    const recording = recordingSpawn();
    const ran = await runPipeline([['sleep', '30'], ['cez-no-such-binary-2458']], undefined, opts({ spawn: recording.spawn }));
    expect(ran.ok).toBe(false);
    expect(ran.text).toContain('cez-no-such-binary-2458');
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await gone(recording.children[0]!.pid!)).toBe(true);
  });

  it('hears an earlier stage\'s late spawn error when a later spawn throws (no uncaught exception)', async () => {
    const unheard = vi.fn();
    process.on('uncaughtException', unheard);
    try {
      let calls = 0;
      const fake = ((bin: string, args: readonly string[], options: object) => {
        if (calls++ === 0) return spawn(bin, args, options); // ENOENT arrives as 'error' a tick later
        throw new Error('spawn E2BIG');
      }) as unknown as typeof spawn;
      const ran = await runPipeline([['cez-no-such-binary-2460'], ['cat']], undefined, opts({ spawn: fake }));
      expect(ran.ok).toBe(false);
      expect(ran.text).toContain('could not start cat: spawn E2BIG');
      await new Promise((done) => setTimeout(done, 100));
      expect(unheard).not.toHaveBeenCalled();
    } finally {
      process.off('uncaughtException', unheard);
    }
  });

  it('never signals the group of a stage that already closed', async () => {
    const recording = recordingSpawn();
    const kill = vi.spyOn(process, 'kill');
    try {
      const ran = await runPipeline([['true'], ['sleep', '30']], undefined, opts({ spawn: recording.spawn, timeoutMs: 500 }));
      expect(ran.text).toContain('timed out');
      const [first, second] = recording.children;
      const groups = kill.mock.calls.filter(([pid, signal]) => signal === 'SIGKILL' && typeof pid === 'number' && pid < 0).map(([pid]) => pid);
      expect(groups).toContain(-second!.pid!);
      expect(groups).not.toContain(-first!.pid!);
    } finally {
      kill.mockRestore();
    }
  });

  it('kills its live stages when the server exits', async () => {
    const recording = recordingSpawn();
    const started = Date.now();
    const running = runPipeline([['sleep', '30']], undefined, opts({ spawn: recording.spawn }));
    await new Promise((done) => setTimeout(done, 100));
    expect(process.listeners('exit')).toContain(killLiveStages);
    killLiveStages();
    const ran = await running;
    expect(ran.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await gone(recording.children[0]!.pid!)).toBe(true);
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
    const broker = brokerFor(shell, true, { shellTimeoutMs: 30_000, backstopMs: 2_000 });
    const started = Date.now();
    const hang = call(broker, 'hang');
    // The stage is known to be running before the backstop can fire.
    const pid = Number(await waitForFile(pidFile));
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(pid).toBeGreaterThan(0);
    expect(await hang).toEqual({ success: false, text: 'cezar: read timed out; this broker is closed' });
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(await call(broker, 'again')).toMatchObject({ success: false, text: expect.stringContaining('session is closed') });
    expect(await gone(pid)).toBe(true);
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

describe('stage kill plans', () => {
  it('kills a POSIX stage\'s process group and a Windows stage\'s tree', () => {
    expect(stageKillPlan(4242, 'linux')).toEqual({ group: -4242 });
    expect(stageKillPlan(4242, 'darwin')).toEqual({ group: -4242 });
    expect(stageKillPlan(4242, 'win32')).toEqual({ taskkill: ['/pid', '4242', '/T', '/F'] });
  });
});
