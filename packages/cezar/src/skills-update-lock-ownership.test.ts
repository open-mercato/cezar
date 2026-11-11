import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkillsUpdateConflictError, SkillsUpdateService } from './skills-update.ts';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const roots: string[] = [];
const oldDryRun = process.env.CEZ_DRY_RUN;
afterEach(async () => {
  vi.restoreAllMocks();
  if (oldDryRun === undefined) delete process.env.CEZ_DRY_RUN;
  else process.env.CEZ_DRY_RUN = oldDryRun;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  process.env.CEZ_DRY_RUN = '0';
  const root = await mkdtemp(join(tmpdir(), 'cez-skills-ownership-'));
  roots.push(root);
  const home = join(root, 'home'); const repo = join(root, 'repo');
  const path = join(home, '.cache', 'cez', 'skills-update.lock');
  await mkdir(join(home, '.cache', 'cez'), { recursive: true });
  await mkdir(repo);
  await writeFile(join(repo, 'skills-lock.json'), JSON.stringify({ skills: { om: { source: 'open-mercato/skills' } } }));
  return { home, repo, path };
}

type LockReader = { readLockMetadata(path: string): Promise<{ timestamp: number; alive: boolean }> };

describe('skills-update lock ownership (CodeQL30)', () => {
  it('serializes stale reclaimers before either can remove a successor lock', async () => {
    const { home, repo, path } = await fixture();
    await writeFile(path, '99999999\n0\n');
    const read = gate(); const resume = gate(); const finish = gate(); const enteredSecond = gate();
    let running = 0; let peak = 0;
    const firstRun = vi.fn(async () => {
      peak = Math.max(peak, ++running); running -= 1;
      return { stdout: '', stderr: '' };
    });
    const secondRun = vi.fn(async () => {
      peak = Math.max(peak, ++running); enteredSecond.resolve();
      await finish.promise; running -= 1; return { stdout: '', stderr: '' };
    });
    const first = new SkillsUpdateService({ homeDir: home, resolveNpx: async () => '/npx', run: firstRun });
    const second = new SkillsUpdateService({ homeDir: home, resolveNpx: async () => '/npx', run: secondRun });
    const reader = first as unknown as LockReader;
    const original = reader.readLockMetadata.bind(first);
    vi.spyOn(reader, 'readLockMetadata').mockImplementation(async (lockPath) => {
      const metadata = await original(lockPath);
      read.resolve(); await resume.promise;
      return metadata;
    });
    const active = first.check(repo, true);
    let contender: Promise<unknown> | undefined;
    try {
      await read.promise;
      contender = second.check(repo, true);
      // The contender either refuses the guard or enters its command; both are observable.
      await Promise.race([contender, enteredSecond.promise]);
      resume.resolve();
      expect((await active).status).toBe('current');
      expect(peak).toBe(1);
      expect(secondRun).not.toHaveBeenCalled();
      expect((await contender as { status: string }).status).toBe('unavailable');
      expect(firstRun).toHaveBeenCalledOnce();
    } finally {
      resume.resolve(); finish.resolve();
      await Promise.allSettled([active, ...(contender ? [contender] : [])]);
    }
  });

  it('an expired owner cannot release the lock acquired by its successor', async () => {
    const { home, repo, path } = await fixture();
    let now = Date.now();
    const enteredFirst = gate(); const finishFirst = gate();
    const enteredSecond = gate(); const finishSecond = gate();
    const first = new SkillsUpdateService({ homeDir: home, now: () => now, resolveNpx: async () => '/npx', run: async () => {
      enteredFirst.resolve(); await finishFirst.promise; return { stdout: '', stderr: '' };
    } });
    const second = new SkillsUpdateService({ homeDir: home, now: () => now, resolveNpx: async () => '/npx', run: async () => {
      enteredSecond.resolve(); await finishSecond.promise; return { stdout: '', stderr: '' };
    } });
    const thirdRun = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const third = new SkillsUpdateService({ homeDir: home, now: () => now, resolveNpx: async () => '/npx', run: thirdRun });
    const active = first.check(repo, true);
    let successor: Promise<unknown> | undefined;
    try {
      await enteredFirst.promise;
      now += 120_001;
      successor = second.check(repo, true);
      await enteredSecond.promise;
      const owned = await readFile(path, 'utf8');
      finishFirst.resolve(); await active;
      await expect(readFile(path, 'utf8')).resolves.toBe(owned);
      expect((await third.check(repo, true)).status).toBe('unavailable');
      expect(thirdRun).not.toHaveBeenCalled();
    } finally {
      finishFirst.resolve(); finishSecond.resolve();
      await Promise.allSettled([active, ...(successor ? [successor] : [])]);
    }
  });

  it('preserves the inclusive two-minute live legacy boundary and dead-owner recovery', async () => {
    const { home, repo, path } = await fixture();
    const timestamp = Date.now() - 120_000;
    let now = timestamp + 120_000;
    const run = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const service = new SkillsUpdateService({ homeDir: home, now: () => now, resolveNpx: async () => '/npx', run });
    await writeFile(path, `${process.pid}\n${timestamp}\n`);
    await expect(service.update(repo, true)).rejects.toBeInstanceOf(SkillsUpdateConflictError);
    expect(run).not.toHaveBeenCalled();
    now += 1;
    expect((await service.update(repo, true)).status).toBe('current');
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(path, `99999999\n${now}\n`);
    expect((await service.check(repo, true)).status).toBe('current');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('degrades a failed mutation guard without starting a command', async () => {
    const { home, repo, path } = await fixture();
    await writeFile(`${path}.guard`, 'not a lock directory');
    const run = vi.fn();
    const state = await new SkillsUpdateService({ homeDir: home, resolveNpx: async () => '/npx', run }).check(repo, true);
    expect(state.status).toBe('unavailable');
    expect(run).not.toHaveBeenCalled();
  });

  it('recovers dead choosing, ticket, staged and released claims by unique name', async () => {
    const { home, repo, path } = await fixture();
    const directory = `${path}.guard`;
    await mkdir(directory);
    const id = '00000000-0000-4000-8000-000000000000';
    await writeFile(join(directory, `99999999-${id}`), '');
    await writeFile(join(directory, `99999998-${id}`), '5');
    await writeFile(join(directory, `99999998-${id}.tmp`), '6');
    await writeFile(join(directory, `${process.pid}-${id}`), 'released');
    await writeFile(join(directory, '.DS_Store'), 'unrelated cache content');
    const run = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const state = await new SkillsUpdateService({ homeDir: home, resolveNpx: async () => '/npx', run }).check(repo, true);
    expect(state.status).toBe('current');
    expect(run).toHaveBeenCalledOnce();
    expect(await readdir(directory)).toEqual(['.DS_Store']);
  });

  it('never expires a live mutator based on the age of its claim or guard directory', async () => {
    const { home, repo, path } = await fixture();
    const directory = `${path}.guard`;
    await mkdir(directory);
    const claim = join(directory, `${process.pid}-00000000-0000-4000-8000-000000000000`);
    await writeFile(claim, '1');
    const old = new Date(0); await utimes(claim, old, old); await utimes(directory, old, old);
    const run = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const service = new SkillsUpdateService({ homeDir: home, resolveNpx: async () => '/npx', run });
    expect((await service.check(repo, true)).status).toBe('unavailable');
    expect(run).not.toHaveBeenCalled();
    await expect(readFile(claim, 'utf8')).resolves.toBe('1');
    await rm(claim);
    expect((await service.check(repo, true)).status).toBe('current');
    expect(run).toHaveBeenCalledOnce();
  });

  it('treats EPERM from a claim liveness probe as an active owner', async () => {
    const { home, repo, path } = await fixture();
    await mkdir(`${path}.guard`);
    const claim = join(`${path}.guard`, '99999999-00000000-0000-4000-8000-000000000000');
    await writeFile(claim, '1');
    const original = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === 99999999) throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
      return original(pid, signal);
    });
    const run = vi.fn();
    expect((await new SkillsUpdateService({ homeDir: home, resolveNpx: async () => '/npx', run }).check(repo, true)).status).toBe('unavailable');
    expect(run).not.toHaveBeenCalled();
    await expect(readFile(claim, 'utf8')).resolves.toBe('1');
  });

  it('keeps a separate Node process excluded while the current process holds the lock', async () => {
    const { home, repo } = await fixture();
    const finish = gate(); const entered = gate();
    const service = new SkillsUpdateService({ homeDir: home, resolveNpx: async () => '/npx', run: async () => {
      entered.resolve(); await finish.promise; return { stdout: '', stderr: '' };
    } });
    const active = service.check(repo, true);
    let child: ReturnType<typeof spawn> | undefined;
    try {
      await entered.promise;
      const source = new URL('./skills-update.ts', import.meta.url).href;
      const script = `import { SkillsUpdateService } from ${JSON.stringify(source)};
        const service = new SkillsUpdateService({homeDir:${JSON.stringify(home)},resolveNpx:async()=>'/npx',run:async()=>{throw new Error('unexpected command')}});
        const result = await service.check(${JSON.stringify(repo)}, true); console.log(result.status);`;
      child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
        stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CEZ_DRY_RUN: '0' }, timeout: 5_000, killSignal: 'SIGKILL',
      });
      let output = ''; let errors = '';
      child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
      child.stderr?.on('data', (chunk: Buffer) => { errors += chunk.toString(); });
      const code = await new Promise<number | null>((resolve, reject) => { child!.once('exit', resolve); child!.once('error', reject); });
      expect(code, errors).toBe(0);
      expect(output.trim()).toBe('unavailable');
    } finally {
      if (child && child.exitCode === null) child.kill('SIGKILL');
      finish.resolve(); await active;
    }
  }, 15_000);

  it('two real processes recovering an abandoned guard cannot remove a successor (M1)', async () => {
    const { home, repo, path } = await fixture();
    await writeFile(path, '99999999\n0\n');
    await mkdir(`${path}.guard`);
    const expired = new Date(Date.now() - 130_000);
    await utimes(`${path}.guard`, expired, expired);
    const source = new URL('./skills-update.ts', import.meta.url).href;
    const packageUrl = new URL('../../../package.json', import.meta.url).href;
    type Worker = { child: ReturnType<typeof spawn>; closed: Promise<void>; wait: (key: string) => Promise<unknown> };
    const workers: Worker[] = [];
    function start(role: string): Worker {
      // Pin the actual read, then pause its delivery; active replacements are production code.
      const script = `
        import { createRequire, syncBuiltinESMExports } from 'node:module';
        const require = createRequire(${JSON.stringify(packageUrl)});
        const role = ${JSON.stringify(role)}, home = ${JSON.stringify(home)}, repo = ${JSON.stringify(repo)};
        const path = ${JSON.stringify(path)}, guard = path + '.guard';
        let resume, finish;
        const resumed = new Promise(r => { resume = r }), finished = new Promise(r => { finish = r });
        process.on('message', m => { if(m === 'resume') resume(); if(m === 'finish') finish(); });
        if(role === 'A') {
          const fs = require('graceful-fs'), stat = fs.stat;
          let held = false;
          fs.stat = function(p, ...args) {
            const callback = args.pop();
            return stat.call(this, p, ...args, (e, s) => {
              if(p === guard && !e && s.mtimeMs < Date.now()-120000 && !held) {
                held = true; process.send('snapshot-held'); resumed.then(() => callback(e, s));
              } else callback(e, s);
            });
          };
          const promises = require('node:fs/promises'), readdir = promises.readdir;
          promises.readdir = async function(p, ...args) {
            const entries = await readdir.call(this, p, ...args);
            if(p === guard && !held) { held = true; process.send('snapshot-held'); await resumed; }
            return entries;
          };
          syncBuiltinESMExports();
        }
        const { SkillsUpdateService } = await import(${JSON.stringify(source)});
        const service = new SkillsUpdateService({homeDir: home, resolveNpx: async()=>'/npx', run:async()=>{
          process.send('command-entered'); await finished; return {stdout:'',stderr:''};
        }});
        if(role === 'B') {
          const original = service.readLockMetadata.bind(service);
          service.readLockMetadata = async p => {
            const metadata = await original(p);
            if(!metadata.alive) { process.send('metadata-held'); await resumed; }
            return metadata;
          };
        }
        const state = await service.check(repo, true);
        process.send({kind:'finished',status:state.status}); process.disconnect();
      `;
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, CEZ_DRY_RUN: '0' }, timeout: 8_000, killSignal: 'SIGKILL',
      });
      const seen = new Map<string, unknown>();
      const waiting = new Map<string, (value: unknown) => void>();
      let errors = '';
      child.stderr?.on('data', (chunk: Buffer) => { errors += chunk.toString(); });
      child.on('message', (message: unknown) => {
        const key = typeof message === 'string' ? message : (message as { kind: string }).kind;
        seen.set(key, message); waiting.get(key)?.(message);
      });
      const closed = new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`${role}: exit ${code}: ${errors}`)));
      });
      void closed.catch(() => undefined);
      const wait = (key: string) => Promise.race([
        seen.has(key) ? Promise.resolve(seen.get(key)) : new Promise<unknown>((resolve) => { waiting.set(key, resolve); }),
        closed.then(() => { if (!seen.has(key)) throw new Error(`${role}: closed before ${key}`); return seen.get(key); }),
      ]);
      const worker = { child, closed, wait }; workers.push(worker); return worker;
    }
    try {
      const a = start('A'); await a.wait('snapshot-held');
      const b = start('B');
      const outcome = await Promise.race([b.wait('metadata-held'), b.wait('finished')]);
      a.child.send('resume'); await a.wait('command-entered');
      const owned = await readFile(path, 'utf8');
      let bothCommandsRunning = false;
      if (outcome === 'metadata-held') {
        b.child.send('resume'); await b.wait('command-entered'); bothCommandsRunning = true;
      }
      expect(bothCommandsRunning).toBe(false);
      await expect(readFile(path, 'utf8')).resolves.toBe(owned);
      expect(outcome).toEqual({ kind: 'finished', status: 'unavailable' });
      const c = start('C');
      expect(await c.wait('finished')).toEqual({ kind: 'finished', status: 'unavailable' });
      await expect(readFile(path, 'utf8')).resolves.toBe(owned);
    } finally {
      for (const worker of workers) if (worker.child.connected) worker.child.send('finish');
      await Promise.allSettled(workers.map((worker) => worker.closed));
    }
  }, 20_000);
});
