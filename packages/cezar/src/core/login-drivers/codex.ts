import { delimiter } from 'node:path';
import { URL_DEADLINE_MS } from './claude.ts';
import { allowedVerificationUrl, findDeviceCode, findUrl, runLoginCli } from './process.ts';
import type { BrowserShim, LoginChild, StartDriver } from './types.ts';

/** "expires in 15 minutes" (spec checks table). */
export const CODEX_DEVICE_TTL_MS = 15 * 60_000;
const SHIM_POLL_MS = 250;

/**
 * Codex (spec checks table): `codex login` prints its authorize URL on stderr and opens a browser
 * with a localhost:1455 callback (local); `codex login --device-auth` prints
 * https://auth.openai.com/codex/device and a code (remote); `--with-api-key` reads stdin (`key`).
 */
export const startCodexLogin: StartDriver = (ctl) => {
  let child: LoginChild | null = null;
  let shim: BrowserShim | null = null;
  let disposed = false;
  let shown = false;
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const later = (ms: number, fn: () => void) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    timers.push(timer);
  };
  const deadline = () => later(URL_DEADLINE_MS, () => {
    if (!shown && !ctl.done()) ctl.fallbackToTerminal();
  });

  if (ctl.method === 'key') {
    ctl.update({ method: 'key', phase: 'needs-input' });
  } else if (ctl.remote || ctl.method === 'device') {
    child = runLoginCli(ctl, ['login', '--device-auth'], {
      onText: (text) => {
        if (shown) return;
        const printed = findUrl(text, /^https:\/\/auth\.openai\.com\/codex\/device/);
        const url = printed ? allowedVerificationUrl('codex', printed) : undefined;
        const userCode = findDeviceCode(text);
        if (!url || !userCode) return;
        shown = true;
        ctl.update({ method: 'device', phase: 'waiting', url, userCode, expiresAt: new Date(ctl.now() + CODEX_DEVICE_TTL_MS).toISOString() });
      },
    });
    deadline();
  } else {
    void (async () => {
      shim = await ctl.browserShim();
      if (disposed) {
        await shim?.dispose();
        return;
      }
      const show = (candidate: string | undefined) => {
        const url = candidate ? allowedVerificationUrl('codex', candidate) : undefined;
        if (!url || shown || ctl.done()) return;
        shown = true;
        ctl.update({ method: 'browser', phase: 'waiting', url });
      };
      child = runLoginCli(ctl, ['login'], {
        extraEnv: shim ? { PATH: `${shim.dir}${delimiter}${ctl.env.PATH ?? process.env.PATH ?? ''}` } : {},
        onText: (text) => show(findUrl(text, /^https:\/\/auth\.openai\.com\//)),
      });
      if (shim) {
        const poll = async () => {
          if (disposed || shown || ctl.done() || !shim) return;
          for (const candidate of await shim.urls()) show(candidate);
          later(SHIM_POLL_MS, () => void poll());
        };
        void poll();
      }
      deadline();
    })();
  }

  return {
    input: async (body) => {
      if (ctl.method !== 'key') {
        return { ok: false, status: 409, error: 'This sign-in is not waiting for a key.' };
      }
      if (!('apiKey' in body)) return { ok: false, status: 409, error: 'This sign-in is waiting for an API key.' };
      if (child) return { ok: false, status: 409, error: 'The key was already sent.' };
      child = runLoginCli(ctl, ['login', '--with-api-key']);
      if (!child) return { ok: true };
      child.write(`${body.apiKey.trim()}\n`);
      child.closeStdin();
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
