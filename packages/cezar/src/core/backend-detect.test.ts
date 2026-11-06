import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Same technique as `server/forge/gitlab.test.ts`: `detectEnvironment()` builds its runners from
// `promisify(execFile)` at module load, so every probe below is driven through this mock — no
// real `gh`/`glab`/agent CLI on the box, no network.
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: (...args: unknown[]) => execFileMock(...args) };
});

import { detectEnvironment } from './backend-detect.ts';

type Callback = (err: unknown, value?: unknown) => void;

/** ENOENT — as a real spawn reports a missing binary. */
function enoent(bin: string): NodeJS.ErrnoException {
  const err = new Error(`spawn ${bin} ENOENT`) as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  return err;
}

/** A non-zero exit (e.g. a `glab config get` that cannot read its config) — promisify(execFile)
 *  rejects. Only the rejection matters to `probeGlab`'s bare `catch {}`, not the error's shape. */
function exitCode(code: number): Error {
  return Object.assign(new Error(`Command failed with exit code ${code}`), { code });
}

type MockResponse = { stdout?: string } | Error;
/** A bin's answer: one response for every call, or a per-invocation function of its argv (which
 *  `probeGlab` needs — it makes two `glab config get` calls that answer differently). */
type MockEntry = MockResponse | ((args: string[]) => MockResponse);

/** Route every mocked `execFile` call by binary name; anything not in `byBin` reports ENOENT
 *  (a CLI that simply isn't installed), so a test only has to describe what it cares about. */
function mockExecFile(byBin: Record<string, MockEntry>) {
  execFileMock.mockImplementation((...args: unknown[]) => {
    const bin = args[0] as string;
    const argv = (args[1] as string[] | undefined) ?? [];
    const cb = args[args.length - 1] as Callback;
    const entry = byBin[bin];
    if (!entry) {
      cb(enoent(bin));
      return;
    }
    const resp = typeof entry === 'function' ? entry(argv) : entry;
    if (resp instanceof Error) {
      cb(resp);
      return;
    }
    cb(null, { stdout: resp.stdout ?? '', stderr: '' });
  });
}

/** A `glab` whose default host is `host` and whose token for it is `token` (empty = logged out),
 *  answering the two local config reads `probeGlab` makes. */
function glabConfig(host: string, token: string): MockEntry {
  return (args) => ({ stdout: args.includes('token') ? token : host });
}

/** The `glab` calls the mock saw, as `glab <args…>` lines. */
function glabCalls(): { args: string[]; opts: { timeout?: number; env?: NodeJS.ProcessEnv } }[] {
  return execFileMock.mock.calls
    .filter((call: unknown[]) => call[0] === 'glab')
    .map((call: unknown[]) => ({
      args: call[1] as string[],
      opts: call[2] as { timeout?: number; env?: NodeJS.ProcessEnv },
    }));
}

