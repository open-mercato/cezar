import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { discoverOpencodeModels, parseOpencodeModels } from './opencode-model-catalog.ts';

/** A stand-in for the `opencode models` child: write its stdout, then close with a code. */
function fakeChild(): {
  child: ChildProcessWithoutNullStreams;
  say(text: string): void;
  close(code: number): void;
  killed(): boolean;
} {
  const process = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let killed = false;
  Object.assign(process, {
    stdin,
    stdout,
    stderr,
    exitCode: null,
    killed: false,
    kill: () => {
      killed = true;
      return true;
    },
    pid: 321,
  });
  return {
    child: process as unknown as ChildProcessWithoutNullStreams,
    say: (text: string) => stdout.write(text),
    close(code: number) {
      Object.assign(process, { exitCode: code });
      stdout.end();
      queueMicrotask(() => process.emit('close', code));
    },
    killed: () => killed,
  };
}

/** Run discovery against a scripted child; `script` drives it once stdout is wired up. */
function discover(
  script: (fake: ReturnType<typeof fakeChild>) => void,
  options: { timeoutMs?: number } = {},
): Promise<Array<{ id: string; label: string; description: string }>> {
  const fake = fakeChild();
  const promise = discoverOpencodeModels({ cwd: '/repo', spawn: () => fake.child, ...options });
  queueMicrotask(() => script(fake));
  return promise;
}

const LISTING = [
  'anthropic/claude-sonnet-5',
  'openai/gpt-5.3-codex-spark',
  'openai/gpt-5.4',
  'openai/gpt-5.5-fast',
].join('\n');

describe('discoverOpencodeModels', () => {
  it('lists what the host CLI printed, in its own order', async () => {
    await expect(
      discover((fake) => {
        fake.say(`${LISTING}\n`);
        fake.close(0);
      }),
    ).resolves.toEqual([
      { id: 'anthropic/claude-sonnet-5', label: 'anthropic/claude-sonnet-5', description: 'via anthropic' },
      { id: 'openai/gpt-5.3-codex-spark', label: 'openai/gpt-5.3-codex-spark', description: 'via openai' },
      { id: 'openai/gpt-5.4', label: 'openai/gpt-5.4', description: 'via openai' },
      { id: 'openai/gpt-5.5-fast', label: 'openai/gpt-5.5-fast', description: 'via openai' },
    ]);
  });

  it('passes the runner binary override through', async () => {
    const fake = fakeChild();
    let spawned: { bin: string; args: readonly string[]; cwd: string } | undefined;
    const promise = discoverOpencodeModels({
      cwd: '/repo',
      bin: '/opt/opencode',
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
    expect(spawned).toEqual({ bin: '/opt/opencode', args: ['models'], cwd: '/repo' });
  });

  it('treats an empty listing as "no models configured", not a failure', async () => {
    await expect(
      discover((fake) => {
        fake.say('\n  \n');
        fake.close(0);
      }),
    ).resolves.toEqual([]);
  });

  it('rejects output it cannot recognize rather than inventing entries', async () => {
    await expect(
      discover((fake) => {
        fake.say('No providers configured. Run `opencode auth login`.\n');
        fake.close(0);
      }),
    ).rejects.toThrow('unrecognized output');
  });

  it('fails when the CLI exits non-zero', async () => {
    await expect(
      discover((fake) => {
        fake.close(1);
      }),
    ).rejects.toThrow('exited (1)');
  });

  it('fails and kills the child when discovery outruns its deadline', async () => {
    const fake = fakeChild();
    const promise = discoverOpencodeModels({ cwd: '/repo', timeoutMs: 5, spawn: () => fake.child });
    await expect(promise).rejects.toThrow('timed out');
    expect(fake.killed()).toBe(true);
  });

  it('fails when the child floods stdout', async () => {
    await expect(
      discover((fake) => {
        fake.say(`${'openai/gpt-5.4\n'.repeat(60_000)}`);
      }),
    ).rejects.toThrow('output limit');
  });
});

describe('parseOpencodeModels', () => {
  it('drops duplicates, blank lines and anything that is not a provider/model id', () => {
    expect(
      parseOpencodeModels(
        ['openai/gpt-5.4', '', 'gpt-5.4', 'openai/gpt-5.4', '  openai/gpt-5.4-mini  ', 'Providers:'].join('\n'),
      ),
    ).toEqual([
      { id: 'openai/gpt-5.4', label: 'openai/gpt-5.4', description: 'via openai' },
      { id: 'openai/gpt-5.4-mini', label: 'openai/gpt-5.4-mini', description: 'via openai' },
    ]);
  });

  it('reads a colorized listing', () => {
    expect(parseOpencodeModels('\u001B[32mopenai/gpt-5.4\u001B[0m\n')).toEqual([
      { id: 'openai/gpt-5.4', label: 'openai/gpt-5.4', description: 'via openai' },
    ]);
  });

  it('keeps namespaced provider ids such as `github-copilot/gpt-5.4`', () => {
    expect(parseOpencodeModels('github-copilot/gpt-5.4\nopenrouter/anthropic/claude-sonnet-5\n')).toEqual([
      { id: 'github-copilot/gpt-5.4', label: 'github-copilot/gpt-5.4', description: 'via github-copilot' },
      {
        id: 'openrouter/anthropic/claude-sonnet-5',
        label: 'openrouter/anthropic/claude-sonnet-5',
        description: 'via openrouter',
      },
    ]);
  });

  it('refuses a listing longer than the size cap', () => {
    const flood = Array.from({ length: 501 }, (_, i) => `openai/gpt-${i}`).join('\n');
    expect(() => parseOpencodeModels(flood)).toThrow('size limit');
  });
});
