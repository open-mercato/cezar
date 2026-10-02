import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CHECK_OUTPUT_CAP,
  capCheckOutput,
  checkTruncationMarker,
  resolveBash,
  runCheckCommand,
} from './check-runner.ts';

/**
 * The check seam (#landing-check S1). Everything here needs a real shell and a
 * real process group, so the file is POSIX-only: win32 is exercised through the
 * injected `platform`, which is also the only way to test it without a Windows
 * box (there is no Windows CI — `packages/cezar/src/workflows/check-runner.ts`
 * refuses win32 deterministically rather than spawning something untested).
 */
const posix = describe.skipIf(process.platform === 'win32');

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'cez-check-runner-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Poll `alive` down, so a SIGKILL delivered a tick later does not flake. */
const waitUntilDead = async (pid: number, ms = 4_000): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !alive(pid);
};

const readPid = (file: string): number => Number(readFileSync(join(cwd, file), 'utf8').trim());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('capCheckOutput — the tail is kept', () => {
  it('leaves short output alone', () => {
    expect(capCheckOutput('all good', 100)).toBe('all good');
  });

  it('keeps the END of a long transcript and says how much was elided', () => {
    const text = `${'head\n'.repeat(50)}THE FAILURE LINE`;
    const capped = capCheckOutput(text, 40);
    expect(capped).toContain('THE FAILURE LINE');
    expect(capped).toContain(checkTruncationMarker(text.length - 40));
    expect(capped.startsWith('head')).toBe(false);
  });

  it('accounts for characters that a rolling collector already dropped', () => {
    const capped = capCheckOutput('…tail…', 5, 5_000);
    expect(capped).toContain(checkTruncationMarker(4_995));
  });
});

describe('runCheckCommand — outcomes', () => {
  it('passes on exit 0 and fails on a non-zero exit, keeping both streams', async () => {
    const passed = await runCheckCommand({ cwd, command: 'echo out; echo err >&2; exit 0' });
    expect(passed.status).toBe('passed');
    expect(passed.ok).toBe(true);
    expect(passed.exitCode).toBe(0);
    expect(passed.output).toContain('out');
    expect(passed.output).toContain('err');

    const failed = await runCheckCommand({ cwd, command: 'echo broke >&2; exit 3' });
    expect(failed.status).toBe('failed');
    expect(failed.ok).toBe(false);
    expect(failed.exitCode).toBe(3);
    expect(failed.output).toContain('broke');
  });

  it('reports a spawn that cannot happen (missing cwd) as could-not-run, never as a pass', async () => {
    const outcome = await runCheckCommand({
      cwd: join(cwd, 'does-not-exist'),
      command: 'echo never',
    });
    expect(outcome.status).toBe('could-not-run');
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/could not run/);
  });
});

describe('runCheckCommand — wall clock', () => {
  it('kills a command that outlives the per-command limit and reports timed-out', async () => {
    const started = Date.now();
    const outcome = await runCheckCommand({
      cwd,
      command: `node -e "require('fs').writeFileSync('pid', String(process.pid)); setInterval(()=>{},1000)"`,
      timeoutMs: 400,
      graceMs: 200,
    });
    expect(outcome.status).toBe('timed-out');
    expect(outcome.ok).toBe(false);
    expect(outcome.exitCode).toBe(-1);
    expect(outcome.reason).toMatch(/timed out/);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await waitUntilDead(readPid('pid'))).toBe(true);
  });

  it('never fires the limit for a command that finishes first', async () => {
    const outcome = await runCheckCommand({ cwd, command: 'echo quick', timeoutMs: 5_000 });
    expect(outcome.status).toBe('passed');
  });

  it('bounds the whole gate, not just the command, when the deadline is nearer', async () => {
    const outcome = await runCheckCommand({
      cwd,
      command: 'sleep 30',
      timeoutMs: 60_000,
      gateDeadlineAt: Date.now() + 400,
      graceMs: 200,
    });
    expect(outcome.status).toBe('timed-out');
    expect(outcome.reason).toMatch(/whole-gate deadline/);
  });

  it('refuses to start when the gate deadline already expired', async () => {
    const outcome = await runCheckCommand({
      cwd,
      command: `node -e "require('fs').writeFileSync('ran', 'yes')"`,
      gateDeadlineAt: Date.now() - 1,
    });
    expect(outcome.status).toBe('timed-out');
    expect(outcome.output).toMatch(/nothing was run/);
    expect(existsSync(join(cwd, 'ran'))).toBe(false);
  });
});

