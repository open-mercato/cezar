import { EventEmitter } from 'node:events';
import type { spawn as nodeSpawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

import { RemoteControlService, exitReason, stripAnsi } from './remote-control.ts';

/**
 * The `claude remote-control` process manager (spec 2026-08-26-remote-control). Everything
 * here runs against an injected fake child — a real spawn would register this machine with
 * claude.ai, which is exactly what `refuseSpawnUnderTest` blocks (and why the service only
 * calls it when no `deps.spawn` was injected).
 */

/** What the real CLI prints once connected — including the ANSI redraw noise around it. */
const CONNECTED_OUTPUT =
  '\u001b[6A\u001b[J·✔︎· Connected · repo · HEAD\n' +
  '    Capacity: 0/32\n\n' +
  'Continue coding in the Claude mobile app or https://claude.ai/code?environment=env_01Test123\n' +
  'space to show QR code\n';

const TRUST_REFUSAL =
  'Error: Workspace not trusted. Please run `claude` in /repo first to review and accept the workspace trust dialog.\n';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdinWrites: string[] = [];
  stdin = {
    write: (chunk: string) => {
      this.stdinWrites.push(chunk);
      return true;
    },
    on: () => {},
  };
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  signals: string[] = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(String(signal ?? 'SIGTERM'));
    return true;
  }

  /** Simulate the process ending on its own (or in response to a signal). */
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

function service(child: FakeChild, opts: { connectTimeoutMs?: number; killGraceMs?: number; env?: NodeJS.ProcessEnv } = {}) {
  const spawn = vi.fn((..._args: unknown[]) => child);
  const svc = new RemoteControlService({
    spawn: spawn as unknown as typeof nodeSpawn,
    // A pinned env keeps the developer's real CEZ_DRY_RUN / CEZ_CLAUDE_BIN out of the suite.
    env: opts.env ?? {},
    connectTimeoutMs: opts.connectTimeoutMs ?? 2_000,
    killGraceMs: opts.killGraceMs ?? 50,
  });
  return { svc, spawn };
}

describe('RemoteControlService.start', () => {
  it('answers y on stdin, parses the claude.ai link, and lands running', async () => {
    const child = new FakeChild();
    const { svc, spawn } = service(child);
    const started = svc.start('/repo');
    // The confirm prompt is answered before any output arrives.
    expect(child.stdinWrites).toEqual(['y\n']);
    child.stdout.emit('data', Buffer.from(CONNECTED_OUTPUT));
    const status = await started;
    expect(status.state).toBe('running');
    expect(status.url).toBe('https://claude.ai/code?environment=env_01Test123');
    expect(status.startedAt).toBeTruthy();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(svc.status('/repo').state).toBe('running');
    svc.disposeAll();
  });

  it('spawns plain `claude remote-control` by default, worktree isolation on request', async () => {
    const plain = new FakeChild();
    const { svc: svc1, spawn: spawn1 } = service(plain);
    const p1 = svc1.start('/repo');
    plain.stdout.emit('data', Buffer.from(CONNECTED_OUTPUT));
    await p1;
    expect(spawn1.mock.calls[0]?.slice(0, 2)).toEqual(['claude', ['remote-control']]);
    svc1.disposeAll();

    const isolated = new FakeChild();
    const { svc: svc2, spawn: spawn2 } = service(isolated);
    const p2 = svc2.start('/repo', { worktrees: true });
    isolated.stdout.emit('data', Buffer.from(CONNECTED_OUTPUT));
    await p2;
    expect(spawn2.mock.calls[0]?.[1]).toEqual([
      'remote-control',
      '--spawn',
      'worktree',
      '--no-create-session-in-dir',
    ]);
    svc2.disposeAll();
  });

  it('CEZ_CLAUDE_BIN overrides the binary, and extraEnv rides on the child env', async () => {
    const child = new FakeChild();
    const { svc, spawn } = service(child, { env: { CEZ_CLAUDE_BIN: '/opt/claude' } });
    const started = svc.start('/repo', { extraEnv: { CLAUDE_CONFIG_DIR: '/accounts/work' } });
    child.stdout.emit('data', Buffer.from(CONNECTED_OUTPUT));
    await started;
    const [bin, , options] = spawn.mock.calls[0] as unknown as [string, string[], { cwd: string; env: NodeJS.ProcessEnv }];
    expect(bin).toBe('/opt/claude');
    expect(options.cwd).toBe('/repo');
    expect(options.env.CLAUDE_CONFIG_DIR).toBe('/accounts/work');
    svc.disposeAll();
  });

  it("surfaces the CLI's own refusal when it exits before connecting — trust included", async () => {
    const child = new FakeChild();
    const { svc } = service(child);
    const started = svc.start('/repo');
    child.stdout.emit('data', Buffer.from(TRUST_REFUSAL));
    child.exit(0);
    const status = await started;
    expect(status.state).toBe('error');
    expect(status.error).toContain('Workspace not trusted');
    // The failure stays visible for the cockpit until the next start.
    expect(svc.status('/repo').state).toBe('error');
  });

  it('kills and reports an error when the link never appears', async () => {
    const child = new FakeChild();
    const { svc } = service(child, { connectTimeoutMs: 20 });
    const status = await svc.start('/repo');
    expect(status.state).toBe('error');
    expect(status.error).toContain('timed out');
    expect(child.signals).toContain('SIGKILL');
  });

  it('reports a spawn failure (no claude CLI) as an error status, never a throw', async () => {
    const svc = new RemoteControlService({
      spawn: (() => {
        throw new Error('spawn claude ENOENT');
      }) as unknown as typeof nodeSpawn,
      env: {},
    });
    const status = await svc.start('/repo');
    expect(status.state).toBe('error');
    expect(status.error).toContain('ENOENT');
  });

  it('is idempotent while running — no second process', async () => {
    const child = new FakeChild();
    const { svc, spawn } = service(child);
    const started = svc.start('/repo');
    child.stdout.emit('data', Buffer.from(CONNECTED_OUTPUT));
    await started;
    const again = await svc.start('/repo');
    expect(again.state).toBe('running');
    expect(spawn).toHaveBeenCalledTimes(1);
    svc.disposeAll();
  });

  it('CEZ_DRY_RUN=1 fakes a running server with a placeholder link (no spawn)', async () => {
    const child = new FakeChild();
    const { svc, spawn } = service(child, { env: { CEZ_DRY_RUN: '1' } });
    const status = await svc.start('/repo');
    expect(status.state).toBe('running');
    expect(status.url).toContain('claude.ai/code?environment=');
    expect(spawn).not.toHaveBeenCalled();
    expect((await svc.stop('/repo')).state).toBe('stopped');
  });
});

