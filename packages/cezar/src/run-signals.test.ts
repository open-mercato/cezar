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
});
