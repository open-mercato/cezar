import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter, getEventListeners } from 'node:events';
import { PassThrough } from 'node:stream';
import { accessSync, chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrokeredShell } from './agent-runner.ts';
import { compileCodexRestrictedPolicy } from './codex-restricted-policy.ts';
import { CodexReadBroker, killLiveStages, killStage, liveStageCount, onStageExit, PIPELINE_REFUSED, resolveProgram, runPipeline, stageKillPending, stageKillPlan, taskkillPath, wholeUtf8, type PipelineOptions } from './codex-restricted-tools.ts';
import { managerShellPlan } from '../managers/bash-policy.ts';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, statSync: vi.fn(actual.statSync), accessSync: vi.fn(actual.accessSync) };
});

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

  it('settles at the timeout with a running stage and a forked grandchild, and kills both', async () => {
    const started = Date.now();
    const ran = await runPipeline([['sh', '-c', 'sleep 30 & echo $!; exec sleep 30']], undefined, opts({ timeoutMs: 300 }));
    expect(ran.ok).toBe(false);
    expect(ran.text).toContain('timed out');
    expect(Date.now() - started).toBeLessThan(5_000);
    const grandchild = Number(ran.text.split('\n')[0]);
    expect(grandchild).toBeGreaterThan(0);
    expect(await gone(grandchild)).toBe(true);
  });

  it('kills what an exiting stage left holding its pipe, once, as it exits', async () => {
    const recording = recordingSpawn();
    const kill = vi.spyOn(process, 'kill');
    try {
      const started = Date.now();
      const ran = await runPipeline([['sh', '-c', 'sleep 30 & echo $!']], undefined, opts({ spawn: recording.spawn, timeoutMs: 20_000 }));
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(ran.ok).toBe(true);
      expect(await gone(Number(ran.text.trim()))).toBe(true);
      const group = -recording.children[0]!.pid!;
      expect(kill.mock.calls.filter(([pid]) => pid === group)).toHaveLength(1);
    } finally {
      kill.mockRestore();
    }
  });

  it('reports output over the cap as truncated success and stops an endless writer', async () => {
    const started = Date.now();
    const recording = recordingSpawn();
    const ran = await runPipeline([[node, '-e', "const more = () => process.stdout.write('x'.repeat(65536), more); more()"]], undefined, opts({ spawn: recording.spawn, timeoutMs: 20_000 }));
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await gone(recording.children[0]!.pid!)).toBe(true);
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

  it('caps stderr at exactly 16 KB', async () => {
    const ran = await runPipeline([[node, '-e', "process.stderr.write('e'.repeat(100000))"]], undefined, opts());
    expect(ran.text.slice(ran.text.indexOf('[stderr]\n') + '[stderr]\n'.length)).toBe('e'.repeat(16_000));
  });

  it('cuts stderr on a character boundary when the cap lands inside one', async () => {
    // 15,999 bytes of 'e', then 2-byte 'é's: byte 16,000 is the first half of an 'é'.
    const ran = await runPipeline([[node, '-e', "process.stderr.write('e'.repeat(15999) + 'é'.repeat(100))"]], undefined, opts());
    const stderr = ran.text.slice(ran.text.indexOf('[stderr]\n') + '[stderr]\n'.length);
    expect(stderr).not.toContain('\uFFFD');
    expect(stderr).toBe('e'.repeat(15_999));
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

  it('refuses a pipeline whose program is not on PATH before any stage starts', async () => {
    const recording = recordingSpawn();
    const ran = await runPipeline([['sleep', '30'], ['cez-no-such-binary-2458']], undefined, opts({ spawn: recording.spawn }));
    expect(ran).toEqual({ ok: false, text: 'cezar: `cez-no-such-binary-2458` was not found on PATH' });
    expect(recording.children).toHaveLength(0);
  });

  it('ends a started stage when a later one dies at spawn (ENOENT a tick later)', async () => {
    const recording = recordingSpawn();
    const started = Date.now();
    // Resolution passes the name through, as if the binary vanished between lookup and spawn.
    const ran = await runPipeline([['sleep', '30'], ['cez-no-such-binary-2458']], undefined, opts({ spawn: recording.spawn, resolve: (bin) => bin }));
    expect(ran.ok).toBe(false);
    expect(ran.text).toContain('cez-no-such-binary-2458');
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await gone(recording.children[0]!.pid!)).toBe(true);
  });

  it('runs every stage by absolute path', async () => {
    const recording = recordingSpawn();
    expect(await runPipeline([['echo', 'hi'], ['cat']], undefined, opts({ spawn: recording.spawn }))).toEqual({ ok: true, text: 'hi\n' });
    expect(recording.children.map((child) => child.spawnfile).every((file) => file.startsWith('/'))).toBe(true);
  });

  it('settles at once on an already-aborted signal: no spawn, no listener left', async () => {
    const recording = recordingSpawn();
    const controller = new AbortController();
    controller.abort();
    const ran = await runPipeline([['sleep', '30']], undefined, opts({ spawn: recording.spawn, signal: controller.signal }));
    expect(ran.ok).toBe(false);
    expect(ran.text).toContain('session is closed');
    expect(recording.children).toHaveLength(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('settles even when tearing a stage down throws, and keeps a stage tracked until it closes', async () => {
    const unheard = vi.fn();
    process.on('uncaughtException', unheard);
    const fake = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const broken = () => { const stream = new PassThrough(); stream.destroy = () => { throw new Error('EBADF'); }; return stream; };
    Object.assign(fake, { pid: undefined, exitCode: null, signalCode: null, stdin: new PassThrough(), stdout: broken(), stderr: broken(), kill: () => { throw new Error('EPERM'); } });
    const before = liveStageCount();
    try {
      const ran = await runPipeline([['sleep', '30']], undefined, opts({ spawn: (() => fake) as unknown as typeof spawn, timeoutMs: 100 }));
      expect(ran).toMatchObject({ ok: false, text: expect.stringContaining('timed out') });
      // Its call settled, but the stage never closed: server exit must still reach it.
      expect(liveStageCount()).toBe(before + 1);
      fake.emit('close', null);
      expect(liveStageCount()).toBe(before);
      await new Promise((done) => setTimeout(done, 50));
      expect(unheard).not.toHaveBeenCalled();
    } finally {
      process.off('uncaughtException', unheard);
    }
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
      const ran = await runPipeline([['cez-no-such-binary-2460'], ['cat']], undefined, opts({ spawn: fake, resolve: (bin) => bin }));
      expect(ran.ok).toBe(false);
      expect(ran.text).toContain('could not start cat: spawn E2BIG');
      await new Promise((done) => setTimeout(done, 100));
      expect(unheard).not.toHaveBeenCalled();
    } finally {
      process.off('uncaughtException', unheard);
    }
  });

  it('never signals the group of a stage that already exited, past the moment it exits', async () => {
    const recording = recordingSpawn();
    const kill = vi.spyOn(process, 'kill');
    try {
      const ran = await runPipeline([['true'], ['sleep', '30']], undefined, opts({ spawn: recording.spawn, timeoutMs: 500 }));
      expect(ran.text).toContain('timed out');
      const [first, second] = recording.children;
      const groups = kill.mock.calls.filter(([pid, signal]) => signal === 'SIGKILL' && typeof pid === 'number' && pid < 0).map(([pid]) => pid);
      expect(groups).toContain(-second!.pid!);
      // Once, from its own exit; the timeout's kill skips it.
      expect(groups.filter((pid) => pid === -first!.pid!)).toHaveLength(1);
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

  it('leaves no abort listener on the shared signal', async () => {
    const controller = new AbortController();
    const running = runPipeline([['sleep', '30']], undefined, opts({ signal: controller.signal, timeoutMs: 300 }));
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
    await running;
    for (let i = 0; i < 3; i++) await runPipeline([['true']], undefined, opts({ signal: controller.signal }));
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
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
  const brokers: CodexReadBroker[] = [];
  afterEach(() => { for (const broker of brokers.splice(0)) broker.close(); });
  const brokerFor = (shell: BrokeredShell, githubReadsAllowed: boolean, limits?: { shellTimeoutMs?: number; backstopMs?: number }) => {
    const broker = new CodexReadBroker(compileCodexRestrictedPolicy({ allowedTools: ['Read', 'Bash'], brokeredShell: shell })!, { cwd: tempDir() }, {}, githubReadsAllowed, limits);
    brokers.push(broker);
    return broker;
  };

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
    expect(await call(brokerFor(unnamed, false), 'cez-manager tasks')).toEqual({ success: false, text: expect.stringContaining('network commands are disabled by CEZ_CODEX_NETWORK=0 (`cez-manager` may reach the network)') });
    // With the network on, the user's allowed pattern runs.
    expect(await call(brokerFor(shell, true), 'gh label list')).toEqual({ success: true, text: 'gh label list\n' });
  });
});

describe('stage kill plans', () => {
  it('kills a POSIX stage\'s process group and a Windows stage\'s tree, through taskkill by absolute path', () => {
    expect(stageKillPlan(4242, 'linux')).toEqual({ group: -4242 });
    expect(stageKillPlan(4242, 'darwin')).toEqual({ group: -4242 });
    expect(stageKillPlan(4242, 'win32')).toEqual({ taskkill: { file: taskkillPath(), args: ['/pid', '4242', '/T', '/F'] } });
    expect(taskkillPath({ SystemRoot: 'D:\\Win' })).toBe('D:\\Win\\System32\\taskkill.exe');
    expect(taskkillPath({})).toBe('C:\\Windows\\System32\\taskkill.exe');
  });

  const fakeChild = (state: { exitCode?: number | null; signalCode?: string | null } = {}) => {
    const kill = vi.fn(() => true);
    return { child: { pid: 4242, exitCode: null, signalCode: null, ...state, kill } as unknown as ChildProcess, kill };
  };
  const fakeTaskkill = () => {
    const killer = new EventEmitter();
    return { killer, spawn: vi.fn(() => killer) as unknown as typeof spawn };
  };

  it('on Windows waits for taskkill to walk the tree before killing the stage', () => {
    const { child, kill } = fakeChild();
    const { killer, spawn: start } = fakeTaskkill();
    killStage(child, { platform: 'win32', spawn: start });
    expect(start).toHaveBeenCalledWith(taskkillPath(), ['/pid', '4242', '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5_000 });
    expect(kill).not.toHaveBeenCalled();
    killer.emit('exit', 0);
    expect(kill).toHaveBeenCalledTimes(1);
    killer.emit('error', new Error('late'));
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it('on Windows starts one taskkill per stage, however many paths ask', () => {
    const { child } = fakeChild();
    const { killer, spawn: start } = fakeTaskkill();
    killStage(child, { platform: 'win32', spawn: start });
    killStage(child, { platform: 'win32', spawn: start });
    expect(start).toHaveBeenCalledTimes(1);
    expect(stageKillPending(child)).toBe(true);
    killer.emit('exit', 0);
    expect(stageKillPending(child)).toBe(false);
  });

  it('on Windows bounds taskkill: one that never returns still ends the stage after 5 s', () => {
    vi.useFakeTimers();
    try {
      const { child, kill } = fakeChild();
      const { spawn: start } = fakeTaskkill();
      killStage(child, { platform: 'win32', spawn: start });
      expect(start).toHaveBeenCalledWith(taskkillPath(), ['/pid', '4242', '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5_000 });
      vi.advanceTimersByTime(4_999);
      expect(kill).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(kill).toHaveBeenCalledTimes(1);
      expect(stageKillPending(child)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('on Windows falls back to the stage when taskkill cannot even spawn, and never throws', () => {
    const { child, kill } = fakeChild();
    kill.mockImplementation(() => { throw new Error('EPERM'); });
    const throwing = vi.fn(() => { throw new Error('spawn EINVAL'); }) as unknown as typeof spawn;
    expect(() => killStage(child, { platform: 'win32', spawn: throwing })).not.toThrow();
    expect(kill).toHaveBeenCalledTimes(1);
    expect(stageKillPending(child)).toBe(false);
  });

  it('kills by handle only, never taskkill by pid, on the reader-quit path', () => {
    const { child, kill } = fakeChild();
    const { spawn: start } = fakeTaskkill();
    killStage(child, { platform: 'win32', spawn: start, tree: false });
    expect(start).not.toHaveBeenCalled();
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it('on Windows runs taskkill synchronously before the stage at server exit', () => {
    const { child, kill } = fakeChild();
    const order: string[] = [];
    kill.mockImplementation(() => { order.push('kill'); return true; });
    const sync = vi.fn(() => { order.push('taskkill'); return {}; }) as unknown as typeof import('node:child_process').spawnSync;
    killStage(child, { platform: 'win32', sync: true, spawnSync: sync });
    expect(order).toEqual(['taskkill', 'kill']);
    expect(sync).toHaveBeenCalledWith(taskkillPath(), ['/pid', '4242', '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5_000 });
  });

  it('on Windows kills the stage synchronously at server exit even with taskkill pending', () => {
    const { child, kill } = fakeChild();
    const { killer, spawn: start } = fakeTaskkill();
    const sync = vi.fn(() => ({})) as unknown as typeof import('node:child_process').spawnSync;
    killStage(child, { platform: 'win32', spawn: start });
    try {
      expect(stageKillPending(child)).toBe(true);
      killStage(child, { platform: 'win32', sync: true, spawnSync: sync });
      expect(sync).toHaveBeenCalledTimes(1);
      expect(kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      killer.emit('exit', 0);
    }
  });

  it.each([['win32'], ['linux']] as const)('never targets an exited stage\'s pid on %s', (platform) => {
    for (const state of [{ exitCode: 0 }, { signalCode: 'SIGTERM' }]) {
      const { child, kill } = fakeChild(state);
      const { spawn: start } = fakeTaskkill();
      const killGroup = vi.fn();
      killStage(child, { platform, spawn: start, killGroup });
      expect(start).not.toHaveBeenCalled();
      expect(killGroup).not.toHaveBeenCalled();
      expect(kill).toHaveBeenCalledTimes(1);
    }
  });

  it('kills a running POSIX stage\'s group, and an exiting one\'s leftovers only off Windows', () => {
    const { child, kill } = fakeChild();
    const killGroup = vi.fn();
    killStage(child, { platform: 'linux', killGroup });
    expect(killGroup).toHaveBeenCalledWith(-4242);
    expect(kill).toHaveBeenCalledTimes(1);
    const atExit = vi.fn();
    onStageExit(child, { platform: 'darwin', killGroup: atExit });
    expect(atExit).toHaveBeenCalledWith(-4242);
    onStageExit(child, { platform: 'win32', killGroup: atExit });
    expect(atExit).toHaveBeenCalledTimes(1);
  });
});

describe('resolveProgram', () => {
  it('finds a program on an absolute PATH entry and skips relative ones', () => {
    const dir = tempDir();
    const bin = join(dir, 'cez-tool');
    writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
    expect(resolveProgram('cez-tool', { PATH: `relative${delimiter}.${delimiter}${dir}` }, 'linux')).toBe(bin);
    expect(resolveProgram('cez-tool', { PATH: '.' }, 'linux')).toBeUndefined();
    expect(resolveProgram('cez-tool', { PATH: '' }, 'linux')).toBeUndefined();
  });
  it('never resolves a relative path or a non-executable file', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'plain'), 'x', { mode: 0o644 });
    expect(resolveProgram('./cez-tool', { PATH: dir }, 'linux')).toBeUndefined();
    expect(resolveProgram('sub\\tool.exe', { PATH: 'C:\\Windows' }, 'win32')).toBeUndefined();
    expect(resolveProgram('plain', { PATH: dir }, 'linux')).toBeUndefined();
    expect(resolveProgram('rg', { PATH: 'tools;.' }, 'win32')).toBeUndefined();
  });
  const windowsDir = 'C:\\Program Files\\cezar';
  const windowsBin = `${windowsDir}\\cez-manager`;
  it.each([
    { scenario: 'prefers PATHEXT to an extensionless shim', path: windowsDir, extensions: ['', '.EXE', '.CMD'] },
    { scenario: 'accepts quoted absolute PATH entries', path: `"tools";"${windowsDir}"`, extensions: ['.CMD'] },
  ])('on Windows $scenario', ({ path, extensions }) => {
    const file = statSync(node);
    const candidates = extensions.map((extension) => windowsBin + extension);
    const stat = vi.mocked(statSync).mockImplementation((candidate) => {
      if (typeof candidate === 'string' && candidates.includes(candidate)) return file;
      throw new Error('file not found');
    });
    const access = vi.mocked(accessSync).mockImplementation(() => {});
    try {
      expect(resolveProgram('cez-manager', { PATH: path, PATHEXT: '.CMD;.EXE' }, 'win32')).toBe(`${windowsBin}.CMD`);
    } finally {
      stat.mockReset();
      access.mockReset();
    }
  });
  it('lets the read broker run nothing it cannot find on PATH', async () => {
    const broker = new CodexReadBroker(compileCodexRestrictedPolicy({ allowedTools: ['Grep'] })!, { cwd: tempDir() }, { PATH: '' });
    try {
      const reply = await broker.call({ tool: 'cezar_read', arguments: { tool: 'Grep', pattern: 'x' } });
      expect(reply.contentItems[0]!.text).toContain('`rg` was not found on PATH');
    } finally {
      broker.close();
    }
  });
});

// Real processes: CI's unit jobs are Linux-only, so these run only on a Windows machine.
describe.runIf(process.platform === 'win32')('Windows stages, for real', () => {
  it('taskkill /T ends a stage and the child it forked at the timeout', async () => {
    const script = "const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log(c.pid); setInterval(() => {}, 1000)";
    const ran = await runPipeline([[node, '-e', script]], undefined, opts({ timeoutMs: 1_500 }));
    expect(ran.text).toContain('timed out');
    expect(await gone(Number(ran.text.split('\n')[0]))).toBe(true);
  });
  it('documented: a child left holding stdout keeps the call to its timeout and is not killed', async () => {
    const script = "const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'inherit', detached: true }); console.log(c.pid); c.unref()";
    const ran = await runPipeline([[node, '-e', script]], undefined, opts({ timeoutMs: 1_500 }));
    const leftover = Number(ran.text.split('\n')[0]);
    try {
      expect(ran.text).toContain('timed out');
      expect(alive(leftover)).toBe(true);
    } finally {
      try { process.kill(leftover); } catch { /* gone */ }
    }
  });
});
