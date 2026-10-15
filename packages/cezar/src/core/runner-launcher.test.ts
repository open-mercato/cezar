import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { ProcessLauncher } from './process-launcher.ts';
import { backendSupportsLauncher, createRunner } from './runner-factory.ts';
import { CONTAINER_AGENTS, type ContainerAgentId } from './container-agents.ts';

/** A container launcher that records what it was asked to run and to signal. */
function fakeContainer(): { launcher: ProcessLauncher; spawned: string[]; signals: string[]; child: () => ChildProcessWithoutNullStreams } {
  const spawned: string[] = [];
  const signals: string[] = [];
  let last: ChildProcessWithoutNullStreams | undefined;
  const launcher: ProcessLauncher = {
    id: 'podman',
    describe: () => 'test container',
    spawn(bin) {
      spawned.push(bin);
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        pid: 4242,
        exitCode: null,
        signalCode: null,
        killed: false,
        kill: () => true,
      }) as unknown as ChildProcessWithoutNullStreams;
      last = child;
      return child;
    },
    async signal(_child, sig) {
      signals.push(sig);
    },
  };
  return { launcher, spawned, signals, child: () => last! };
}

describe('every runner in a task container', () => {
  const ids = Object.keys(CONTAINER_AGENTS) as ContainerAgentId[];

  it.each(ids)('%s may be isolated', (id) => {
    expect(backendSupportsLauncher(id)).toBe(true);
  });

  it.each(ids)('%s runs the image’s CLI and is stopped through the launcher', async (id) => {
    const fake = fakeContainer();
    const runner = createRunner(id, { launcher: fake.launcher });
    const session = runner.startSession!({ cwd: '/repo', userPrompt: 'hi', env: {} } as never, () => undefined, {});
    // Never a host path — `CEZ_<X>_BIN` and the dry-run mocks name files on THIS machine.
    expect(fake.spawned[0]).toBe(CONTAINER_AGENTS[id].bin);
    session.interrupt();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fake.signals.length).toBeGreaterThan(0);
    // Let the session settle so nothing outlives the case.
    const child = fake.child() as unknown as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
    child.stdout.end();
    child.stderr.end();
    child.emit('exit', 143, 'SIGTERM');
    child.emit('close', 143, 'SIGTERM');
    void session.result.catch(() => undefined);
  });
});
