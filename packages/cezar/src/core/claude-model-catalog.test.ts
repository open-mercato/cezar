import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { discoverClaudeModels, KILL_GRACE_MS, TERM_GRACE_MS } from './claude-model-catalog.ts';

/**
 * A stand-in for the CLI's stream-json channel: it records the control requests written to stdin
 * and replays a scripted stdout transcript, so every branch below is exercised against the wire
 * shape rather than against a mocked adapter.
 */
function fakeChild(): {
  child: ChildProcessWithoutNullStreams;
  requests: Array<Record<string, unknown>>;
  killed: string[];
  write(...lines: unknown[]): void;
  writeRaw(line: string): void;
  endStdout(): void;
  emitExit(code: number): void;
} {
  const proc = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const requests: Array<Record<string, unknown>> = [];
  const killed: string[] = [];
  let buffered = '';
  stdin.setEncoding('utf8');
  stdin.on('data', (chunk: string) => {
    buffered += chunk;
    let newline: number;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line) requests.push(JSON.parse(line) as Record<string, unknown>);
    }
  });
  Object.assign(proc, {
    stdin,
    stdout,
    stderr,
    exitCode: null,
    signalCode: null,
    killed: false,
    // Mirrors Node: `killed` flips as soon as the signal is delivered, whether or not the child
    // reacts to it. A child that installs an empty SIGTERM handler stays alive with `killed` true.
    kill: (signal: string) => {
      killed.push(signal);
      Object.assign(proc, { killed: true });
      return true;
    },
    pid: 4242,
  });
  return {
    child: proc as unknown as ChildProcessWithoutNullStreams,
    requests,
    killed,
    write(...lines: unknown[]) {
      for (const line of lines) stdout.write(`${JSON.stringify(line)}\n`);
    },
    writeRaw(line: string) {
      stdout.write(`${line}\n`);
    },
    endStdout() {
      stdout.end();
    },
    emitExit(code: number) {
      Object.assign(proc, { exitCode: code });
      proc.emit('exit', code);
      stdout.end();
    },
  };
}

const answer = (models: unknown[], requestId = 'cez-list-models-1') => ({
  type: 'control_response',
  response: { subtype: 'success', request_id: requestId, response: { models } },
});

/** Noise the real CLI interleaves with control traffic. */
const CHATTER = [
  { type: 'system', subtype: 'hook_started', hook_name: 'SessionStart:startup' },
  { type: 'system', subtype: 'init', model: 'claude-opus-5' },
];

function run(script: (fake: ReturnType<typeof fakeChild>) => void, timeoutMs = 1_000) {
  const fake = fakeChild();
  const promise = discoverClaudeModels({
    cwd: '/repo',
    timeoutMs,
    spawn: () => fake.child,
  });
  queueMicrotask(() => script(fake));
  return { fake, promise };
}

