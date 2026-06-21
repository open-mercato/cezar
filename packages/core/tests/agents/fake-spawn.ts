import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { SpawnFn } from '../../src/agents/claude-cli-runner.js';

export interface FakeSpawnRecord {
  command: string;
  args: readonly string[];
  cwd?: string;
}

/**
 * Build a fake `spawnFn` that feeds a canned set of stdout lines (NDJSON) to
 * the runner, then exits with `exitCode`. Records every spawn for assertions.
 *
 * - `error` → simulate `ENOENT` (binary not found) etc.
 * - `neverExits` → keep stdout open forever and never emit `exit`/`close`
 *   *until* the runner calls `child.kill()` (which then emits exit/close,
 *   modelling SIGTERM/SIGKILL actually reaping the process). Used to exercise
 *   the wall-clock timeout path.
 */
export function makeFakeSpawn(opts: {
  stdoutLines?: string[];
  stderr?: string;
  exitCode?: number;
  error?: NodeJS.ErrnoException;
  neverExits?: boolean;
}): { spawnFn: SpawnFn; calls: FakeSpawnRecord[] } {
  const calls: FakeSpawnRecord[] = [];

  const spawnFn: SpawnFn = (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd });

    const child = new EventEmitter() as EventEmitter & {
      stdout: Readable;
      stderr: Readable;
      stdin: { write: () => boolean; end: () => void };
      exitCode: number | null;
      killed: boolean;
      kill: (signal?: NodeJS.Signals | number) => boolean;
    };

    const lines = opts.stdoutLines ?? [];

    if (opts.neverExits) {
      // A stream that emits the canned lines (if any) then stays open.
      const pt = new PassThrough();
      child.stdout = pt;
      for (const l of lines) pt.write(`${l}\n`);
      // intentionally never `pt.end()`
    } else {
      child.stdout = Readable.from(
        (async function* () {
          for (const l of lines) yield `${l}\n`;
        })(),
      );
    }

    child.stderr = Readable.from(
      (async function* () {
        if (opts.stderr) yield opts.stderr;
      })(),
    );
    child.stdin = { write: () => true, end: () => {} };
    child.exitCode = null;
    child.killed = false;
    child.kill = (_signal?: NodeJS.Signals | number) => {
      child.killed = true;
      // Model the signal actually reaping the process.
      setImmediate(() => {
        if (child.exitCode == null) child.exitCode = null;
        child.emit('exit', null, _signal ?? 'SIGTERM');
        child.emit('close', null, _signal ?? 'SIGTERM');
      });
      return true;
    };

    if (opts.error) {
      // Mirror Node's async error delivery.
      setImmediate(() => child.emit('error', opts.error));
      return child as unknown as ChildProcessWithoutNullStreams;
    }

    if (!opts.neverExits) {
      // Emit close once stdout has been fully consumed by the runner.
      child.stdout.on('end', () => {
        setImmediate(() => {
          const code = opts.exitCode ?? 0;
          child.exitCode = code;
          child.emit('exit', code, null);
          child.emit('close', code, null);
        });
      });
    }

    return child as unknown as ChildProcessWithoutNullStreams;
  };

  return { spawnFn, calls };
}
