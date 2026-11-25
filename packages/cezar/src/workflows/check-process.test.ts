import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { liveCheckCount, signalCheck, spawnCheck } from './check-process.ts';

const checkModule = JSON.stringify(join(dirname(fileURLToPath(import.meta.url)), 'check-process.ts'));
const env = { ...process.env, BASH_ENV: '' };
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function output(command: string): Promise<{ text: string; pid: number; code: number | null }> {
  const child = spawnCheck(command, process.cwd(), env);
  let text = '';
  child.stdout.on('data', (chunk: Buffer) => { text += chunk.toString(); });
  const [code] = await once(child, 'close') as [number | null];
  return { text, pid: child.pid!, code };
}

describe.skipIf(process.platform === 'win32')('check processes', () => {
  it('run in a process group of their own', async () => {
    const own = execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim();
    const ran = await output('ps -o pgid= -p $$');
    expect(ran.code).toBe(0);
    expect(ran.text.trim()).toBe(String(ran.pid));
    expect(ran.text.trim()).not.toBe(own);
    expect(liveCheckCount()).toBe(0);
  });

  it('stop with everything they started', async () => {
    const child = spawnCheck('sleep 30 & echo $!; wait', process.cwd(), env);
    const [line] = await once(child.stdout, 'data') as [Buffer];
    const grandchild = Number(line.toString().trim());
    expect(alive(grandchild)).toBe(true);
    signalCheck(child, 'SIGTERM');
    await once(child, 'close');
    const deadline = Date.now() + 5_000;
    while (alive(grandchild) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(alive(grandchild)).toBe(false);
  });

  // The 2026-11-25 stops: a group kill from inside a check. Run under a throwaway group leader, so
  // a regression can only kill that leader, never this runner (or a cockpit around it).
  it('keep a group kill from inside the check away from the process that started it', async () => {
    const script = `const { spawnCheck } = await import(${checkModule});
const check = spawnCheck('kill -9 0', process.cwd(), process.env);
check.on('close', (code, signal) => console.log('check', signal, 'cezar survived'));`;
    const leader = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let text = '';
    leader.stdout.on('data', (chunk: Buffer) => { text += chunk.toString(); });
    const [code, signal] = await once(leader, 'close') as [number | null, NodeJS.Signals | null];
    expect({ code, signal, text }).toEqual({ code: 0, signal: null, text: 'check SIGKILL cezar survived\n' });
  });
});