/** A probe script on disk, so no shell quoting can hide a broken command. */
const writeProbe = (name: string, source: string): string => {
  writeFileSync(join(cwd, name), source);
  return `'${process.execPath}' ${name}`;
};

/** Writes its own pid, then a grandchild's pid, then hangs. The grandchild
 *  ignores SIGTERM, so only the SIGKILL half of the escalation can end it —
 *  the orphan the old `child.kill('SIGTERM')` left behind. */
const HOLDER_PROBE = `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const kid = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
fs.writeFileSync('grandchild', String(kid.pid));
fs.writeFileSync('pid', String(process.pid));
setInterval(() => {}, 1000);
`;

describe('runCheckCommand — the process group', () => {
  it('kills a grandchild that outlives the timed-out command, and ignores SIGTERM doing it', async () => {
    const command = writeProbe('holder.cjs', HOLDER_PROBE);
    const outcome = await runCheckCommand({ cwd, command, timeoutMs: 500, graceMs: 300 });
    expect(outcome.status).toBe('timed-out');
    expect(await waitUntilDead(readPid('pid'))).toBe(true);
    expect(await waitUntilDead(readPid('grandchild'))).toBe(true);
  }, 15_000);

  it('does not leave a backgrounded grandchild behind an otherwise successful command', async () => {
    const command = writeProbe(
      'leaver.cjs',
      `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const kid = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
fs.writeFileSync('grandchild', String(kid.pid));
// Exit 0 immediately, leaving the grandchild running: an un-unref'd child
// handle would otherwise keep this process alive, which is not the case under
// test. The transcript line is written synchronously so exiting cannot drop it.
fs.writeSync(1, 'command done\\n');
process.exit(0);
`,
    );
    const started = Date.now();
    const outcome = await runCheckCommand({ cwd, command, timeoutMs: 20_000, graceMs: 300 });
    // The command itself exited 0 — its leftover process must not change that,
    // but must not survive it either.
    expect(outcome.status).toBe('passed');
    expect(outcome.output).toContain('command done');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await waitUntilDead(readPid('grandchild'))).toBe(true);
  }, 15_000);

  it('kills the whole group on interrupt and resolves cancelled', async () => {
    const controller = new AbortController();
    const command = writeProbe('interrupted.cjs', HOLDER_PROBE);
    const pending = runCheckCommand({
      cwd,
      command,
      timeoutMs: 60_000,
      graceMs: 300,
      signal: controller.signal,
    });
    // Wait for the child to exist before interrupting it.
    const deadline = Date.now() + 5_000;
    while (!existsSync(join(cwd, 'pid')) && Date.now() < deadline) await sleep(25);
    expect(existsSync(join(cwd, 'pid'))).toBe(true);
    controller.abort();
    const outcome = await pending;
    expect(outcome.status).toBe('cancelled');
    expect(outcome.ok).toBe(false);
    expect(await waitUntilDead(readPid('pid'))).toBe(true);
    expect(await waitUntilDead(readPid('grandchild'))).toBe(true);
  }, 15_000);
});

describe('runCheckCommand — dry run', () => {
  it('spawns nothing and records a visible, non-green skip', async () => {
    const outcome = await runCheckCommand({
      cwd,
      command: `node -e "require('fs').writeFileSync('ran', 'yes')"`,
      dryRun: true,
    });
    expect(outcome.status).toBe('skipped');
    expect(outcome.ok).toBe(false);
    expect(outcome.output).toMatch(/CEZ_DRY_RUN=1/);
    expect(existsSync(join(cwd, 'ran'))).toBe(false);
  });

  it('follows CEZ_DRY_RUN from the environment when the caller says nothing', async () => {
    const saved = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    try {
      const outcome = await runCheckCommand({
        cwd,
        command: `node -e "require('fs').writeFileSync('ran', 'yes')"`,
      });
      expect(outcome.status).toBe('skipped');
      expect(existsSync(join(cwd, 'ran'))).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.CEZ_DRY_RUN;
      else process.env.CEZ_DRY_RUN = saved;
    }
  });
});