describe('discoverClaudeModels', () => {
  it('asks the CLI for its catalog and preserves the answer order', async () => {
    const { fake, promise } = run((f) =>
      f.write(...CHATTER, answer([
        { value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]', displayName: 'Opus (1M context)', description: 'Opus 5 with 1M context' },
        { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: 'Sonnet 5 · Efficient' },
        { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku' },
      ])),
    );

    await expect(promise).resolves.toEqual([
      { id: 'opus[1m]', label: 'Opus (1M context)', description: 'Opus 5 with 1M context' },
      { id: 'sonnet', label: 'Sonnet', description: 'Sonnet 5 · Efficient' },
      { id: 'haiku', label: 'Haiku', description: '' },
    ]);
    expect(fake.requests).toEqual([
      { type: 'control_request', request_id: 'cez-list-models-1', request: { subtype: 'list_models' } },
    ]);
  });

  it('drops the CLI\'s own "default" row, which cezar already spells `auto`', async () => {
    const { promise } = run((f) =>
      f.write(answer([
        { value: 'default', displayName: 'Default (recommended)' },
        { value: 'opus', displayName: 'Opus' },
      ])),
    );
    await expect(promise).resolves.toEqual([{ id: 'opus', label: 'Opus', description: '' }]);
  });

  it('falls back to the id when a row has no display name, and skips blanks and duplicates', async () => {
    const { promise } = run((f) =>
      f.write(answer([
        { value: '  ' },
        { value: 'sonnet' },
        { value: 'sonnet', displayName: 'Sonnet again' },
        { value: ' opus ', displayName: '   ' },
      ])),
    );
    await expect(promise).resolves.toEqual([
      { id: 'sonnet', label: 'sonnet', description: '' },
      { id: 'opus', label: 'opus', description: '' },
    ]);
  });

  it('ignores a control response answering someone else\'s request', async () => {
    const { promise } = run((f) => {
      f.write(
        { type: 'control_response', response: { subtype: 'success', request_id: 'other', response: { models: [] } } },
        answer([{ value: 'opus' }]),
      );
    });
    await expect(promise).resolves.toEqual([{ id: 'opus', label: 'opus', description: '' }]);
  });

  it('reports a CLI that does not know the request as unavailable', async () => {
    const { promise } = run((f) =>
      f.write({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: 'cez-list-models-1',
          error: 'Unsupported control request subtype: list_models',
        },
      }),
    );
    await expect(promise).rejects.toThrow('unsupported by this CLI');
  });

  it('rejects a malformed payload rather than reporting an empty catalog', async () => {
    const { promise } = run((f) => f.write(answer([{ id: 'opus' }] as unknown[])));
    await expect(promise).rejects.toThrow('malformed model data');
  });

  it('rejects an answer with lines but nothing usable', async () => {
    const { promise } = run((f) => f.write(answer([{ value: 'default' }])));
    await expect(promise).rejects.toThrow('no usable models');
  });

  it('rejects malformed NDJSON', async () => {
    const { promise } = run((f) => f.writeRaw('{ not json'));
    await expect(promise).rejects.toThrow('malformed NDJSON');
  });

  it('rejects when the CLI closes stdout without answering', async () => {
    const { promise } = run((f) => {
      f.write(...CHATTER);
      f.endStdout();
    });
    await expect(promise).rejects.toThrow('ended without an answer');
  });

  it('rejects when the child exits — a missing or broken binary', async () => {
    const { promise } = run((f) => f.emitExit(1));
    await expect(promise).rejects.toThrow('child exited (1)');
  });

  it('rejects a catalog past the size cap instead of flooding the picker', async () => {
    const flood = Array.from({ length: 250 }, (_, i) => ({ value: `model-${i}` }));
    const { promise } = run((f) => f.write(answer(flood)));
    await expect(promise).rejects.toThrow('exceeded the size limit');
  });

  it('gives up on a CLI that never answers, and terminates it', async () => {
    const { fake, promise } = run((f) => f.write(...CHATTER), 20);
    await expect(promise).rejects.toThrow('timed out');
    // stdin is closed on every exit path; TERM/KILL escalate on their own timers afterwards.
    expect(fake.child.stdin.writableEnded).toBe(true);
  });

  it('escalates to SIGKILL for a probe that ignores SIGTERM and stays alive', async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeChild();
      const promise = discoverClaudeModels({ cwd: '/repo', timeoutMs: 20, spawn: () => fake.child });
      const settled = expect(promise).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(20);
      await settled;

      await vi.advanceTimersByTimeAsync(TERM_GRACE_MS);
      expect(fake.killed).toEqual(['SIGTERM']);
      // Node has already flagged the child as killed even though it never died — the escalation
      // must not read that as "gone", or a wedged probe outlives every discovery.
      expect(fake.child.killed).toBe(true);
      expect(fake.child.exitCode).toBeNull();

      await vi.advanceTimersByTimeAsync(KILL_GRACE_MS);
      expect(fake.killed).toEqual(['SIGTERM', 'SIGKILL']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops escalating once the child actually exits', async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeChild();
      const promise = discoverClaudeModels({ cwd: '/repo', timeoutMs: 20, spawn: () => fake.child });
      const settled = expect(promise).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(20);
      await settled;

      await vi.advanceTimersByTimeAsync(TERM_GRACE_MS);
      expect(fake.killed).toEqual(['SIGTERM']);
      fake.emitExit(143);

      await vi.advanceTimersByTimeAsync(KILL_GRACE_MS);
      expect(fake.killed).toEqual(['SIGTERM']);
    } finally {
      vi.useRealTimers();
    }
  });
});
