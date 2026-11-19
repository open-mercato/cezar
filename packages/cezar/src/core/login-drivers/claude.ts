import { delimiter } from 'node:path';
import { allowedVerificationUrl, findUrl, runLoginCli } from './process.ts';
import type { BrowserShim, LoginChild, StartDriver } from './types.ts';

/** How long a local sign-in waits for the browser launch before offering the paste-code page. */
export const CLAUDE_SHIM_GRACE_MS = 3_000;
/** No sign-in URL at all by then: the CLI changed, use the terminal. */
export const URL_DEADLINE_MS = 30_000;
const SHIM_POLL_MS = 250;

/**
 * `claude auth login` (spec checks table): it prints "visit: <claude.com authorize URL>" whose
 * callback is the paste-code page, launches the browser with a localhost callback through `open`,
 * and reads "Paste code here if prompted >" from stdin. Local: the launch is captured by the PATH
 * shim and opened from the card (`browser`). Remote: the printed URL plus a pasted code (`paste`).
 */
export const startClaudeLogin: StartDriver = (ctl) => {
  let child: LoginChild | null = null;
  let shim: BrowserShim | null = null;
  let disposed = false;
  let mode: 'pending' | 'browser' | 'paste' = 'pending';
  let pasteUrl: string | undefined;
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const later = (ms: number, fn: () => void) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    timers.push(timer);
  };

  const offerPaste = () => {
    if (mode !== 'pending' || !pasteUrl || ctl.done()) return;
    mode = 'paste';
    ctl.update({ method: 'paste', phase: 'needs-input', url: pasteUrl });
  };

  void (async () => {
    // Remote too: the shim swallows the CLI's `open`, so no tab pops up on the unattended host.
    shim = await ctl.browserShim();
    if (disposed) {
      await shim?.dispose();
      return;
    }
    const extraEnv: Record<string, string> = shim
      ? { PATH: `${shim.dir}${delimiter}${ctl.env.PATH ?? process.env.PATH ?? ''}` }
      : {};
    child = runLoginCli(ctl, ['auth', 'login'], {
      extraEnv,
      onText: (text) => {
        if (pasteUrl) return;
        const visit = text.search(/visit:/i);
        if (visit < 0) return;
        const printed = findUrl(text.slice(visit), /^https:\/\//);
        const url = printed ? allowedVerificationUrl('claude', printed) : undefined;
        if (!url) return;
        pasteUrl = url;
        if (ctl.remote || !shim) offerPaste();
        else later(CLAUDE_SHIM_GRACE_MS, offerPaste);
      },
    });
    if (shim && !ctl.remote) {
      const poll = async () => {
        if (disposed || ctl.done() || mode !== 'pending' || !shim) return;
        for (const candidate of await shim.urls()) {
          const url = allowedVerificationUrl('claude', candidate);
          if (url) {
            mode = 'browser';
            ctl.update({ method: 'browser', phase: 'waiting', url });
            return;
          }
        }
        later(SHIM_POLL_MS, () => void poll());
      };
      void poll();
    }
    later(URL_DEADLINE_MS, () => {
      if (mode === 'pending' && !ctl.done()) ctl.fallbackToTerminal();
    });
  })();

  return {
    input: async (body) => {
      if (!('code' in body)) return { ok: false, status: 400, error: 'API keys are accepted only for Codex and OpenCode.' };
      if (mode !== 'paste' || !child) return { ok: false, status: 409, error: 'This sign-in is not waiting for a code.' };
      child.write(`${body.code.trim()}\n`);
      ctl.update({ phase: 'verifying' });
      return { ok: true };
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const timer of timers) clearTimeout(timer);
      child?.kill();
      void shim?.dispose();
    },
  };
};