describe('RemoteControlService — lifecycle after running', () => {
  it('an unexpected exit while running turns the status into an error', async () => {
    const child = new FakeChild();
    const { svc } = service(child);
    const started = svc.start('/repo');
    child.stdout.emit('data', Buffer.from(CONNECTED_OUTPUT));
    await started;
    child.exit(1);
    const status = svc.status('/repo');
    expect(status.state).toBe('error');
    expect(status.error).toBeTruthy();
  });

  it('stop() SIGINTs, waits for the exit, and clears the entry', async () => {
    const child = new FakeChild();
    const { svc } = service(child);
    const started = svc.start('/repo');
    child.stdout.emit('data', Buffer.from(CONNECTED_OUTPUT));
    await started;
    // The CLI honors Ctrl+C: first signal, prompt exit.
    const stopping = svc.stop('/repo');
    expect(child.signals).toContain('SIGINT');
    child.exit(0, 'SIGINT');
    expect((await stopping).state).toBe('stopped');
    expect(svc.status('/repo').state).toBe('stopped');
  });

  it('stop() escalates to SIGKILL when SIGINT is ignored', async () => {
    const child = new FakeChild();
    const { svc } = service(child, { killGraceMs: 10 });
    const started = svc.start('/repo');
    child.stdout.emit('data', Buffer.from(CONNECTED_OUTPUT));
    await started;
    const stopping = svc.stop('/repo');
    // Ignore SIGINT; exit only on the escalation.
    await vi.waitFor(() => {
      expect(child.signals).toContain('SIGKILL');
    });
    child.exit(null, 'SIGKILL');
    expect((await stopping).state).toBe('stopped');
  });

  it('stop() with nothing running answers stopped (and clears a sticky error)', async () => {
    const child = new FakeChild();
    const { svc } = service(child);
    const started = svc.start('/repo');
    child.stdout.emit('data', Buffer.from(TRUST_REFUSAL));
    child.exit(0);
    await started;
    expect(svc.status('/repo').state).toBe('error');
    expect((await svc.stop('/repo')).state).toBe('stopped');
    expect(svc.status('/repo').state).toBe('stopped');
  });

  it('dispose() kills without waiting and forgets the project', async () => {
    const child = new FakeChild();
    const { svc } = service(child);
    const started = svc.start('/repo');
    child.stdout.emit('data', Buffer.from(CONNECTED_OUTPUT));
    await started;
    svc.dispose('/repo');
    expect(child.signals).toContain('SIGTERM');
    expect(svc.status('/repo').state).toBe('stopped');
  });

  it('the process-exit kill hook is removed once the child is gone (no listener leak)', async () => {
    const before = process.listenerCount('exit');
    const child = new FakeChild();
    const { svc } = service(child);
    const started = svc.start('/repo');
    child.stdout.emit('data', Buffer.from(CONNECTED_OUTPUT));
    await started;
    expect(process.listenerCount('exit')).toBe(before + 1);
    const stopping = svc.stop('/repo');
    child.exit(0, 'SIGINT');
    await stopping;
    expect(process.listenerCount('exit')).toBe(before);
  });
});

describe('exitReason / stripAnsi', () => {
  it('prefers the Error: line over trailing UI furniture', () => {
    const reason = exitReason(`${TRUST_REFUSAL}\nsome redraw noise\n`, 0);
    expect(reason).toContain('Error: Workspace not trusted');
    expect(reason).toContain('exited with code 0');
  });

  it('falls back to the last non-empty line, then to a bare exit note', () => {
    expect(exitReason('something went wrong\n', 1)).toContain('something went wrong');
    expect(exitReason('', 1)).toBe('claude remote-control exited with code 1');
    expect(exitReason('', null)).toBe('claude remote-control exited');
  });

  it('strips CSI redraws and OSC-8 hyperlink wrappers', () => {
    const wrapped = '\u001b[6A\u001b[Jplain \u001b]8;;https://x\u0007link\u001b]8;;\u0007 text';
    expect(stripAnsi(wrapped)).toBe('plain link text');
  });
});
