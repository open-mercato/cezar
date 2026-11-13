import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OpencodeServerRunner } from './opencode-server-runner.ts';

/** #1498 — real processes: a launcher shim that spawns the server as a SIGTERM-ignoring child. */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      for (const f of ['launcher', 'grand']) process.kill(Number(readFileSync(join(d, `${f}.pid`), 'utf8')), 'SIGKILL');
    } catch {
      /* gone */
    }
    rmSync(d, { recursive: true, force: true });
  }
});
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (fn: () => boolean, ms = 8_000) => {
  for (const t = Date.now(); Date.now() - t < ms && !fn(); ) await new Promise((r) => setTimeout(r, 50));
};

function shim(): { bin: string; pids: () => { launcher: number; grand: number } } {
  const d = mkdtempSync(join(tmpdir(), 'cez-oc-shim-'));
  dirs.push(d);
  const bin = join(d, 'opencode');
  writeFileSync(
    bin,
    `#!${process.execPath}
const {spawn}=require('node:child_process'),fs=require('node:fs');
const g=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});
fs.writeFileSync(${JSON.stringify(join(d, 'grand.pid'))},String(g.pid));
fs.writeFileSync(${JSON.stringify(join(d, 'launcher.pid'))},String(process.pid));
process.on('SIGTERM',()=>{});setInterval(()=>{},1000);
`,
  );
  chmodSync(bin, 0o755);
  const read = (f: string) => Number(readFileSync(join(d, `${f}.pid`), 'utf8'));
  return { bin, pids: () => ({ launcher: read('launcher'), grand: read('grand') }) };
}

describe.skipIf(process.platform !== 'linux')('opencode server teardown (#1498)', () => {
  it('cancel kills the launcher AND the server it spawned', async () => {
    const s = shim();
    const runner = new OpencodeServerRunner({ bin: s.bin });
    const session = runner.startSession({ prompt: 'x', cwd: tmpdir() } as never);
    await until(() => { try { return s.pids().grand > 0; } catch { return false; } });
    const { launcher, grand } = s.pids();
    expect(alive(launcher) && alive(grand)).toBe(true);
    session.interrupt();
    await until(() => !alive(launcher) && !alive(grand), 10_000);
    expect(alive(launcher)).toBe(false);
    expect(alive(grand)).toBe(false);
    await session.result;
  }, 20_000);

  it('runner.interrupt() reaches every live session, not only the last (Continue)', async () => {
    const a = shim();
    const b = shim();
    const runnerA = new OpencodeServerRunner({ bin: a.bin });
    const first = runnerA.startSession({ prompt: 'x', cwd: tmpdir() } as never);
    await until(() => { try { return a.pids().grand > 0; } catch { return false; } });
    // Continue on the same runner: a second session; the first must not be orphaned.
    (runnerA as unknown as { bin: string }).bin = b.bin;
    const second = runnerA.startSession({ prompt: 'y', cwd: tmpdir() } as never);
    await until(() => { try { return b.pids().grand > 0; } catch { return false; } });
    const pa = a.pids();
    const pb = b.pids();
    await runnerA.interrupt();
    await until(() => ![pa.launcher, pa.grand, pb.launcher, pb.grand].some(alive), 10_000);
    expect([pa.launcher, pa.grand, pb.launcher, pb.grand].filter(alive)).toEqual([]);
    await Promise.all([first.result, second.result]);
  }, 25_000);
});
