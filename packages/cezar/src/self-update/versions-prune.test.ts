import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runVersionsPruneCommand } from './cli.ts';
import { installFromRegistry, type InstallOptions } from './installer.ts';
import { activate, activeId, listInstalled, versionDir, versionEntry, versionsDir, writeManifest } from './layout.ts';
import { acquireVersionsLock, listVersionBackups, pruneVersions, runningVersionId, type PruneOptions } from './versions-prune.ts';

describe('pruning old versions', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  const noProcesses = async () => new Set<string>();

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-prune-'));
    env = { ...process.env, CEZ_HOME: home, HOME: home };
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  /** A complete install whose `installedAt` orders it: day 1 is the oldest. */
  const install = (id: string, day: number, source: 'registry' | 'local' = 'registry') => {
    const entry = versionEntry(id, env);
    mkdirSync(join(entry, '..'), { recursive: true });
    writeFileSync(entry, '// cezar\n');
    writeManifest(id, { version: id.replace(/\+.*$/, ''), source, installedAt: `2026-10-${String(day).padStart(2, '0')}T00:00:00.000Z` }, env);
  };
  const ids = () => listInstalled(env).map((entry) => entry.id).sort();
  const prune = (opts: Partial<PruneOptions> = {}) => pruneVersions({ keep: 3, env, processIds: noProcesses, ...opts });
  const eight = () => {
    for (let day = 1; day <= 8; day++) install(`0.1${day}.0`, day);
  };

  it('keeps the running version plus the most recent others and deletes the rest', async () => {
    eight();
    activate('0.18.0', env);
    const result = await prune({ entry: versionEntry('0.15.0', env) });
    // Running 0.15.0 + the two newest others (0.18.0 is also current).
    expect(ids()).toEqual(['0.15.0', '0.17.0', '0.18.0']);
    expect(result.removed.map((entry) => entry.id).sort()).toEqual(['0.11.0', '0.12.0', '0.13.0', '0.14.0', '0.16.0']);
    expect(result.kept).toEqual(expect.arrayContaining([{ id: '0.15.0', reason: 'running' }, { id: '0.18.0', reason: 'current' }]));
    // Nothing half-deleted is left in sight.
    expect(readdirSync(versionsDir(env)).filter((name) => name.startsWith('.trash-'))).toEqual([]);
  });

  it('honours --keep and resolves `current` in the running entry path', async () => {
    eight();
    activate('0.18.0', env);
    const throughCurrent = join(versionsDir(env), 'current', 'node_modules', '@open-mercato', 'cezar', 'dist', 'index.js');
    expect(runningVersionId(throughCurrent, env)).toBe('0.18.0');
    await prune({ keep: 1, entry: throughCurrent });
    expect(ids()).toEqual(['0.18.0']);
  });

  it('keeps the version this process runs after `current` flips to a new one', async () => {
    eight();
    activate('0.17.0', env);
    // Started through `current`; this module realpaths into 0.17.0. Then `cezar update` activates 0.18.0.
    const throughCurrent = join(versionsDir(env), 'current', 'node_modules', '@open-mercato', 'cezar', 'dist', 'index.js');
    const modulePath = versionEntry('0.17.0', env);
    activate('0.18.0', env);
    expect(runningVersionId(throughCurrent, env, modulePath)).toBe('0.17.0');
    const result = await prune({ keep: 1, entry: throughCurrent, modulePath });
    expect(ids()).toEqual(['0.17.0', '0.18.0']);
    expect(result.kept).toEqual(expect.arrayContaining([{ id: '0.17.0', reason: 'running' }, { id: '0.18.0', reason: 'current' }]));
  });

  it('never deletes the current version, even when it is old', async () => {
    eight();
    activate('0.11.0', env);
    await prune({ keep: 2, entry: versionEntry('0.18.0', env) });
    expect(ids()).toEqual(['0.11.0', '0.17.0', '0.18.0']);
    expect(activeId(env)).toBe('0.11.0');
  });

  it('never deletes a version another live process leases or runs', async () => {
    eight();
    activate('0.18.0', env);
    mkdirSync(join(versionsDir(env), '.in-use'), { recursive: true });
    writeFileSync(join(versionsDir(env), '.in-use', '4242.json'), JSON.stringify({ id: '0.12.0', pid: 4242 }));
    writeFileSync(join(versionsDir(env), '.in-use', '4343.json'), JSON.stringify({ id: '0.13.0', pid: 4343 }));
    await prune({
      keep: 1,
      entry: versionEntry('0.18.0', env),
      isAlive: (pid) => pid === 4242,
      processIds: async () => new Set(['0.14.0']),
    });
    // 0.12.0 by its live lease, 0.14.0 by a process command line; 0.13.0's lease is dead.
    expect(ids()).toEqual(['0.12.0', '0.14.0', '0.18.0']);
    expect(existsSync(join(versionsDir(env), '.in-use', '4343.json'))).toBe(false);
  });

  it('never removes a linked checkout', async () => {
    eight();
    activate('0.18.0', env);
    writeManifest('0.10.0+cez-old', { version: '0.10.0', source: 'link', installedAt: '2026-01-01T00:00:00.000Z', checkout: '/x' }, env);
    const entry = versionEntry('0.10.0+cez-old', env);
    mkdirSync(join(entry, '..'), { recursive: true });
    writeFileSync(entry, '');
    const result = await prune({ keep: 1, entry: versionEntry('0.18.0', env) });
    expect(ids()).toEqual(['0.10.0+cez-old', '0.18.0']);
    expect(result.kept).toContainEqual({ id: '0.10.0+cez-old', reason: 'link' });
  });

  it('deletes nothing on a dry run', async () => {
    eight();
    activate('0.18.0', env);
    mkdirSync(join(home, 'versions.backup-20260928', 'x'), { recursive: true });
    const result = await prune({ dryRun: true, backups: true, entry: versionEntry('0.18.0', env) });
    expect(result.removed).toHaveLength(5);
    expect(result.backups).toEqual([expect.objectContaining({ name: 'versions.backup-20260928', removed: true })]);
    expect(ids()).toHaveLength(8);
    expect(existsSync(join(home, 'versions.backup-20260928'))).toBe(true);
  });

  it('skips the whole prune while an install is in flight', async () => {
    eight();
    activate('0.18.0', env);
    mkdirSync(join(versionsDir(env), `.staging-0.19.0-${process.pid}`));
    const result = await prune({ keep: 1, entry: versionEntry('0.18.0', env) });
    expect(result.skipped).toMatch(/install is in progress/);
    expect(ids()).toHaveLength(8);
  });

  it('cleans a dead installer\'s staging and a killed prune\'s trash', async () => {
    eight();
    activate('0.18.0', env);
    mkdirSync(join(versionsDir(env), '.staging-0.19.0-999999'));
    mkdirSync(join(versionsDir(env), '.trash-0.10.0-999999-1'));
    const result = await prune({ keep: 8, entry: versionEntry('0.18.0', env), isAlive: (pid) => pid === process.pid });
    expect(result.skipped).toBeUndefined();
    expect(readdirSync(versionsDir(env)).filter((name) => name.startsWith('.staging-') || name.startsWith('.trash-'))).toEqual([]);
  });

  it('waits out the lock: a prune refuses while an install commits, the install waits for a prune', async () => {
    eight();
    activate('0.18.0', env);
    const release = await acquireVersionsLock({ env });
    expect(release).not.toBeNull();
    const refused = await prune({ keep: 1, entry: versionEntry('0.18.0', env) });
    expect(refused.skipped).toMatch(/lock/);
    expect(ids()).toHaveLength(8);

    // An install that reaches its commit while the lock is held waits for it.
    const npm: NonNullable<InstallOptions['runNpm']> = async (args) => {
      const dist = join(args[args.indexOf('--prefix') + 1] ?? '', 'node_modules', '@open-mercato', 'cezar', 'dist');
      mkdirSync(dist, { recursive: true });
      writeFileSync(join(dist, 'index.js'), '');
    };
    let done = false;
    const installing = installFromRegistry('0.19.0', { env, runNpm: npm }).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 300));
    expect(done).toBe(false);
    expect(existsSync(versionDir('0.19.0', env))).toBe(false);
    release!();
    await installing;
    expect(existsSync(versionEntry('0.19.0', env))).toBe(true);
  });

  it('`cezar versions prune` exits 3 when the prune was skipped, 0 on a skipped dry run', async () => {
    eight();
    activate('0.18.0', env);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      mkdirSync(join(versionsDir(env), `.staging-0.19.0-${process.pid}`));
      expect(await runVersionsPruneCommand(['--keep', '1'], { entry: versionEntry('0.18.0', env), env })).toBe(3);
      expect(await runVersionsPruneCommand(['--keep', '1', '--dry-run'], { entry: versionEntry('0.18.0', env), env })).toBe(0);
      expect(ids()).toHaveLength(8);
    } finally {
      log.mockRestore();
    }
  });

  it('breaks a lock its dead owner left behind', async () => {
    eight();
    activate('0.18.0', env);
    writeFileSync(join(versionsDir(env), '.lock'), '999999');
    const result = await prune({ keep: 1, entry: versionEntry('0.18.0', env), isAlive: (pid) => pid === process.pid });
    expect(result.skipped).toBeUndefined();
    expect(ids()).toEqual(['0.18.0']);
  });

  it('never deletes a fresh lock another breaker took, and releases only its own', async () => {
    mkdirSync(versionsDir(env), { recursive: true });
    const lock = join(versionsDir(env), '.lock');
    writeFileSync(lock, '999999');
    let raced = false;
    // Between our stale read and our break, another process breaks it and takes it (pid 4242).
    const isAlive = (pid: number) => {
      if (pid === 999999 && !raced) {
        raced = true;
        rmSync(lock);
        writeFileSync(lock, '4242');
      }
      return pid === 4242 || pid === process.pid;
    };
    expect(await acquireVersionsLock({ env, isAlive })).toBeNull();
    expect(readFileSync(lock, 'utf8')).toBe('4242');
    expect(readdirSync(versionsDir(env)).filter((name) => name.includes('.stale-'))).toEqual([]);

    rmSync(lock);
    const release = await acquireVersionsLock({ env });
    expect(release).not.toBeNull();
    writeFileSync(lock, '4242'); // our lock was broken and re-taken by someone else
    release!();
    expect(readFileSync(lock, 'utf8')).toBe('4242');
  });

  it('removes versions.backup-* only when asked, and always lists them', async () => {
    eight();
    activate('0.18.0', env);
    mkdirSync(join(home, 'versions.backup-20260928', 'deep'), { recursive: true });
    const automatic = await prune({ entry: versionEntry('0.18.0', env) });
    expect(automatic.backups).toEqual([expect.objectContaining({ name: 'versions.backup-20260928', removed: false })]);
    expect(listVersionBackups(env)).toHaveLength(1);
    const explicit = await prune({ backups: true, entry: versionEntry('0.18.0', env) });
    expect(explicit.backups).toEqual([expect.objectContaining({ removed: true })]);
    expect(listVersionBackups(env)).toEqual([]);
  });

  it('does nothing with keep 0 (automatic prune off) or no versions directory', async () => {
    expect((await prune({ keep: 3 })).removed).toEqual([]);
    eight();
    activate('0.18.0', env);
    await prune({ keep: 0, entry: versionEntry('0.18.0', env) });
    expect(ids()).toHaveLength(8);
  });
});
