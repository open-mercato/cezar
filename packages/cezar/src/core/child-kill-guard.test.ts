import { ChildProcess, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { guardChildProcessKill, hasSignallablePid } from './child-kill-guard.ts';

const guardModule = JSON.stringify(join(dirname(fileURLToPath(import.meta.url)), 'child-kill-guard.ts'));

/**
 * Runs `body` as the leader of a fresh process group (`detached`), beside a `sleep` in the same
 * group — the stand-in for the desktop app that shares a check step's group. Resolves with how
 * the leader ended.
 */
function inOwnGroup(body: string): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string }> {
  const script = `import { spawn } from 'node:child_process';
const sibling = spawn('sleep', ['30'], { stdio: 'ignore' });
${body}
const child = spawn('cez-no-such-binary-guard-test');
child.on('error', () => {});
child.kill('SIGKILL');
setTimeout(() => { sibling.kill(); console.log('survived'); }, 200);`;
  return new Promise((resolve, reject) => {
    const leader = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    leader.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    leader.on('error', reject);
    leader.on('close', (code, signal) => resolve({ code, signal, stdout }));
  });
}

describe('guardChildProcessKill', () => {
  it('treats only a started child as signallable', () => {
    expect(hasSignallablePid({ pid: 4242 })).toBe(true);
    for (const pid of [undefined, 0, -1, Number.NaN]) expect(hasSignallablePid({ pid })).toBe(false);
  });

  it('is installed once', () => {
    guardChildProcessKill();
    const kill = ChildProcess.prototype.kill;
    expect(guardChildProcessKill()).toBe(false);
    expect(ChildProcess.prototype.kill).toBe(kill);
  });

  // Real process groups: the hazard is POSIX `kill(0)`; Windows has no process group.
  describe.skipIf(process.platform === 'win32')('a child whose spawn failed', () => {
    it('documented: unguarded, its kill() SIGKILLs the caller\'s whole process group', async (ctx) => {
      const ended = await inOwnGroup('');
      // A runtime whose libuv no longer sends kill(0) (Node 24.22, 26.13) has no hazard to document.
      if (ended.signal === null && ended.stdout === 'survived\n') ctx.skip(`Node ${process.version} has no failed-spawn group kill`);
      expect(ended.signal).toBe('SIGKILL');
      expect(ended.stdout).not.toContain('survived');
    });

    it('guarded, its kill() is a no-op and the group lives on', async () => {
      const ended = await inOwnGroup(`const { guardChildProcessKill } = await import(${guardModule}); guardChildProcessKill();`);
      expect(ended).toEqual({ code: 0, signal: null, stdout: 'survived\n' });
    });
  });
});