describe('detectEnvironment — glab probe', () => {
  beforeEach(() => {
    execFileMock.mockReset();
    vi.stubEnv('CEZ_DRY_RUN', ''); // dry-run would short-circuit probeClaude/probePi
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reports glab available when a token is configured for its default host', async () => {
    mockExecFile({ glab: glabConfig('gitlab.com\n', 'glpat-example\n') });
    const checks = await detectEnvironment();
    const glab = checks.find((c) => c.name === 'glab');
    expect(glab).toEqual({ name: 'glab', available: true, version: 'authenticated' });
  });

  // The whole point of Step 4.3's review fix: `detectEnvironment` feeds `healthSnapshot`, and a
  // stale snapshot makes `GET /api/v1/health` wait for it. `glab auth status` validates the token
  // against every configured host over the NETWORK; these two reads are local, like `probeGh`'s
  // `gh auth token`, and are capped well under the health route's budget.
  it('probes with two LOCAL config reads on a short timeout, never `glab auth status`', async () => {
    mockExecFile({ glab: glabConfig('gitlab.example.com\n', 'glpat-example\n') });
    await detectEnvironment();
    const calls = glabCalls();
    expect(calls.map((c) => c.args)).toEqual([
      ['config', 'get', 'host'],
      // The DEFAULT host, not a hardcoded gitlab.com — a self-managed-only user is authenticated.
      ['config', 'get', 'token', '--host', 'gitlab.example.com'],
    ]);
    for (const call of calls) {
      expect(call.opts.timeout).toBeLessThanOrEqual(3_000);
      // `glab`'s version notifier is its one network touch on an otherwise local command.
      expect(call.opts.env?.GLAB_CHECK_UPDATE).toBe('false');
    }
  });

  // Sequential reads with the full timeout each would put the health route's worst case at twice
  // the probe's budget, which is the one thing the budget exists to bound.
  it('spends ONE budget across both reads: the second gets what the first left', async () => {
    const SLOW_MS = 120;
    // Only the first read is slow, so the budget the second one gets is observably smaller. The
    // budget is measured on `Date.now()`, so the "slow" read advances a fake clock by exactly
    // SLOW_MS — a real `setTimeout(SLOW_MS)` may fire a millisecond early against `Date.now()`,
    // which made this assertion flake in CI (2381 > 2380).
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    execFileMock.mockImplementation((...args: unknown[]) => {
      const bin = args[0] as string;
      const argv = (args[1] as string[] | undefined) ?? [];
      const cb = args[args.length - 1] as Callback;
      if (bin !== 'glab') {
        cb(enoent(bin));
        return;
      }
      const stdout = argv.includes('token') ? 'glpat-example\n' : 'gitlab.com\n';
      if (!argv.includes('token')) now += SLOW_MS;
      cb(null, { stdout, stderr: '' });
    });

    try {
      await detectEnvironment();
    } finally {
      clock.mockRestore();
    }
    const [first, second] = glabCalls();
    expect(first?.opts.timeout).toBe(2_500);
    expect(second?.opts.timeout).toBeLessThanOrEqual(2_500 - SLOW_MS);
    // A spent budget must not read as "no timeout", which is what `execFile` makes of 0.
    expect(second?.opts.timeout).toBeGreaterThan(0);
    // The pair's worst case is one budget: what the first read spent plus what the second may.
    expect(SLOW_MS + (second?.opts.timeout ?? 0)).toBeLessThanOrEqual(2_500);
  });

  it('falls back to gitlab.com when no default host is configured', async () => {
    mockExecFile({ glab: glabConfig('\n', 'glpat-example\n') });
    const checks = await detectEnvironment();
    expect(glabCalls()[1]?.args).toEqual(['config', 'get', 'token', '--host', 'gitlab.com']);
    expect(checks.find((c) => c.name === 'glab')).toMatchObject({ available: true });
  });

  it('reports glab unavailable with an optional-install hint when no token is configured', async () => {
    mockExecFile({ glab: glabConfig('gitlab.com\n', '\n') });
    const checks = await detectEnvironment();
    const glab = checks.find((c) => c.name === 'glab');
    expect(glab?.available).toBe(false);
    expect(glab?.hint).toBe(
      'optional: install the GitLab CLI and run `glab auth login` (only needed for GitLab projects)',
    );
  });

  it('reports glab unavailable with the same hint when a config read itself fails', async () => {
    mockExecFile({ glab: exitCode(1) });
    const checks = await detectEnvironment();
    const glab = checks.find((c) => c.name === 'glab');
    expect(glab?.available).toBe(false);
    expect(glab?.hint).toBe(
      'optional: install the GitLab CLI and run `glab auth login` (only needed for GitLab projects)',
    );
  });

  it('reports glab unavailable with the same hint when the CLI is not installed (ENOENT)', async () => {
    mockExecFile({}); // every bin, including glab, is missing
    const checks = await detectEnvironment();
    const glab = checks.find((c) => c.name === 'glab');
    expect(glab?.available).toBe(false);
    expect(glab?.hint).toBe(
      'optional: install the GitLab CLI and run `glab auth login` (only needed for GitLab projects)',
    );
  });

  it('never fails detectEnvironment as a whole when glab is missing — gh and others still resolve', async () => {
    mockExecFile({ gh: { stdout: 'gho_sometoken\n' } });
    const checks = await detectEnvironment();
    expect(checks.find((c) => c.name === 'gh')).toMatchObject({ name: 'gh', available: true });
    expect(checks.find((c) => c.name === 'glab')).toMatchObject({ name: 'glab', available: false });
  });
});
