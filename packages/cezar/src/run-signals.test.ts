import { constants as osConstants } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installRunSignalHandlers } from './run-signals.ts';

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

describe('installRunSignalHandlers', () => {
  afterEach(() => {
    for (const signal of SIGNALS) process.removeAllListeners(signal);
  });

  it.each(SIGNALS)('flushes the debounced run store before exiting on %s', (signal) => {
    const flush = vi.fn();
    const exit = vi.fn();
    installRunSignalHandlers({ flush }, exit);
    process.emit(signal);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(128 + osConstants.signals[signal]);
  });

  it('exits only after the lifecycle drain settles', async () => {
    const flush = vi.fn();
    const exit = vi.fn();
    let release!: () => void;
    const drain = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    installRunSignalHandlers({ flush }, exit, drain);
    process.emit('SIGINT');
    expect(flush).toHaveBeenCalledTimes(1);
    expect(drain).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(128 + osConstants.signals.SIGINT));
  });

  it.each(SIGNALS)('force-exits on a second %s without waiting for the drain', (signal) => {
    const flush = vi.fn();
    const exit = vi.fn();
    const drain = vi.fn(() => new Promise<void>(() => {}));
    installRunSignalHandlers({ flush }, exit, drain);
    process.emit('SIGINT');
    expect(exit).not.toHaveBeenCalled();
    process.emit(signal);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(128 + osConstants.signals[signal]);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it('exits with the drain failure code when the drain rejects', async () => {
    const exit = vi.fn();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    installRunSignalHandlers({ flush: vi.fn() }, exit, () => Promise.reject(new Error('boom')));
    process.emit('SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    error.mockRestore();
  });

  it('stops handling signals once uninstalled', () => {
    const before = SIGNALS.map((signal) => process.listenerCount(signal));
    const uninstall = installRunSignalHandlers({ flush: vi.fn() }, vi.fn());
    uninstall();
    expect(SIGNALS.map((signal) => process.listenerCount(signal))).toEqual(before);
  });
});
