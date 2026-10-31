import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { createDryRunGithubLogin, createGithubLogin, explainFailure, GH_LOGIN_MISSING, type GithubLoginSpawn } from './github-login.ts';

/** The GitHub device flow run by cezar (spec 2026-10-26-first-run-onboarding, "Sign in does the
 *  work"). `gh` is faked as a child process whose stderr the test writes, which is exactly the
 *  surface the real one uses: the code and the URL arrive on stderr, the exit code says whether
 *  GitHub approved. */
class FakeGh extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
  say(text: string): void {
    this.stderr.emit('data', Buffer.from(text));
  }
  exit(code: number): void {
    this.emit('exit', code, null);
  }
}

const asChild = (fake: FakeGh): ChildProcess => fake as unknown as ChildProcess;
/** `gh` is spawned after the signed-in check settles, one tick after `start()`. */
const tick = () => new Promise((resolveTick) => setTimeout(resolveTick, 0));
/** A login whose `gh auth status` says signed out, so every start asks GitHub for a code. */
const signedOut = (spawn: GithubLoginSpawn, extra: { codeTimeoutMs?: number } = {}) =>
  createGithubLogin({ spawn, isSignedIn: async () => false, ...extra });

describe('createGithubLogin', () => {
  it('resolves start() with the one-time code gh printed, then reports done on exit 0', async () => {
    const gh = new FakeGh();
    const login = signedOut(() => asChild(gh));

    const started = login.start();
    expect(login.read()).toEqual({ status: 'starting' });
    await tick();
    gh.say('\n');
    gh.say('! First copy your one-time code: C4AD-605F\nOpen this URL to continue in your web browser: https://github.com/login/device\n');

    expect(await started).toEqual({ status: 'pending', code: 'C4AD-605F', url: 'https://github.com/login/device' });
    gh.say('✓ Authentication complete.\n✓ Logged in as zielivia\n');
    gh.exit(0);
    expect(login.read()).toEqual({ status: 'done', login: 'zielivia' });
  });

  it('answers the pending login instead of starting a second one', async () => {
    const spawn = vi.fn(() => {
      const gh = new FakeGh();
      setTimeout(() => gh.say('! First copy your one-time code: AAAA-1111\n'), 0);
      return asChild(gh);
    });
    const login = signedOut(spawn);

    const [first, second] = await Promise.all([login.start(), login.start()]);
    expect(await login.start()).toEqual(first);
    expect(second).toEqual(first);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("reports gh's last line when GitHub denies or the code expires", async () => {
    const gh = new FakeGh();
    const login = signedOut(() => asChild(gh));
    const started = login.start();
    await tick();
    gh.say('! First copy your one-time code: BBBB-2222\n');
    await started;

    gh.say('error: The device code has expired\n');
    gh.exit(1);
    expect(login.read()).toEqual({ status: 'failed', error: 'The code expired. Try again for a new one.' });
  });

  it('flags a missing gh so the route can answer 503 with the install hint', async () => {
    const login = signedOut(() => {
      throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    });
    expect(await login.start()).toEqual({ status: 'failed', error: GH_LOGIN_MISSING, notFound: true });
  });

  it('gives up when gh never prints a code', async () => {
    const gh = new FakeGh();
    const login = signedOut(() => asChild(gh), { codeTimeoutMs: 20 });
    expect(await login.start()).toEqual({ status: 'failed', error: 'GitHub did not answer with a code. Try again.' });
    expect(gh.killed).toBe(true);
  });

  it('cancel kills the process and a later exit does not resurrect the state', async () => {
    const gh = new FakeGh();
    const login = signedOut(() => asChild(gh));
    const started = login.start();
    await tick();
    gh.say('! First copy your one-time code: CCCC-3333\n');
    await started;

    login.cancel();
    expect(gh.killed).toBe(true);
    gh.exit(1);
    expect(login.read()).toEqual({ status: 'idle' });
  });
});

describe('createGithubLogin, the cases around the code', () => {
  it('answers done without asking GitHub for a code when gh is already signed in', async () => {
    const spawn = vi.fn(() => asChild(new FakeGh()));
    const login = createGithubLogin({ spawn, isSignedIn: async () => true });
    expect(await login.start()).toEqual({ status: 'done' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('asks gh auth status first, and starts the login when it says signed out', async () => {
    const calls: string[][] = [];
    const login = createGithubLogin({
      spawn: (args) => {
        calls.push(args);
        const gh = new FakeGh();
        if (args[1] === 'status') setTimeout(() => gh.exit(1), 0);
        else setTimeout(() => gh.say('! First copy your one-time code: ABCD-1234\n'), 0);
        return asChild(gh);
      },
    });
    expect(await login.start()).toMatchObject({ status: 'pending', code: 'ABCD-1234' });
    expect(calls.map((args) => args[1])).toEqual(['status', 'login']);
  });

  it('a cancel while gh is still starting ends the waiting request instead of leaving it hanging', async () => {
    const gh = new FakeGh();
    const login = signedOut(() => asChild(gh));
    const started = login.start();
    await tick();
    login.cancel();
    expect(await started).toEqual({ status: 'idle' });
    expect(gh.killed).toBe(true);
  });

  it('reads a code from a reworded line that still mentions the code', async () => {
    const gh = new FakeGh();
    const login = signedOut(() => asChild(gh));
    const started = login.start();
    await tick();
    gh.say('Your code is 9F3A-77QK — enter it at https://github.com/login/device\n');
    expect(await started).toMatchObject({ status: 'pending', code: '9F3A-77QK' });
  });

  it('turns gh failures into plain words', () => {
    expect(explainFailure('The value of the GH_TOKEN environment variable is being used for authentication.\nTo have GitHub CLI store credentials instead, first clear the value from the environment.', 1)).toMatch(/Unset GH_TOKEN and restart cezar/);
    expect(explainFailure('failed to authenticate via web browser: Post "https://github.com/login/device/code": dial tcp: lookup github.com: no such host', 1)).toBe('GitHub could not be reached. Check your connection and try again.');
    expect(explainFailure('error: access_denied', 1)).toBe('Sign-in was cancelled on GitHub. Try again when you are ready.');
    expect(explainFailure('something odd happened\n', 2)).toBe('something odd happened');
    expect(explainFailure('', null)).toBe('GitHub CLI stopped with code unknown. Try again.');
  });
});

describe('createDryRunGithubLogin', () => {
  it('hands out a fake code and approves itself', async () => {
    vi.useFakeTimers();
    try {
      const login = createDryRunGithubLogin(50);
      expect(await login.start()).toEqual({ status: 'pending', code: 'DRY1-RUN2', url: 'https://github.com/login/device' });
      vi.advanceTimersByTime(60);
      expect(login.read()).toEqual({ status: 'done', login: 'dry-run-user' });
    } finally {
      vi.useRealTimers();
    }
  });
});
