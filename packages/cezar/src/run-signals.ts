import { constants as osConstants } from 'node:os';
import { killLiveChecks } from './workflows/check-step.ts';

/**
 * SIGINT/SIGTERM/SIGHUP handling for headless `cezar run`. Check steps live in their own process
 * group, out of reach of the terminal's Ctrl-C, so they are killed explicitly; and the run store
 * flushes its debounced `runs.json` write before exiting, or the last update is lost.
 */
export function installRunSignalHandlers(
  store: { flush: () => void },
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.once(signal, () => {
      killLiveChecks();
      store.flush();
      exit(128 + osConstants.signals[signal]);
    });
  }
}