describe('runCheckCommand — platform and shell', () => {
  it('refuses win32 deterministically instead of spawning an untested shell', async () => {
    const outcome = await runCheckCommand({
      cwd,
      command: `node -e "require('fs').writeFileSync('ran', 'yes')"`,
      platform: 'win32',
    });
    expect(outcome.status).toBe('could-not-run');
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/POSIX/);
    expect(existsSync(join(cwd, 'ran'))).toBe(false);
  });

  it('reports a missing bash as could-not-run with the reason recorded', async () => {
    const outcome = await runCheckCommand({
      cwd,
      command: 'echo never',
      env: { PATH: join(cwd, 'empty-path') },
    });
    expect(outcome.status).toBe('could-not-run');
    expect(outcome.reason).toMatch(/no bash on PATH/);
  });

  it('resolveBash finds the real shell on PATH and nothing on an empty one', () => {
    expect(resolveBash({ PATH: '/definitely/not/here' })).toBeUndefined();
    const found = resolveBash(process.env);
    expect(found === undefined || found.endsWith('/bash')).toBe(true);
  });

  it('runs a non-login, non-interactive shell — no profile is sourced', async () => {
    const home = join(cwd, 'home');
    mkdirSync(home, { recursive: true });
    // A profile that would brand the environment if bash read it. `-lc` read it;
    // `--noprofile --norc -c` must not, or the minimal env is undone by the shell.
    writeFileSync(join(home, '.bash_profile'), 'export CHECK_PROFILE_PROBE=sourced\n');
    writeFileSync(join(home, '.bashrc'), 'export CHECK_PROFILE_PROBE=sourced\n');
    const outcome = await runCheckCommand({
      cwd,
      command: 'node -e "console.log(process.env.CHECK_PROFILE_PROBE ?? \'absent\')"',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home },
    });
    expect(outcome.status).toBe('passed');
    expect(outcome.output.trim()).toBe('absent');
  });
});

describe('runCheckCommand — the minimal check env by default', () => {
  it('drops gh/vendor/CEZ credentials from the child, and keeps the toolchain vars', async () => {
    const saved = {
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      NPM_TOKEN: process.env.NPM_TOKEN,
      CEZ_CHECK_PROBE: process.env.CEZ_CHECK_PROBE,
    };
    process.env.GITHUB_TOKEN = 'ghs_probe';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-probe';
    process.env.NPM_TOKEN = 'npm_probe';
    process.env.CEZ_CHECK_PROBE = 'cez_probe';
    try {
      const outcome = await runCheckCommand({
        cwd,
        command:
          'node -e "console.log(JSON.stringify({gh:process.env.GITHUB_TOKEN??null,anthropic:process.env.ANTHROPIC_API_KEY??null,npm:process.env.NPM_TOKEN??null,cez:process.env.CEZ_CHECK_PROBE??null,path:Boolean(process.env.PATH),home:Boolean(process.env.HOME)}))"',
      });
      expect(outcome.status).toBe('passed');
      expect(JSON.parse(outcome.output)).toEqual({
        gh: null,
        anthropic: null,
        npm: null,
        cez: null,
        path: true,
        home: true,
      });
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

posix('runCheckCommand — real shell integration', () => {
  it('keeps the tail of a long transcript, marker included', async () => {
    const outcome = await runCheckCommand({
      cwd,
      command:
        'node -e "process.stdout.write(\'x\'.repeat(30000) + \'\\\\nTHE-FAILURE-LINE\\\\n\')"',
      cap: CHECK_OUTPUT_CAP,
    });
    expect(outcome.status).toBe('passed');
    expect(outcome.output).toContain('THE-FAILURE-LINE');
    expect(outcome.output).toContain('characters elided at the head');
    expect(outcome.output.length).toBeLessThan(CHECK_OUTPUT_CAP + 200);
  });
});
