import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HarnessRuntime,
  computeGateRegressions,
  failingOutputLineIds,
  exportTrustedConfig,
  extractFailingTestIds,
  extractFailureEvidence,
  harnessChildEnvironment,
  harnessConfigEnvironmentNames,
  reconcileHarnessProcess,
  loadAgenticConfig,
  resolveHarnessRuntimeInfo,
  resolveHarnessScript,
  runValidationCommands,
} from './runtime.js';

/**
 * The runtime bridge (spec Architecture §2): spawns the installed
 * `harness.mjs` with an argument array (never a shell), bounded by a timeout
 * and killable on cancel; exports the trusted config snapshot from the base
 * revision; and runs the repo's configured validation commands with real exit
 * codes as evidence. Tested against a stub script — the real `harness.mjs` is
 * the skills repo's contract, not this test's.
 */
describe('harness runtime bridge', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-harness-rt-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writeStub = (body: string): string => {
    const script = join(dir, 'harness.mjs');
    writeFileSync(script, body, 'utf8');
    return script;
  };

  const waitFor = async (predicate: () => boolean, timeoutMs = 3_000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return predicate();
  };

  const processExists = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it('resolveHarnessRuntimeInfo reports the bundled collection with its pinned commit', async () => {
    const info = await resolveHarnessRuntimeInfo(dir);
    expect(info.installed).toBe(true);
    expect(info.source).toBe('bundled');
    expect(info.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('resolveHarnessRuntimeInfo degrades honestly when the collection is absent or scriptless', async () => {
    const none = await resolveHarnessRuntimeInfo(dir, { bundledDir: null });
    expect(none).toEqual({ installed: false, source: null, commit: null });

    const fake = join(dir, 'fake-bundled');
    mkdirSync(join(fake, 'cez-harness'), { recursive: true });
    writeFileSync(join(fake, 'cez-harness', 'SKILL.md'), '---\nname: cez-harness\n---\nbody');
    const scriptless = await resolveHarnessRuntimeInfo(dir, { bundledDir: fake });
    expect(scriptless.installed).toBe(false);
    expect(scriptless.source).toBe('bundled');
  });

  it('resolveHarnessScript finds the materialized skill script or null', () => {
    expect(resolveHarnessScript(dir)).toBeNull();
    const scriptDir = join(dir, '.claude', 'skills', 'cez-harness', 'scripts');
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(join(scriptDir, 'harness.mjs'), '// stub', 'utf8');
    expect(resolveHarnessScript(dir)).toBe(join(scriptDir, 'harness.mjs'));
  });

  it('run() reports exit code and output for a succeeding op', async () => {
    const script = writeStub('console.log("captured"); process.exit(0);');
    const rt = new HarnessRuntime({ script, cwd: dir });
    const result = await rt.run('capture', ['--worktree', dir]);
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('captured');
  });

  it('run() reports failure with stderr for a non-zero op', async () => {
    const script = writeStub('console.error("refs moved"); process.exit(3);');
    const rt = new HarnessRuntime({ script, cwd: dir });
    const result = await rt.run('stage', []);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('refs moved');
  });

  it('run() kills an op that exceeds its timeout', async () => {
    const script = writeStub('setTimeout(() => {}, 60_000);');
    const rt = new HarnessRuntime({ script, cwd: dir });
    const result = await rt.run('probe', [], { timeoutMs: 300 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out/);
  });

  it('kill() terminates a running op (the cancel path)', async () => {
    const script = writeStub('setTimeout(() => {}, 60_000);');
    const rt = new HarnessRuntime({ script, cwd: dir });
    const pending = rt.run('worker', []);
    await new Promise((r) => setTimeout(r, 100));
    rt.kill();
    const result = await pending;
    expect(result.ok).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('kill() terminates the complete provider process tree', async () => {
    const grandchildPidPath = join(dir, 'grandchild.pid');
    const script = writeStub(`
      import { spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' });
      writeFileSync(${JSON.stringify(grandchildPidPath)}, String(grandchild.pid));
      setInterval(() => {}, 60000);
    `);
    const rt = new HarnessRuntime({ script, cwd: dir });
    const pending = rt.run('worker', []);
    expect(await waitFor(() => existsSync(grandchildPidPath))).toBe(true);
    const grandchildPid = Number(readFileSync(grandchildPidPath, 'utf8'));
    expect(processExists(grandchildPid)).toBe(true);

    rt.kill();
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(await waitFor(() => !processExists(grandchildPid))).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('reconciles a recorded matching process identity after a host restart', async () => {
    const script = writeStub('setInterval(() => {}, 60_000);');
    const rt = new HarnessRuntime({ script, cwd: dir });
    let identity: Parameters<typeof reconcileHarnessProcess>[0] | undefined;
    const pending = rt.run('review', [], {
      onSpawn: (spawned) => {
        identity = spawned;
      },
    });
    expect(await waitFor(() => identity !== undefined)).toBe(true);

    await expect(reconcileHarnessProcess(identity!)).resolves.toEqual({ status: 'terminated' });
    await expect(pending).resolves.toMatchObject({ ok: false });
  });

  // recovery returned `terminated` once the LEADER exited, so a member
  // that ignores SIGTERM kept writing the worktree beside the replacement work.
  describe.skipIf(process.platform === 'win32')('restart recovery of a recorded process group', () => {
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
      }
    };
    const recordedGroup = async (leaderExits: boolean) => {
      const token = 'token-' + Math.random().toString(16).slice(2);
      const childPidFile = join(dir, 'child.pid');
      const leader = spawn(
        process.execPath,
        [
          '-e',
          `const { spawn } = require('node:child_process');
const child = spawn('/bin/sh', ['-c', "trap '' TERM; while :; do sleep 0.05; done"], { stdio: 'ignore' });
require('node:fs').writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));
child.unref();
${leaderExits ? 'setTimeout(() => process.exit(0), 50);' : 'setInterval(() => {}, 60_000);'}`,
        ],
        { detached: true, stdio: 'ignore', env: { ...process.env, CEZ_PROCESS_TOKEN: token } },
      );
      leader.unref();
      expect(await waitFor(() => existsSync(childPidFile) && readFileSync(childPidFile, 'utf8') !== '')).toBe(true);
      const child = Number(readFileSync(childPidFile, 'utf8'));
      if (leaderExits) expect(await waitFor(() => !alive(leader.pid!))).toBe(true);
      return { identity: { pid: leader.pid!, token, startedAt: new Date().toISOString(), group: true }, child };
    };
    const reap = (pid: number) => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
      }
    };

    it('waits out a member that ignores SIGTERM after the leader exits', async () => {
      const { identity, child } = await recordedGroup(false);
      try {
        await expect(reconcileHarnessProcess(identity)).resolves.toEqual({ status: 'terminated' });
        expect(alive(child)).toBe(false);
      } finally {
        reap(identity.pid);
      }
    }, 20_000);

    it('terminates the survivors of a leader that was already gone', async () => {
      const { identity, child } = await recordedGroup(true);
      try {
        await expect(reconcileHarnessProcess(identity)).resolves.toEqual({ status: 'terminated' });
        expect(alive(child)).toBe(false);
      } finally {
        reap(identity.pid);
      }
    }, 20_000);
  });

  it('bounds captured runtime output exactly at the configured cap', async () => {
    const script = writeStub(`process.stdout.write('x'.repeat(250_000));`);
    const result = await new HarnessRuntime({ script, cwd: dir }).run('probe', []);
    expect(result.stdout).toHaveLength(200_000);
  });

  it('passes only safe base variables plus explicitly trusted provider variables', () => {
    const source = {
      PATH: '/bin',
      HOME: '/tmp/home',
      OPENAI_API_KEY: 'provider',
      DEEPSEEK_API_KEY: 'deepseek',
      DATABASE_URL: 'must-not-leak',
      AWS_SECRET_ACCESS_KEY: 'must-not-leak',
    };
    expect(harnessChildEnvironment(['DEEPSEEK_API_KEY'], source)).toEqual({
      PATH: '/bin',
      HOME: '/tmp/home',
      OPENAI_API_KEY: 'provider',
      DEEPSEEK_API_KEY: 'deepseek',
    });
    expect(
      harnessConfigEnvironmentNames({
        models: {
          deepseek: { credentialEnv: 'DEEPSEEK_API_KEY' },
          kimi: { binaryEnv: 'OM_KIMI_BIN' },
          invalid: { credentialEnv: 'bad-name' },
        },
      }),
    ).toEqual(['DEEPSEEK_API_KEY', 'OM_KIMI_BIN', 'bad-name']);
  });

  it('does not expose unrelated parent secrets to the harness process', async () => {
    const script = writeStub('console.log(JSON.stringify(process.env));');
    const previous = process.env.CEZ_TEST_DATABASE_SECRET;
    process.env.CEZ_TEST_DATABASE_SECRET = 'do-not-forward';
    try {
      const result = await new HarnessRuntime({ script, cwd: dir }).run('probe', []);
      const environment = JSON.parse(result.stdout) as Record<string, string>;
      expect(environment.CEZ_TEST_DATABASE_SECRET).toBeUndefined();
      expect(environment.PATH).toBe(process.env.PATH);
      expect(environment.CEZ_PROCESS_TOKEN).toBeTruthy();
    } finally {
      if (previous === undefined) delete process.env.CEZ_TEST_DATABASE_SECRET;
      else process.env.CEZ_TEST_DATABASE_SECRET = previous;
    }
  });

  // a command red on main stopped the gate, so nothing after it was measured.
  it('runValidationCommands continues past a failed command named in continueAfter', async () => {
    const checks = await runValidationCommands(['echo src/a.ts: error; exit 2', 'echo after'], dir, {
      continueAfter: new Set(['echo src/a.ts: error; exit 2']),
    });
    expect(checks[0]).toMatchObject({ status: 'failed', failureIds: ['line:src/a.ts: error'] });
    expect(checks[1]).toMatchObject({ command: 'echo after', status: 'passed' });
  });

  it('runValidationCommands records real per-command evidence and stops on failure', async () => {
    const checks = await runValidationCommands(['echo ok', 'exit 2', 'echo never'], dir);
    expect(checks).toHaveLength(3);
    expect(checks[0]).toMatchObject({ command: 'echo ok', status: 'passed', exitCode: 0 });
    expect(checks[1]).toMatchObject({ command: 'exit 2', status: 'failed', exitCode: 2 });
    expect(checks[2]).toMatchObject({ command: 'echo never', status: 'skipped', exitCode: null });
  });

  // a model-written test could push with the user's ssh-agent.
  it.skipIf(process.platform === 'win32')(
    'runValidationCommands closes the default push paths but keeps local git working',
    async () => {
      vi.stubEnv('SSH_AUTH_SOCK', '/tmp/user-agent.sock');
      try {
        const remote = join(dir, 'remote.git');
        execFileSync('git', ['init', '-q', '--bare', remote]);
        const [check] = await runValidationCommands(
          [
            [
              'test -z "$SSH_AUTH_SOCK"',
              'test "$GIT_ASKPASS" = /usr/bin/false',
              'test -d "$GH_CONFIG_DIR" && test -z "$(ls -A "$GH_CONFIG_DIR")"',
              '! git ls-remote ssh://git@example.invalid/org/repo.git 2>ssh.err && grep -q "not allowed" ssh.err',
              `git ls-remote ${JSON.stringify(remote)} >/dev/null`,
            ].join(' && '),
          ],
          dir,
        );
        expect(check).toMatchObject({ status: 'passed', exitCode: 0 });
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  // `npm test` runs model-written scripts unsandboxed.
  it('runValidationCommands never hands provider credentials to the validated code', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai-test');
    try {
      const [check] = await runValidationCommands(
        ['test -z "$ANTHROPIC_API_KEY" && test -z "$OPENAI_API_KEY" && test -n "$PATH"'],
        dir,
      );
      expect(check).toMatchObject({ status: 'passed', exitCode: 0 });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'provisions Corepack shims for a repository-pinned package manager',
    async () => {
      const fakeBin = join(dir, 'fake-bin');
      mkdirSync(fakeBin);
      const bash = join(fakeBin, 'bash');
      writeFileSync(
        bash,
        [
          '#!/bin/sh',
          'if [ "$1" = "-lc" ]; then',
          '  PATH=/usr/bin:/bin',
          'fi',
          'exec /bin/bash "$@"',
        ].join('\n'),
        'utf8',
      );
      chmodSync(bash, 0o755);
      const corepack = join(fakeBin, 'corepack');
      writeFileSync(
        corepack,
        [
          '#!/bin/sh',
          'install_dir="$3"',
          'printf \'#!/bin/sh\\necho repository-yarn\\n\' > "$install_dir/yarn"',
          'chmod +x "$install_dir/yarn"',
        ].join('\n'),
        'utf8',
      );
      chmodSync(corepack, 0o755);
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ packageManager: 'yarn@4.17.1' }),
        'utf8',
      );

      const [check] = await runValidationCommands(['yarn --version'], dir, {
        env: { PATH: `${fakeBin}:/usr/bin:/bin` },
      });

      expect(check).toMatchObject({
        command: 'yarn --version',
        status: 'passed',
        exitCode: 0,
        evidence: 'repository-yarn',
      });
    },
  );

  // a ledger write failing at a command's exit (ENOSPC, EACCES) threw from the
  // child's 'close' listener — an uncaught exception that killed every run in every project.
  it('fails the gate, not the process, when recording a command exit throws', async () => {
    await expect(
      runValidationCommands(['true'], dir, {
        onExit: () => {
          throw new Error('ENOSPC: no space left on device');
        },
      }),
    ).rejects.toThrow(/ENOSPC/);
  }, 10_000);

  // a blocking read here froze the whole server, and again on every resume.
  it.skipIf(process.platform === 'win32')('runs the gate past a FIFO planted at package.json', async () => {
    execFileSync('mkfifo', [join(dir, 'package.json')]);
    const [check] = await runValidationCommands(['echo gate-ran'], dir);
    expect(check).toMatchObject({ status: 'passed', evidence: 'gate-ran' });
  }, 10_000);

  // the SIGKILL escalation was skipped once the shell exited, and the gate settled
  // only on 'close', so a worker that ignored SIGTERM held its pipe and the gate never resolved.
  describe.skipIf(process.platform === 'win32')('a gate process that ignores SIGTERM', () => {
    const stubborn = (pidFile: string) =>
      `node -e "process.on('SIGTERM',()=>{});require('fs').writeFileSync('${pidFile}',String(process.pid));setInterval(()=>{},1000)"`;
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const waitDead = async (pid: number) => {
      const deadline = Date.now() + 10_000;
      while (alive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
      return !alive(pid);
    };

    it('times the gate out and kills the process', async () => {
      const pidFile = join(dir, 'gate.pid');
      // `; true` keeps bash as the group leader: it dies on SIGTERM and leaves node behind.
      const [check] = await runValidationCommands([`${stubborn(pidFile)}; true`], dir, { timeoutMs: 1_500 });
      expect(check?.status).toBe('failed');
      expect(await waitDead(Number(readFileSync(pidFile, 'utf8')))).toBe(true);
    }, 30_000);

    it('settles a passing gate whose background child keeps the pipe open, then ends that child', async () => {
      const pidFile = join(dir, 'bg.pid');
      const [check] = await runValidationCommands([`${stubborn(pidFile)} & sleep 0.5`], dir);
      expect(check?.status).toBe('passed');
      expect(await waitDead(Number(readFileSync(pidFile, 'utf8')))).toBe(true);
    }, 30_000);
  });

  it('bounds validation output exactly at the configured cap', async () => {
    const [check] = await runValidationCommands(
      [`node -e "process.stdout.write('x'.repeat(250000))"`],
      dir,
    );
    expect(check?.status).toBe('passed');
    expect(check?.evidence).toHaveLength(200_000);
  });

  /**
   * Regression (run c54c2ed4): `yarn test` produced ~1 MB of interleaved turbo
   * output; the old capture kept the FIRST 200 KB and the run's failure
   * evidence became 8 lines from mid-stream — a PASSING package's summary —
   * while the real `FAIL` and turbo's own `Failed:` block sat in the dropped
   * tail. The capture must keep the tail, where test runners put their verdicts.
   */
  it('keeps the TAIL of over-cap validation output, not the head', async () => {
    const [check] = await runValidationCommands(
      [
        `node -e "process.stdout.write('HEAD-MARKER\\n'); process.stdout.write('x'.repeat(250000)); process.stdout.write('\\nTAIL-MARKER: the real failure\\n'); process.exitCode = 1"`,
      ],
      dir,
    );
    expect(check?.status).toBe('failed');
    expect(check?.evidence).toContain('TAIL-MARKER: the real failure');
    expect(check?.evidence).not.toContain('HEAD-MARKER');
  });

  it('marks a timed-out validation command as timed out in its evidence', async () => {
    const [check] = await runValidationCommands(
      [`node -e "setTimeout(() => {}, 60000)"`],
      dir,
      { timeoutMs: 500 },
    );
    expect(check?.status).toBe('failed');
    expect(check?.timedOut).toBe(true);
    expect(check?.evidence).toContain('timed out');
  });

  it('persists full command output to a log file when a logDir is given', async () => {
    const logDir = join(dir, 'artifacts');
    mkdirSync(logDir, { recursive: true });
    const [check] = await runValidationCommands(
      [`node -e "console.log('FAIL src/a.test.ts'); console.log('long diagnostics'); process.exit(1)"`],
      dir,
      { logDir, logPrefix: 'validation-validate-2-' },
    );
    expect(check?.status).toBe('failed');
    expect(check?.logPath).toBeTruthy();
    expect(check?.logPath).toContain('validation-validate-2-');
    const logged = readFileSync(check!.logPath!, 'utf8');
    expect(logged).toContain('FAIL src/a.test.ts');
    expect(logged).toContain('long diagnostics');
    expect(check?.evidence).toContain(check!.logPath!);
  });

  describe('failure evidence extraction', () => {
    /** The real shape from run c54c2ed4: a failing package mid-stream, a
     *  passing package's summary as the physical tail, turbo's verdict last. */
    const turboOutput = [
      '@open-mercato/ui:test: PASS src/ai/__tests__/AiChat.test.tsx',
      '@open-mercato/core:test: FAIL src/__tests__/explicit-sort-comparators.test.ts',
      '@open-mercato/core:test:   ● sort/toSorted call sites use explicit comparators (#3620) › no production sort/toSorted call omits its comparator',
      '@open-mercato/core:test:     expect(received).toEqual(expected) // deep equality',
      '@open-mercato/core:test: Tests:       1 failed, 7904 passed, 7905 total',
      '@open-mercato/webhooks:test: Tests:       116 passed, 116 total',
      '@open-mercato/webhooks:test: Ran all test suites.',
      ' Tasks:    22 successful, 23 total',
      'Failed:    @open-mercato/core#test',
      ' ERROR  run failed: command  exited (1)',
    ].join('\n');

    it('surfaces FAIL lines and the runner verdict, not just the physical tail', () => {
      const evidence = extractFailureEvidence(turboOutput);
      expect(evidence).toContain('FAIL src/__tests__/explicit-sort-comparators.test.ts');
      expect(evidence).toContain('Failed:    @open-mercato/core#test');
      expect(evidence).toContain('● sort/toSorted call sites use explicit comparators');
      expect(evidence).toContain('1 failed');
    });

    it('bounds the extracted evidence and keeps a tail for context', () => {
      const noisy = Array.from({ length: 5000 }, (_, i) => `@pkg:test: FAIL suite-${i}.test.ts`).join('\n');
      const evidence = extractFailureEvidence(`${noisy}\nfinal tail line`);
      expect(evidence.length).toBeLessThan(8_000);
      expect(evidence).toContain('final tail line');
    });

    it('falls back to the plain tail when no failure signature matches', () => {
      const evidence = extractFailureEvidence('some output\nwithout known markers\nlast line');
      expect(evidence).toContain('last line');
    });
  });

  describe('failing output line identities', () => {
    it('normalizes ANSI, digits and whitespace, and digests lines past the cap', () => {
      expect(failingOutputLineIds('\u001B[31mERR\u001B[0m  12 files\n\n  ERR 7  files ')).toEqual(['line:ERR # files']);
      const letters = (i: number) => String.fromCharCode(97 + Math.floor(i / 26)) + String.fromCharCode(97 + (i % 26));
      const many = Array.from({ length: 450 }, (_, i) => `rule-${letters(i)}`).join('\n');
      const ids = failingOutputLineIds(many);
      expect(ids).toHaveLength(401);
      expect(ids.at(-1)).toMatch(/^overflow:[0-9a-f]{16}$/);
      expect(failingOutputLineIds(`${many}\nanother`).at(-1)).not.toBe(ids.at(-1));
    });
  });

  describe('failing-test identity extraction', () => {
    it('normalizes jest FAIL paths and turbo failed tasks, ignoring ANSI codes', () => {
      const output = [
        '@open-mercato/core:test: \u001B[31mFAIL\u001B[0m src/__tests__/explicit-sort-comparators.test.ts',
        '@open-mercato/webhooks:test: PASS src/modules/webhooks/__tests__/ok.test.ts',
        'Failed:    @open-mercato/core#test',
      ].join('\n');
      expect(extractFailingTestIds(output)).toEqual([
        'fail:src/__tests__/explicit-sort-comparators.test.ts',
        'task:@open-mercato/core#test',
      ]);
    });

    it('captures tsc error identities by file, code and message — not line numbers', () => {
      const output = [
        "src/server/server.ts(42,7): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
        "src/server/server.ts(90,1): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
        'src/server/server.ts(120,3): error TS2345: Expected 2 arguments, but got 3.',
      ].join('\n');
      expect(extractFailingTestIds(output)).toEqual([
        'ts:src/server/server.ts:TS2345',
        "ts:src/server/server.ts:TS2345:Argument of type 'string' is not assignable to parameter of type 'number'.",
        'ts:src/server/server.ts:TS2345:Expected # arguments, but got #.',
      ]);
    });

    // Review round 2: `fail:<file>` alone read a second failing test in an already-failing file as
    // the baseline's failure. Each failing test is named beneath its suite, timings dropped.
    it('names each failing jest test under its FAIL suite, without timings', () => {
      const output = [
        '@open-mercato/core:test: FAIL src/a.test.ts',
        '@open-mercato/core:test:   suite',
        '@open-mercato/core:test:     ✓ passes (2 ms)',
        '@open-mercato/core:test:     ✕ fails A (3 ms)',
        '@open-mercato/core:test:     ✕ fails B (1 ms)',
        '@open-mercato/core:test: ',
        '@open-mercato/core:test:   ● suite › fails A',
      ].join('\n');
      expect(extractFailingTestIds(output)).toEqual([
        'fail:src/a.test.ts',
        'test:src/a.test.ts::fails A',
        'test:src/a.test.ts::fails B',
      ]);
    });

    it('names each failing vitest test from its file header and from its FAIL line alike', () => {
      const output = [
        ' ❯ src/a.test.ts (2 tests | 1 failed) 12ms',
        '   × suite > fails A 3ms',
        '     → expected 1 to be 2',
        '',
        ' FAIL  src/a.test.ts > suite > fails A',
        ' FAIL  |web| src/b.test.ts > other > fails C',
      ].join('\n');
      expect(extractFailingTestIds(output)).toEqual([
        'test:src/a.test.ts::suite > fails A',
        'fail:src/a.test.ts',
        'fail:src/b.test.ts',
        'test:src/b.test.ts::other > fails C',
      ]);
    });
  });

  describe('gate regressions against a baseline', () => {
    const failed = (command: string, failureIds: string[]): Parameters<typeof computeGateRegressions>[0][number] => ({
      command,
      status: 'failed',
      exitCode: 1,
      evidence: 'x',
      failureIds,
    });
    const passed = (command: string): Parameters<typeof computeGateRegressions>[0][number] => ({
      command,
      status: 'passed',
      exitCode: 0,
      evidence: 'ok',
    });

    it('blocks every failure when there is no baseline', () => {
      const gate = computeGateRegressions([failed('yarn test', ['fail:a.test.ts'])], undefined);
      expect(gate.blocking).toHaveLength(1);
      expect(gate.tolerated).toHaveLength(0);
    });

    it('tolerates failures whose identities are a subset of the baseline set', () => {
      const gate = computeGateRegressions(
        [passed('yarn build'), failed('yarn test', ['fail:a.test.ts'])],
        [passed('yarn build'), failed('yarn test', ['fail:a.test.ts', 'fail:b.test.ts'])],
      );
      expect(gate.blocking).toHaveLength(0);
      expect(gate.tolerated).toHaveLength(1);
      expect(gate.tolerated[0]?.check.command).toBe('yarn test');
      expect(gate.tolerated[0]?.check.preexisting).toBe(true);
    });

    it('blocks when new failure identities appear beyond the baseline', () => {
      const gate = computeGateRegressions(
        [failed('yarn test', ['fail:a.test.ts', 'fail:NEW.test.ts'])],
        [failed('yarn test', ['fail:a.test.ts'])],
      );
      expect(gate.blocking).toHaveLength(1);
      expect(gate.blocking[0]?.newFailureIds).toEqual(['fail:NEW.test.ts']);
    });

    it('blocks when the command passed at baseline', () => {
      const gate = computeGateRegressions(
        [failed('yarn test', ['fail:a.test.ts'])],
        [passed('yarn test')],
      );
      expect(gate.blocking).toHaveLength(1);
    });

    it('tolerates a silent repeat only with the same exit code', () => {
      const gate = computeGateRegressions(
        [failed('yarn lint', [])],
        [failed('yarn lint', [])],
      );
      expect(gate.blocking).toHaveLength(0);
      expect(gate.tolerated).toHaveLength(1);
      const other = computeGateRegressions(
        [{ ...failed('yarn lint', []), exitCode: 2 }],
        [failed('yarn lint', [])],
      );
      expect(other.blocking).toHaveLength(1);
    });

    // a different lint failure was tolerated because neither side named a test.
    it('blocks a failure whose output lines the baseline never printed', () => {
      const baselineIds = failingOutputLineIds('src/a.ts\n  3:7  error  no-unused-vars\n✖ 1 problem');
      const currentIds = failingOutputLineIds('src/a.ts\n  3:7  error  no-unused-vars\nsrc/b.ts\n  9:1  error  no-undef\n✖ 2 problems');
      const gate = computeGateRegressions([failed('yarn lint', currentIds)], [failed('yarn lint', baselineIds)]);
      expect(gate.tolerated).toHaveLength(0);
      expect(gate.blocking[0]?.newFailureIds).toEqual(['line:src/b.ts', 'line:#:# error no-undef', 'line:✖ # problems']);
    });

    // Review round 2: baseline `FAIL src/a.test.ts` (A) and current `FAIL src/a.test.ts` (A and B)
    // were the same suite-level set, so B passed the gate as pre-existing.
    it('blocks a new failing test inside a suite that already failed at baseline', () => {
      const baseline = extractFailingTestIds('FAIL src/a.test.ts\n  ✕ fails A (3 ms)');
      const current = extractFailingTestIds('FAIL src/a.test.ts\n  ✕ fails A (4 ms)\n  ✕ fails B (1 ms)');
      const gate = computeGateRegressions([failed('yarn test', current)], [failed('yarn test', baseline)]);
      expect(gate.tolerated).toHaveLength(0);
      expect(gate.blocking[0]?.newFailureIds).toEqual(['test:src/a.test.ts::fails B']);
    });

    it('guard: tolerates the same failing test printed with a different timing', () => {
      const gate = computeGateRegressions(
        [failed('yarn test', extractFailingTestIds('FAIL src/a.test.ts\n  ✕ fails A (9 ms)'))],
        [failed('yarn test', extractFailingTestIds('FAIL src/a.test.ts\n  ✕ fails A (3 ms)'))],
      );
      expect(gate.blocking).toHaveLength(0);
      expect(gate.tolerated).toHaveLength(1);
    });

    it('guard: tolerates the same lint failure printed with different line numbers and timings', () => {
      const gate = computeGateRegressions(
        [failed('yarn lint', failingOutputLineIds('src/a.ts\n  4:7  error  no-unused-vars\nDone in 1.2s'))],
        [failed('yarn lint', failingOutputLineIds('src/a.ts\n  3:7  error  no-unused-vars\nDone in 3.9s'))],
      );
      expect(gate.blocking).toHaveLength(0);
      expect(gate.tolerated).toHaveLength(1);
    });
  });

  it('loadAgenticConfig reads validation commands and tolerates absence', async () => {
    expect(await loadAgenticConfig(dir)).toEqual({ validationCommands: [], agentHarness: undefined, baseBranch: undefined });
    mkdirSync(join(dir, '.ai'), { recursive: true });
    writeFileSync(
      join(dir, '.ai', 'agentic.config.json'),
      JSON.stringify({ baseBranch: 'main', validation: { commands: ['npm test'] }, agentHarness: { version: 1 } }),
      'utf8',
    );
    const config = await loadAgenticConfig(dir);
    expect(config.validationCommands).toEqual(['npm test']);
    expect(config.baseBranch).toBe('main');
    expect(config.agentHarness).toEqual({ version: 1 });
  });

  describe('trusted config export', () => {
    it('exports .ai/agentic.config.json from the base revision, not the working tree', async () => {
      const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
      git('init', '-b', 'main');
      git('config', 'user.email', 't@t');
      git('config', 'user.name', 't');
      mkdirSync(join(dir, '.ai'), { recursive: true });
      writeFileSync(join(dir, '.ai', 'agentic.config.json'), '{"committed": true}', 'utf8');
      git('add', '.');
      git('commit', '-m', 'base');
      writeFileSync(join(dir, '.ai', 'agentic.config.json'), '{"committed": false}', 'utf8');

      const out = mkdtempSync(join(tmpdir(), 'cez-trusted-'));
      try {
        const snapshot = await exportTrustedConfig(dir, 'main', out);
        expect(snapshot).not.toBeNull();
        expect(JSON.parse(readFileSync(snapshot!.path, 'utf8'))).toEqual({ committed: true });
        expect(snapshot?.ref).toMatch(/^main@[0-9a-f]{7,}$/);
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    });

    it('returns null when the base revision has no config', async () => {
      const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
      git('init', '-b', 'main');
      git('config', 'user.email', 't@t');
      git('config', 'user.name', 't');
      writeFileSync(join(dir, 'README.md'), 'x', 'utf8');
      git('add', '.');
      git('commit', '-m', 'base');
      const out = mkdtempSync(join(tmpdir(), 'cez-trusted-'));
      try {
        expect(await exportTrustedConfig(dir, 'main', out)).toBeNull();
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    });
  });
});
