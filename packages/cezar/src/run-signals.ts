import { constants as osConstants } from 'node:os';
import { killLiveChecks } from './workflows/check-step.ts';

/**
 * SIGINT/SIGTERM/SIGHUP handling for headless `cezar run`. Check steps live in their own process
 * group, out of reach of the terminal's Ctrl-C, so they are killed explicitly; and the run store
 * flushes its debounced `runs.json` write before exiting, or the last update is lost. `drain`
 * (owned worktree lifecycle scripts) finishes before the exit; a second signal exits at once without
 * waiting for it. Returns the uninstaller.
 */
export function installRunSignalHandlers(
  store: { flush: () => void },
  exit: (code: number) => void = (code) => process.exit(code),
  drain?: () => Promise<void>,
): () => void {
  let shuttingDown = false;
  const handlers = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((signal) => {
    const handler = () => {
      const code = 128 + osConstants.signals[signal];
      if (shuttingDown) {
        exit(code);
        return;
      }
      shuttingDown = true;
      killLiveChecks();
      store.flush();
      if (!drain) {
        exit(code);
        return;
      }
      void drain().then(() => exit(code)).catch((error: unknown) => {
        console.error('cezar: lifecycle shutdown failed', error);
        exit(1);
      });
    };
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
}
