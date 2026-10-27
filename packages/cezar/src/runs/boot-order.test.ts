import { describe, expect, it, vi } from 'vitest';
import { bootInOrder } from './startup-sweep.ts';

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('bootInOrder', () => {
  it('recovers before the listener exists and sweeps only after it', async () => {
    const order: string[] = [];
    const recovery = deferred();
    const booting = bootInOrder({
      recover: async () => {
        order.push('recover:start');
        await recovery.promise;
        order.push('recover:end');
      },
      serve: async () => {
        order.push('serve');
        return { listening: Promise.resolve() };
      },
      sweep: async () => {
        order.push('sweep');
      },
      startLifecycle: () => order.push('lifecycle'),
      stopping: () => false,
    });
    await settle();
    expect(order).toEqual(['recover:start']);
    recovery.resolve();
    await booting;
    await vi.waitFor(() => expect(order).toContain('lifecycle'));
    expect(order).toEqual(['recover:start', 'recover:end', 'serve', 'sweep', 'lifecycle']);
  });

  it('never makes the listener wait for the sweep', async () => {
    const sweep = deferred();
    const { served } = await bootInOrder({
      recover: async () => {},
      serve: async () => ({ listening: Promise.resolve(), url: 'http://localhost:1' }),
      sweep: () => sweep.promise,
      startLifecycle: () => {},
      stopping: () => false,
    });
    expect(served.url).toBe('http://localhost:1');
    sweep.resolve();
  });

  it('starts the lifecycle coordinator only after the sweep settles', async () => {
    const sweep = deferred();
    const startLifecycle = vi.fn();
    await bootInOrder({
      recover: async () => {},
      serve: async () => ({ listening: Promise.resolve() }),
      sweep: () => sweep.promise,
      startLifecycle,
      stopping: () => false,
    });
    await settle();
    expect(startLifecycle).not.toHaveBeenCalled();
    sweep.resolve();
    await vi.waitFor(() => expect(startLifecycle).toHaveBeenCalledOnce());
  });

  it('still starts the lifecycle coordinator when the sweep rejects or throws', async () => {
    const sweep = deferred();
    const afterReject = vi.fn();
    const rejected = await bootInOrder({
      recover: async () => {},
      serve: async () => ({ listening: Promise.resolve() }),
      sweep: () => sweep.promise,
      startLifecycle: afterReject,
      stopping: () => false,
    });
    sweep.reject(new Error('sweep failed'));
    await expect(rejected.sweep).resolves.toBeUndefined();
    await vi.waitFor(() => expect(afterReject).toHaveBeenCalledOnce());

    const afterThrow = vi.fn();
    await bootInOrder({
      recover: async () => {},
      serve: async () => ({ listening: Promise.resolve() }),
      sweep: () => {
        throw new Error('sweep threw');
      },
      startLifecycle: afterThrow,
      stopping: () => false,
    });
    await vi.waitFor(() => expect(afterThrow).toHaveBeenCalledOnce());
  });

  it('waits for the listener before starting the lifecycle coordinator', async () => {
    const listening = deferred();
    const startLifecycle = vi.fn();
    await bootInOrder({
      recover: async () => {},
      serve: async () => ({ listening: listening.promise }),
      sweep: async () => {},
      startLifecycle,
      stopping: () => false,
    });
    await settle();
    expect(startLifecycle).not.toHaveBeenCalled();
    listening.resolve();
    await vi.waitFor(() => expect(startLifecycle).toHaveBeenCalledOnce());
  });

  it('neither sweeps nor starts the coordinator once shutdown began', async () => {
    const sweep = vi.fn(async () => {});
    const startLifecycle = vi.fn();
    let stopping = false;
    const before = await bootInOrder({
      recover: async () => {},
      serve: async () => {
        stopping = true;
        return { listening: Promise.resolve() };
      },
      sweep,
      startLifecycle,
      stopping: () => stopping,
    });
    expect(before.sweep).toBeUndefined();

    stopping = false;
    const pending = deferred();
    await bootInOrder({
      recover: async () => {},
      serve: async () => ({ listening: Promise.resolve() }),
      sweep: () => pending.promise,
      startLifecycle,
      stopping: () => stopping,
    });
    stopping = true;
    pending.resolve();
    await settle();
    await settle();
    expect(sweep).not.toHaveBeenCalled();
    expect(startLifecycle).not.toHaveBeenCalled();
  });
});
