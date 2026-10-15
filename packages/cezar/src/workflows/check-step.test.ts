import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CHECK_OUTPUT_CAP,
  COMMAND_NOT_FOUND_HINT,
  CheckOutputBuffer,
  ENV_PASSTHROUGH_HINT,
  formatCheckFailure,
  killLiveChecks,
  runCheckCommand,
  stripAnsi,
  type CheckResult,
} from './check-step.ts';

const lines = (n: number, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i}\n`).join('');

describe('CheckOutputBuffer', () => {
  it('keeps output under the cap untouched', () => {
    const b = new CheckOutputBuffer();
    b.append('a\n');
    b.append('b\n');
    expect(b.text()).toBe('a\nb\n');
  });

  it('holds a 200 KB single-chunk burst to the cap, head and tail on line boundaries', () => {
    const burst = `${lines(6000, 'noise')}AssertionError: expected 1 to be 2\n`;
    expect(burst.length).toBeGreaterThan(60_000);
    const b = new CheckOutputBuffer();
    b.append(burst.repeat(3));
    const text = b.text();
    expect(text.length).toBeLessThanOrEqual(CHECK_OUTPUT_CAP);
    expect(text.startsWith('noise 0\n')).toBe(true);
    expect(text.endsWith('AssertionError: expected 1 to be 2\n')).toBe(true);
    expect(text.match(/^… \d+ lines omitted …$/gm)).toHaveLength(1);
    for (const line of text.split('\n').filter(Boolean)) {
      expect(line).toMatch(/^(noise \d+|AssertionError: expected 1 to be 2|… \d+ lines omitted …)$/);
    }
  });

  it('counts the omitted lines exactly', () => {
    const b = new CheckOutputBuffer(1000);
    for (let i = 0; i < 500; i++) b.append(`row ${String(i).padStart(4, '0')}\n`);
    const text = b.text();
    const kept = text.split('\n').filter((l) => l.startsWith('row ')).length;
    const omitted = Number(/… (\d+) lines omitted …/.exec(text)?.[1]);
    expect(kept + omitted).toBe(500);
  });

  it('counts one long line dropped across two trims once', () => {
    const b = new CheckOutputBuffer(1000);
    b.append('a\n');
    b.append('x'.repeat(3000));
    b.append('end\n');
    expect(b.text()).toMatch(/… 1 lines omitted …/);
  });

  it('stays bounded while many small chunks stream in', () => {
    const b = new CheckOutputBuffer();
    for (let i = 0; i < 20_000; i++) b.append(`chunk ${i}\n`);
    expect(b.text().length).toBeLessThanOrEqual(CHECK_OUTPUT_CAP);
    expect(b.text().endsWith('chunk 19999\n')).toBe(true);
  });
});

describe('stripAnsi', () => {
  it('removes colour, cursor, OSC hyperlink and an unfinished trailing sequence', () => {
    const raw = '\u001b[31mFAIL\u001b[0m a\u001b[2K\u001b]8;;http://x\u0007link\u001b]8;;\u0007 end\u001b[0';
    expect(stripAnsi(raw)).toBe('FAIL alink end');
  });

  it('turns carriage-return progress redraws into lines', () => {
    expect(stripAnsi('10%\r50%\r100%\r\ndone')).toBe('10%\n50%\n100%\r\ndone');
  });
});

describe('formatCheckFailure', () => {
  it('names the command and exit code and strips ANSI from the output', () => {
    const text = formatCheckFailure('npm test', { ok: false, exitCode: 1, output: '\u001b[31mboom\u001b[0m', timedOut: false }, 1000);
    expect(text).toBe(`$ npm test\n(exit code 1)\n${ENV_PASSTHROUGH_HINT}\n\nboom`);
  });

  it('hints at CEZ_ENV_PASSTHROUGH on any failure, so a dropped variable is not silent', () => {
    const text = formatCheckFailure('npm test', { ok: false, exitCode: 3, output: 'ECONNREFUSED', timedOut: false }, 1000);
    expect(text).toContain(ENV_PASSTHROUGH_HINT);
    expect(ENV_PASSTHROUGH_HINT).toContain('CEZ_ENV_PASSTHROUGH');
  });

  it('points a command-not-found exit at PATH and CEZ_ENV_PASSTHROUGH', () => {
    const text = formatCheckFailure('pnpm test', { ok: false, exitCode: 127, output: 'bash: pnpm: command not found', timedOut: false }, 1000);
    expect(text).toBe(`$ pnpm test\n(exit code 127)\n${COMMAND_NOT_FOUND_HINT}\n\nbash: pnpm: command not found`);
    expect(COMMAND_NOT_FOUND_HINT).toContain('PATH');
    expect(COMMAND_NOT_FOUND_HINT).toContain('CEZ_ENV_PASSTHROUGH');
  });

  it('says a timed-out check was killed', () => {
    const text = formatCheckFailure('sleep 600', { ok: false, exitCode: -1, output: '(no output)', timedOut: true }, 1_800_000);
    expect(text).toContain('(timed out after 30 min and was killed)');
  });
});

describe('runCheckCommand', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'cez-check-'));
    dirs.push(d);
    return d;
  };
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it('passes and fails on the exit code', async () => {
    const cwd = tmp();
    expect((await runCheckCommand({ command: 'echo ok', cwd, env: process.env }).result).ok).toBe(true);
    const failed = await runCheckCommand({ command: 'echo nope >&2; exit 3', cwd, env: process.env }).result;
    expect(failed).toMatchObject({ ok: false, exitCode: 3, output: 'nope', timedOut: false });
  });

  it.skipIf(process.platform === 'win32')('kills the whole process tree of a hung check at its timeout', async () => {
    const cwd = tmp();
    const pidFile = join(cwd, 'bg.pid');
    const result = await runCheckCommand({
      command: `sleep 600 & echo $! > ${pidFile}; sleep 600`,
      cwd,
      env: process.env,
      timeoutMs: 300,
    }).result;
    expect(result).toMatchObject({ ok: false, timedOut: true });
    const bg = Number(readFileSync(pidFile, 'utf8').trim());
    await new Promise((r) => setTimeout(r, 100));
    expect(alive(bg)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('kill() reaches a grandchild too', async () => {
    const cwd = tmp();
    const pidFile = join(cwd, 'bg.pid');
    const check = runCheckCommand({ command: `sleep 600 & echo $! > ${pidFile}; wait`, cwd, env: process.env });
    const deadline = Date.now() + 5000;
    while (!existsSync(pidFile) || !readFileSync(pidFile, 'utf8').trim()) {
      if (Date.now() > deadline) throw new Error('pid file never written');
      await new Promise((r) => setTimeout(r, 20));
    }
    check.kill();
    const result = await check.result;
    expect(result.ok).toBe(false);
    await new Promise((r) => setTimeout(r, 100));
    expect(alive(Number(readFileSync(pidFile, 'utf8').trim()))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'settles when bash exits but a backgrounded process still holds the output pipe',
    async () => {
      const cwd = tmp();
      const result = await runCheckCommand({ command: 'sleep 600 & echo done', cwd, env: process.env }).result;
      expect(result).toMatchObject({ ok: true, output: 'done', timedOut: false });
    },
    30_000,
  );

  it.skipIf(process.platform === 'win32')(
    'killLiveChecks still reaches a backgrounded process after bash exits',
    async () => {
      const cwd = tmp();
      const pidFile = join(cwd, 'bg.pid');
      const check = runCheckCommand({ command: `sleep 30 & echo $! > ${pidFile}`, cwd, env: process.env });
      const deadline = Date.now() + 5000;
      while (!existsSync(pidFile) || !readFileSync(pidFile, 'utf8').trim()) {
        if (Date.now() > deadline) throw new Error('pid file never written');
        await new Promise((r) => setTimeout(r, 20));
      }
      // Let bash's exit event settle, so the group is exactly where it is between that exit and
      // the 5 s orphan reap — still within the window cezar's exit-time kill has to cover.
      await new Promise((r) => setTimeout(r, 250));
      killLiveChecks();
      const bg = Number(readFileSync(pidFile, 'utf8').trim());
      const goneBy = Date.now() + 1000;
      while (alive(bg) && Date.now() < goneBy) await new Promise((r) => setTimeout(r, 20));
      expect(alive(bg)).toBe(false);
      await check.result;
    },
    20_000,
  );

  it.skipIf(process.platform === 'win32')(
    'settles at its bound when a process left the group and still held the pipe',
    async () => {
      const cwd = tmp();
      const pidFile = join(cwd, 'detached.pid');
      // `detached: true` makes the grandchild a session/group leader, so the check's group kill
      // cannot reach it, while it still inherits the check's stdout pipe.
      const script = [
        'const { spawn } = require("node:child_process");',
        'const { writeFileSync } = require("node:fs");',
        'const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "inherit" });',
        'child.unref();',
        `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
        'console.log("done");',
      ].join(' ');
      const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
      let result: CheckResult | undefined;
      try {
        result = await Promise.race([
          runCheckCommand({ command, cwd, env: process.env, timeoutMs: 300 }).result,
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('check never settled')), 8000).unref?.();
          }),
        ]);
      } finally {
        if (existsSync(pidFile)) {
          try {
            process.kill(Number(readFileSync(pidFile, 'utf8').trim()), 'SIGKILL');
          } catch {
            // already gone
          }
        }
      }
      expect(result).toMatchObject({ ok: false, exitCode: 0, timedOut: true });
    },
    20_000,
  );

  it.skipIf(process.platform === 'win32')(
    'releases the output pipes on a hard settle, so a headless run can exit',
    () => {
      const dir = tmp();
      const pidFile = join(dir, 'desc.pid');
      const hostScript = join(dir, 'host.mts');
      const module = fileURLToPath(new URL('./check-step.ts', import.meta.url));
      // The descendant is detached (its own session) and inherits the check's stdout/stderr, so it
      // survives the group kill and holds the pipes open; the host deliberately never kills it and
      // never calls process.exit, so the only way the host settles to an empty event loop is if
      // finishing the check destroyed the pipes.
      const inner = [
        'const { spawn } = require("node:child_process");',
        'const { writeFileSync } = require("node:fs");',
        'const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "inherit" });',
        'child.unref();',
        `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
        'console.log("done");',
      ].join(' ');
      writeFileSync(
        hostScript,
        [
          `import { runCheckCommand } from ${JSON.stringify(module)};`,
          `const command = process.execPath + ' -e ' + JSON.stringify(${JSON.stringify(inner)});`,
          `await runCheckCommand({ command, cwd: ${JSON.stringify(dir)}, env: process.env, timeoutMs: 300 }).result;`,
          `console.log('HOST_SETTLED');`,
        ].join('\n'),
      );
      const tsx = fileURLToPath(new URL('../../../../node_modules/.bin/tsx', import.meta.url));
      let host;
      try {
        host = spawnSync(tsx, [hostScript], { encoding: 'utf8', timeout: 12_000 });
      } finally {
        if (existsSync(pidFile)) {
          try {
            process.kill(Number(readFileSync(pidFile, 'utf8').trim()), 'SIGKILL');
          } catch {
            // already gone
          }
        }
      }
      expect(host.error).toBeUndefined();
      expect(host.stdout).toContain('HOST_SETTLED');
    },
    30_000,
  );

  it.skipIf(process.platform === 'win32').each(['process.exit(0)', "throw new Error('crash')"])(
    'kills a running check and its grandchild when cezar ends with %s',
    (ending) => {
      const dir = tmp();
      const pidFile = join(dir, 'bg.pid');
      const script = join(dir, 'host.mts');
      const module = fileURLToPath(new URL('./check-step.ts', import.meta.url));
      writeFileSync(
        script,
        [
          `import { existsSync, readFileSync } from 'node:fs';`,
          `import { runCheckCommand } from ${JSON.stringify(module)};`,
          `runCheckCommand({ command: ${JSON.stringify(`sleep 600 & echo $! > ${pidFile}; wait`)}, cwd: ${JSON.stringify(dir)}, env: process.env });`,
          `const poll = setInterval(() => {`,
          `  if (!existsSync(${JSON.stringify(pidFile)}) || !readFileSync(${JSON.stringify(pidFile)}, 'utf8').trim()) return;`,
          `  clearInterval(poll);`,
          `  ${ending};`,
          `}, 20);`,
        ].join('\n'),
      );
      const tsx = fileURLToPath(new URL('../../../../node_modules/.bin/tsx', import.meta.url));
      const host = spawnSync(tsx, [script], { encoding: 'utf8', timeout: 60_000 });
      expect(host.error).toBeUndefined();
      const bg = Number(readFileSync(pidFile, 'utf8').trim());
      expect(bg).toBeGreaterThan(0);
      let dead = !alive(bg);
      for (let i = 0; i < 50 && !dead; i++) {
        spawnSync('sleep', ['0.1']);
        dead = !alive(bg);
      }
      if (!dead) process.kill(bg, 'SIGKILL');
      expect(dead).toBe(true);
    },
    90_000,
  );
});
