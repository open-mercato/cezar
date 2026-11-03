import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadPty } from './pty-module.ts';
import { TerminalSessions } from './sessions.ts';
import { discoverShells } from './shells.ts';

/**
 * Spec `.ai/specs/2026-10-07-task-workspace.md` §6 against a REAL shell: "stops its process tree".
 * Interactive bash puts every job in its own process group, which a fake PTY cannot show.
 * Skips cleanly without node-pty, bash or `ps`.
 */
const BASH = '/bin/bash';
const binding = await loadPty();
const psWorks = (() => {
  try {
    execFileSync('ps', ['-axo', 'pid=,command='], { stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
})();
const usable =
  process.platform !== 'win32' && binding.available && psWorks && existsSync(BASH) && discoverShells().includes(BASH);

/** Pids of `sleep <marker>` — the marker is a unique duration, so nothing else matches. */
const pidsOf = (marker: string): number[] =>
  execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    .split('\n')
    .map((line) => /^\s*(\d+)\s+sleep (\d+)\s*$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null && match[2] === marker)
    .map((match) => Number(match[1]));

const until = async (condition: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

describe.skipIf(!usable)('stopping a real shell stops its whole process tree (spec §6)', () => {
  let sessions: TerminalSessions;
  let cwd: string;
  let marker: string;

  beforeEach(() => {
    sessions = new TerminalSessions();
    cwd = mkdtempSync(join(tmpdir(), 'cez-pty-tree-'));
    // Nine digits: unique enough to be nobody else's, and under the 2^31 s macOS `sleep` accepts.
    marker = `1${String(process.pid % 1000).padStart(3, '0')}${String(Math.floor(Math.random() * 1e5)).padStart(5, '0')}`;
  });

  afterEach(() => {
    sessions.dispose();
    // Whatever the case under test left behind dies here, pass or fail.
    for (const pid of pidsOf(marker)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    rmSync(cwd, { recursive: true, force: true });
  });

  const start = async (command: string): Promise<string> => {
    const created = await sessions.create({ runId: 'run-real', cwd, shell: BASH });
    if (!created.ok) throw new Error(created.reason);
    sessions.write(created.session.id, `${command}\n`);
    const started = await until(() => pidsOf(marker).length > 0, 20_000);
    // The shell's own words are the only useful diagnosis when a job fails to start.
    expect(started, `the job never started: ${JSON.stringify(sessions.read(created.session.id, 0))}`).toBe(true);
    return created.session.id;
  };

  it('closeAll() reaps a backgrounded job, which sits in its own process group', async () => {
    await start(`sleep ${marker} &`);
    sessions.closeAll();
    expect(await until(() => pidsOf(marker).length === 0, 8_000), 'the job outlived closeAll()').toBe(true);
  }, 40_000);

  it('kill() reaps a foreground job that ignores SIGHUP', async () => {
    const id = await start(`(trap '' HUP; sleep ${marker})`);
    sessions.kill(id);
    expect(await until(() => pidsOf(marker).length === 0, 8_000), 'the job outlived kill()').toBe(true);
  }, 40_000);

  it('kill() reaps a nohup background job', async () => {
    const id = await start(`nohup sleep ${marker} >/dev/null 2>&1 &`);
    sessions.kill(id);
    expect(await until(() => pidsOf(marker).length === 0, 8_000), 'the job outlived kill()').toBe(true);
  }, 40_000);
});
