import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCliRunner } from './claude-cli-runner.ts';
import { CopilotAcpRunner } from './copilot-acp-runner.ts';
import { discoverOpencodeModels } from './opencode-model-catalog.ts';
import { PiRunner } from './pi-runner.ts';

/**
 * Telemetry acfb01e4's crash class: a write to (or `end()` of) a child's stdin after the child
 * exited reports EPIPE as an async 'error' on the stream. With no listener, Node throws it as an
 * uncaught exception and the whole server dies. Every child-stdin writer must listen.
 */
const spawned = vi.hoisted(() => ({ children: [] as unknown[] }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null,
      killed: false,
      pid: 4242,
      kill: () => true,
    });
    spawned.children.push(child);
    return child;
  } };
});

function lastChild(): ChildProcessWithoutNullStreams {
  return spawned.children.at(-1) as ChildProcessWithoutNullStreams;
}

function epipe(): NodeJS.ErrnoException {
  return Object.assign(new Error('write EPIPE'), { code: 'EPIPE', errno: -32, syscall: 'write' });
}

function settle(child: ChildProcessWithoutNullStreams): void {
  Object.assign(child, { exitCode: 0 });
  (child.stdout as unknown as PassThrough).end();
  (child.stderr as unknown as PassThrough).end();
  child.emit('exit', 0, null);
  child.emit('close', 0, null);
}

afterEach(() => {
  for (const child of spawned.children) settle(child as ChildProcessWithoutNullStreams);
  spawned.children.length = 0;
});

describe('an EPIPE on a child stdin never escapes as an uncaught error (acfb01e4)', () => {
  const spec = { userPrompt: 'do it', cwd: process.cwd() };

  it('claude runner', () => {
    const session = new ClaudeCliRunner({ bin: 'claude', timeoutMs: 0 }).startSession(spec);
    void session.result.catch(() => undefined);
    expect(() => lastChild().stdin.emit('error', epipe())).not.toThrow();
  });

  it('pi runner', () => {
    const session = new PiRunner({ bin: 'pi', timeoutMs: 0 }).startSession(spec);
    void session.result.catch(() => undefined);
    expect(() => lastChild().stdin.emit('error', epipe())).not.toThrow();
  });

  it('copilot runner', () => {
    const session = new CopilotAcpRunner({ bin: 'copilot', timeoutMs: 0 }).startSession(spec);
    void session.result.catch(() => undefined);
    expect(() => lastChild().stdin.emit('error', epipe())).not.toThrow();
  });

  it('opencode model discovery', async () => {
    const models = discoverOpencodeModels({ cwd: process.cwd(), bin: 'opencode', timeoutMs: 5_000 });
    const child = lastChild();
    expect(() => child.stdin.emit('error', epipe())).not.toThrow();
    settle(child);
    await expect(models).resolves.toEqual([]);
  });
});
