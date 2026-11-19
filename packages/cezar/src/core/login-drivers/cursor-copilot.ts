import { URL_DEADLINE_MS } from './claude.ts';
import { allowedVerificationUrl, findDeviceCode, findUrl, runLoginCli } from './process.ts';
import type { LoginChild, LoginSessionPatch, StartDriver } from './types.ts';

/** GitHub's device codes live 15 minutes. */
export const COPILOT_DEVICE_TTL_MS = 15 * 60_000;

/** Shared shape: spawn, wait for something to show, else hand over to the terminal. */
const startPrintedLogin = (
  args: readonly string[],
  extraEnv: Record<string, string>,
  parse: (text: string) => LoginSessionPatch | undefined,
): StartDriver => (ctl) => {
  let shown = false;
  const child: LoginChild | null = runLoginCli(ctl, args, {
    extraEnv,
    // Gone before it showed anything (a newer CLI, an unexpected prompt): the terminal still works.
    onExit: (code) => {
      if (shown || code === 0) return false;
      ctl.fallbackToTerminal();
      return true;
    },
    onText: (text) => {
      if (shown || ctl.done()) return;
      const patch = parse(text);
      if (!patch) return;
      shown = true;
      ctl.update(patch);
    },
  });
  const timer = setTimeout(() => {
    if (!shown && !ctl.done()) ctl.fallbackToTerminal();
  }, URL_DEADLINE_MS);
  timer.unref?.();
  return {
    input: async () => ({ ok: false, status: 409, error: 'This sign-in does not take a code here.' }),
    dispose: () => {
      clearTimeout(timer);
      child?.kill();
    },
  };
};

/**
 * Cursor (spec checks table): with `NO_OPEN_BROWSER=1`, `agent login` prints
 * https://cursor.com/loginDeepControl?… and polls Cursor itself, so the link works from any device.
 */
export const startCursorLogin: StartDriver = startPrintedLogin(['login'], { NO_OPEN_BROWSER: '1' }, (text) => {
  const printed = findUrl(text, /^https:\/\/(?:www\.)?cursor\.com\//);
  const url = printed ? allowedVerificationUrl('cursor', printed) : undefined;
  return url ? { method: 'link', phase: 'waiting', url } : undefined;
});

/**
 * Copilot: `copilot login` runs GitHub's device flow (github.com/login/device plus a code). Not
 * verified on a machine (spec checks table), so anything unparsable falls back to the terminal.
 */
export const startCopilotLogin: StartDriver = (ctl) => startPrintedLogin(['login'], {}, (text) => {
  const printed = findUrl(text, /^https:\/\/github\.com\/login\/device/);
  const url = printed ? allowedVerificationUrl('copilot', printed) : undefined;
  const userCode = findDeviceCode(text);
  return url && userCode
    ? { method: 'device', phase: 'waiting', url, userCode, expiresAt: new Date(ctl.now() + COPILOT_DEVICE_TTL_MS).toISOString() }
    : undefined;
})(ctl);
