import { spawn, type ChildProcess } from 'node:child_process';
import type { GithubLoginState } from '@open-mercato/cezar-contract';
import { ghEnv } from '../core/gh-env.ts';

/**
 * `POST/GET/DELETE /api/v1/github/login` (spec 2026-10-26-first-run-onboarding, "Sign in does
 * the work"): the GitHub device flow driven by cezar instead of by a terminal the user has to
 * find. cezar spawns `gh auth login --web` with no terminal attached, reads the one-time code
 * `gh` prints, hands it to the cockpit (which shows it with a Copy button and opens GitHub), and
 * keeps the process alive while `gh` polls GitHub for the approval. When `gh` exits 0 the token
 * is wherever `gh` keeps it — the same place `publish-github` and the GitHub tab read from.
 *
 * One login at a time: a second start while one is pending answers the pending one, because two
 * codes on two screens would each invalidate the other. A start while `gh` is already signed in
 * answers `done` without asking GitHub for a code at all.
 */

const GH_LOGIN_ARGS = ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--skip-ssh-key'];
const GH_STATUS_ARGS = ['auth', 'status', '--hostname', 'github.com'];
const CODE_PATTERN = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i;
/** Any `XXXX-XXXX` on a line that mentions a code — for a `gh` that rewords the sentence. */
const BARE_CODE_PATTERN = /^.*code.*\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/im;
const URL_PATTERN = /(https?:\/\/\S+\/login\/device\S*)/;
const LOGIN_PATTERN = /Logged in as\s+([A-Za-z0-9-]+)/;
const DEFAULT_URL = 'https://github.com/login/device';
/** `gh` prints the code within a second or two; longer means it is stuck on something else. */
const CODE_TIMEOUT_MS = 20_000;
export const GH_LOGIN_MISSING = 'gh CLI not found — install it from https://cli.github.com';

export type GithubLoginSpawn = (args: string[]) => ChildProcess;

export interface GithubLogin {
  /** Starts a login, or answers the one already running. Resolves once the code is known (or the
   *  process failed before printing one, or `gh` was already signed in). */
  start(): Promise<GithubLoginState>;
  read(): GithubLoginState;
  cancel(): void;
}

export function createGithubLogin(
  opts: { spawn?: GithubLoginSpawn; isSignedIn?: () => Promise<boolean>; codeTimeoutMs?: number } = {},
): GithubLogin {
  const spawnGh = opts.spawn ?? defaultSpawn;
  const isSignedIn = opts.isSignedIn ?? (() => ghSignedIn(spawnGh));
  const codeTimeoutMs = opts.codeTimeoutMs ?? CODE_TIMEOUT_MS;
  let state: GithubLoginState = { status: 'idle' };
  let child: ChildProcess | null = null;
  let starting: Promise<GithubLoginState> | null = null;
  /** Ends a start still waiting for its code — a cancel must not leave the request hanging. */
  let abandonStart: ((value: GithubLoginState) => void) | null = null;

  const settle = (next: GithubLoginState): void => {
    state = next;
    child = null;
  };

  const login = (): Promise<GithubLoginState> =>
    new Promise<GithubLoginState>((resolveCode) => {
      let output = '';
      let answered = false;
      let codeTimer: ReturnType<typeof setTimeout> | null = null;
      const answer = (value: GithubLoginState): void => {
        if (answered) return;
        answered = true;
        if (codeTimer) clearTimeout(codeTimer);
        starting = null;
        abandonStart = null;
        resolveCode(value);
      };
      abandonStart = answer;
      let proc: ChildProcess;
      try {
        proc = spawnGh(GH_LOGIN_ARGS);
      } catch (err) {
        settle({ status: 'failed', error: notFound(err) ? GH_LOGIN_MISSING : errText(err), notFound: notFound(err) });
        answer(state);
        return;
      }
      child = proc;
      trackForExit(proc);
      codeTimer = setTimeout(() => {
        proc.kill();
        settle({ status: 'failed', error: 'GitHub did not answer with a code. Try again.' });
        answer(state);
      }, codeTimeoutMs);
      const onData = (chunk: Buffer | string): void => {
        output += chunk.toString();
        if (output.length > 16_384) output = output.slice(-8_192);
        if (answered) return;
        const code = (CODE_PATTERN.exec(output) ?? BARE_CODE_PATTERN.exec(output))?.[1]?.toUpperCase();
        if (code) {
          state = { status: 'pending', code, url: URL_PATTERN.exec(output)?.[1] ?? DEFAULT_URL };
          answer(state);
        }
      };
      proc.stdout?.on('data', onData);
      proc.stderr?.on('data', onData);
      proc.on('error', (err) => {
        if (child !== proc) return;
        settle({ status: 'failed', error: notFound(err) ? GH_LOGIN_MISSING : errText(err), notFound: notFound(err) });
        answer(state);
      });
      proc.on('exit', (code) => {
        if (child !== proc) return;
        const login = LOGIN_PATTERN.exec(output)?.[1];
        if (code === 0) settle(login ? { status: 'done', login } : { status: 'done' });
        else settle({ status: 'failed', error: explainFailure(output, code) });
        answer(state);
      });
    });

  const start = (): Promise<GithubLoginState> => {
    if (starting) return starting;
    if (state.status === 'pending') return Promise.resolve(state);
    state = { status: 'starting' };
    starting = isSignedIn()
      .catch(() => false)
      .then((signedIn) => {
        if (state.status !== 'starting') return state;
        if (!signedIn) return login();
        state = { status: 'done' };
        starting = null;
        return state;
      });
    return starting;
  };

  const cancel = (): void => {
    const proc = child;
    const abandon = abandonStart;
    child = null;
    starting = null;
    abandonStart = null;
    state = { status: 'idle' };
    proc?.kill();
    abandon?.({ status: 'idle' });
  };

  return { start, read: () => state, cancel };
}

