import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { procStart, signalServer, sweepOrphanedServers, trackServer } from './opencode-server-registry.ts';

const linux = process.platform === 'linux';
const pids: number[] = [];
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (fn: () => boolean) => {
  for (let i = 0; i < 100 && !fn(); i += 1) await new Promise((r) => setTimeout(r, 50));
};
afterEach(() => {
  for (const p of pids.splice(0)) {
    try {
      process.kill(-p, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
});

/** A launcher that spawns the "server" as its own child and ignores SIGTERM, like a shim. */
function fakeServer(port: number) {
  const script = `const {spawn}=require('node:child_process');process.on('SIGTERM',()=>{});
spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)','serve','--port','${port}'],{stdio:'ignore'});
setInterval(()=>{},1000)`;
  const child = spawn(process.execPath, ['-e', script, 'serve', '--port', String(port)], { detached: true, stdio: 'ignore' });
  pids.push(child.pid!);
  return child;
}

describe.skipIf(!linux)('opencode server registry (#1498)', () => {
  it('kills the whole process group, including the launcher grandchild, on SIGKILL', async () => {
    const child = fakeServer(41001);
    trackServer(child, 41001);
    await new Promise((r) => setTimeout(r, 300));
    const children = readdirSync('/proc').filter((d) => /^\d+$/.test(d) && procStart(Number(d)) && alive(Number(d)));
    const grand = children.map(Number).filter((p) => {
      try {
        return process.kill(p, 0) && readFileSync(`/proc/${p}/stat`, 'utf8').split(' ')[3] === String(child.pid);
      } catch {
        return false;
      }
    });
    expect(grand.length).toBe(1);
    signalServer(child, 'SIGKILL');
    await until(() => !alive(child.pid!) && !alive(grand[0]!));
    expect(alive(child.pid!)).toBe(false);
    expect(alive(grand[0]!)).toBe(false);
  });

  it('sweeps a server whose owner is dead, never a live-owner or unrecorded one', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cez-sweep-'));
    const prev = process.env.CEZ_HOME;
    process.env.CEZ_HOME = home;
    try {
      const orphan = fakeServer(41002);
      const owned = fakeServer(41003);
      const stranger = fakeServer(41004); // the user's own, never recorded
      await new Promise((r) => setTimeout(r, 200));
      const dir = join(home, 'opencode-servers');
      mkdirSync(dir, { recursive: true });
      const rec = (c: typeof orphan, port: number, ownerPid: number, ownerStart: string) =>
        writeFileSync(join(dir, `${c.pid}.json`), JSON.stringify({ pid: c.pid, start: procStart(c.pid!), ownerPid, ownerStart, port }));
      rec(orphan, 41002, 999999, '1');
      rec(owned, 41003, process.ppid, procStart(process.ppid) ?? '');
      expect(sweepOrphanedServers()).toEqual([orphan.pid]);
      await until(() => !alive(orphan.pid!));
      expect(alive(orphan.pid!)).toBe(false);
      expect(alive(owned.pid!)).toBe(true);
      expect(alive(stranger.pid!)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.CEZ_HOME;
      else process.env.CEZ_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a corrupt or malformed registry never throws and is dropped; a normal exit removes the record', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cez-sweep-'));
    const prev = process.env.CEZ_HOME;
    process.env.CEZ_HOME = home;
    try {
      const dir = join(home, 'opencode-servers');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, '1.json'), '{not json');
      writeFileSync(join(dir, '2.json'), '{}');
      writeFileSync(join(dir, '3.json'), JSON.stringify({ pid: 1, start: '1', ownerPid: 999999, ownerStart: '1', port: 1 }));
      expect(sweepOrphanedServers()).toEqual([]);
      expect(readdirSync(dir)).toEqual([]);
      rmSync(dir, { recursive: true });
      expect(sweepOrphanedServers()).toEqual([]);

      const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},300)'], { detached: true, stdio: 'ignore' });
      pids.push(child.pid!);
      trackServer(child, 41005);
      const file = join(dir, `${child.pid}.json`);
      expect(existsSync(file)).toBe(true);
      await until(() => !existsSync(file));
      expect(existsSync(file)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.CEZ_HOME;
      else process.env.CEZ_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
