import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { discoverKiloModels, parseKiloModels, resolveKiloExecutable } from './kilo-model-catalog.ts';

/**
 * A stand-in for the `kilo models` child: write its stdout, then close with a code.
 *
 * Same shape as the opencode catalog test's fake — `kill()` records the signal
 * on *delivery* while the child stays alive until something makes it exit.
 */
function fakeChild(): {
  child: ChildProcessWithoutNullStreams;
  say(text: string): void;
  close(code: number): void;
  signals: NodeJS.Signals[];
} {
  const process = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const signals: NodeJS.Signals[] = [];
  Object.assign(process, {
    stdin,
    stdout,
    stderr,
    exitCode: null,
    signalCode: null,
    killed: false,
    kill: (signal: NodeJS.Signals = 'SIGTERM') => {
      signals.push(signal);
      Object.assign(process, { killed: true });
      return true;
    },
    pid: 321,
  });
  return {
    child: process as unknown as ChildProcessWithoutNullStreams,
    say: (text: string) => stdout.write(text),
    close(code: number) {
      Object.assign(process, { exitCode: code });
      process.emit('exit', code, null);
      stdout.end();
      queueMicrotask(() => process.emit('close', code));
    },
    signals,
  };
}

/** Run discovery against a scripted child; `script` drives it once stdout is wired up. */
function discover(
  script: (fake: ReturnType<typeof fakeChild>) => void,
  options: { timeoutMs?: number } = {},
): Promise<Array<{ id: string; label: string; description: string }>> {
  const fake = fakeChild();
  const promise = discoverKiloModels({ cwd: '/repo', spawn: () => fake.child, ...options });
  queueMicrotask(() => script(fake));
  return promise;
}

const LISTING = [
  'kilo/kilo-auto',
  'anthropic/claude-sonnet-5',
  'openai/gpt-5.4',
].join('\n');

describe('discoverKiloModels', () => {
  it('lists what the host CLI printed, in its own order', async () => {
    await expect(
      discover((fake) => {
        fake.say(`${LISTING}\n`);
        fake.close(0);
      }),
    ).resolves.toEqual([
      { id: 'kilo/kilo-auto', label: 'kilo/kilo-auto', description: 'via kilo' },
      { id: 'anthropic/claude-sonnet-5', label: 'anthropic/claude-sonnet-5', description: 'via anthropic' },
      { id: 'openai/gpt-5.4', label: 'openai/gpt-5.4', description: 'via openai' },
    ]);
  });

  it('passes the runner binary override through', async () => {
    const fake = fakeChild();
    let spawned: { bin: string; args: readonly string[]; cwd: string } | undefined;
    const promise = discoverKiloModels({
      cwd: '/repo',
      bin: '/opt/kilo',
      spawn: (bin, args, cwd) => {
        spawned = { bin, args, cwd };
        return fake.child;
      },
    });
    queueMicrotask(() => {
      fake.say('openai/gpt-5.4\n');
      fake.close(0);
    });
    await promise;
    expect(spawned).toEqual({ bin: '/opt/kilo', args: ['models'], cwd: '/repo' });
  });

  it('treats an empty listing as "no models configured", not a failure', async () => {
    await expect(
      discover((fake) => {
        fake.say('\n  \n');
        fake.close(0);
      }),
    ).resolves.toEqual([]);
  });

  it('rejects output with lines but no recognizable model id', async () => {
    await expect(
      discover((fake) => {
        fake.say('Kilo Code v7.7.9\nrun `kilo auth login` first\n');
        fake.close(0);
      }),
    ).rejects.toThrow('unrecognized output');
  });

  it('honours CEZ_KILO_BIN like the runner and the backend probe', () => {
    process.env.CEZ_KILO_BIN = '/tools/kilo custom';
    try {
      expect(resolveKiloExecutable()).toBe('/tools/kilo custom');
    } finally {
      delete process.env.CEZ_KILO_BIN;
    }
    expect(resolveKiloExecutable()).toBe('kilo');
  });
});

describe('parseKiloModels', () => {
  it('dedupes repeat ids while keeping first-seen order', () => {
    expect(parseKiloModels('a/b\na/b\nc/d\n')).toEqual([
      { id: 'a/b', label: 'a/b', description: 'via a' },
      { id: 'c/d', label: 'c/d', description: 'via c' },
    ]);
  });
});