/** `CEZ_DRY_RUN=1`: a fake code that approves itself after a few seconds, so the dialog can be
 *  walked without touching GitHub. */
export function createDryRunGithubLogin(approveAfterMs = 6_000): GithubLogin {
  let state: GithubLoginState = { status: 'idle' };
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    start: () => {
      if (state.status !== 'pending') {
        state = { status: 'pending', code: 'DRY1-RUN2', url: DEFAULT_URL };
        timer = setTimeout(() => {
          state = { status: 'done', login: 'dry-run-user' };
          timer = null;
        }, approveAfterMs);
      }
      return Promise.resolve(state);
    },
    read: () => state,
    cancel: () => {
      if (timer) clearTimeout(timer);
      timer = null;
      state = { status: 'idle' };
    },
  };
}

/**
 * `gh`'s own words, made readable for someone who never ran it. The common failures are the
 * network, an expired or refused code, and a `GH_TOKEN` in cezar's environment, which `gh`
 * always prefers over a login and so refuses to replace.
 */
export function explainFailure(output: string, exitCode: number | null): string {
  if (/GH_TOKEN|GITHUB_TOKEN/.test(output)) {
    return 'cezar was started with GH_TOKEN set, and GitHub CLI uses that token instead of signing in. Unset GH_TOKEN and restart cezar.';
  }
  if (/expired/i.test(output)) return 'The code expired. Try again for a new one.';
  if (/access_denied|denied|cancel/i.test(output)) return 'Sign-in was cancelled on GitHub. Try again when you are ready.';
  if (/dial tcp|no such host|connection refused|network is unreachable|i\/o timeout|TLS handshake|proxyconnect/i.test(output)) {
    return 'GitHub could not be reached. Check your connection and try again.';
  }
  const line = lastLine(output);
  return line || `GitHub CLI stopped with code ${exitCode ?? 'unknown'}. Try again.`;
}

async function ghSignedIn(spawnGh: GithubLoginSpawn): Promise<boolean> {
  return new Promise((resolveSignedIn) => {
    let proc: ChildProcess;
    try {
      proc = spawnGh(GH_STATUS_ARGS);
    } catch {
      resolveSignedIn(false);
      return;
    }
    const timer = setTimeout(() => {
      proc.kill();
      resolveSignedIn(false);
    }, 15_000);
    proc.on('error', () => {
      clearTimeout(timer);
      resolveSignedIn(false);
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      resolveSignedIn(code === 0);
    });
  });
}

const liveChildren = new Set<ChildProcess>();
let exitHookInstalled = false;

/** A login left waiting must not outlive cezar: `gh` would keep polling GitHub for 15 minutes. */
function trackForExit(proc: ChildProcess): void {
  liveChildren.add(proc);
  proc.once('exit', () => liveChildren.delete(proc));
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const live of liveChildren) live.kill();
  });
}

function defaultSpawn(args: string[]): ChildProcess {
  return spawn('gh', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    // No terminal: `gh` then prints the code and the URL instead of waiting for Enter, and
    // never opens a browser of its own — the cockpit does that, on the machine the user is at.
    env: { ...ghEnv(), GH_PROMPT_DISABLED: '1', BROWSER: process.platform === 'win32' ? 'rem' : 'true' },
  });
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function notFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === 'ENOENT';
}

function lastLine(text: string): string {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !CODE_PATTERN.test(line) && !URL_PATTERN.test(line));
  return lines.at(-1) ?? '';
}
