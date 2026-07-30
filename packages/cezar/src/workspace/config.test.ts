import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceConfigPath } from '../paths.ts';
import {
  atomicTmpPath,
  defaultWorkspaceConfig,
  effectiveSkillsAutoUpdate,
  effectiveComposerDefault,
  loadWorkspaceConfig,
  mergeWriteWorkspaceConfig,
  workspaceConfigBackupPath,
  type WorkspaceConfig,
} from './config.ts';

/**
 * `~/.cezar/config.json` house rules under test (spec
 * 2026-07-20-multi-project-workspace, step 1.2): zero-config defaults, per-key
 * `.catch` degradation, `.passthrough()` forward compatibility, atomic `0600`
 * writes, and the read-modify-write merge that keeps concurrent writers from
 * dropping each other's registrations.
 */
describe('workspace config', () => {
  const originalHome = process.env.CEZ_HOME;
  const originalBrowseRoot = process.env.CEZ_BROWSE_ROOT;
  const originalProjectsDir = process.env.CEZ_PROJECTS_DIR;
  const originalSkillsAutoUpdate = process.env.CEZ_SKILLS_AUTO_UPDATE;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-workspace-'));
    process.env.CEZ_HOME = home; // paths.ts sends all workspace paths here
    delete process.env.CEZ_BROWSE_ROOT;
    delete process.env.CEZ_PROJECTS_DIR;
    delete process.env.CEZ_SKILLS_AUTO_UPDATE;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = originalHome;
    if (originalBrowseRoot === undefined) delete process.env.CEZ_BROWSE_ROOT;
    else process.env.CEZ_BROWSE_ROOT = originalBrowseRoot;
    if (originalProjectsDir === undefined) delete process.env.CEZ_PROJECTS_DIR;
    else process.env.CEZ_PROJECTS_DIR = originalProjectsDir;
    if (originalSkillsAutoUpdate === undefined) delete process.env.CEZ_SKILLS_AUTO_UPDATE;
    else process.env.CEZ_SKILLS_AUTO_UPDATE = originalSkillsAutoUpdate;
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const write = (value: unknown) =>
    writeFileSync(workspaceConfigPath(), typeof value === 'string' ? value : JSON.stringify(value), 'utf8');

  const project = (id: string) => ({
    id,
    root: `/tmp/projects/${id}`,
    name: id,
    addedAt: '2026-07-20T10:00:00Z',
    lastOpenedAt: '2026-07-20T10:00:00Z',
    source: 'local' as const,
  });

  it('a missing file behaves exactly like the defaults (zero-config, no warning)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = await loadWorkspaceConfig();
    expect(config).toEqual(defaultWorkspaceConfig());
    expect(config.schemaVersion).toBe(0);
    expect(config.browseRoot).toBe('~/');
    expect(config.projectsDir).toBe('~/cezar/projects');
    expect(config.resources).toEqual({ maxParallel: 2, maxMonitoringSessions: 2, monitoringWakeIntervalMinutes: null, memoryLimitMb: null, worktreeRetentionDefault: 10 });
    expect(config.composerDefaults).toEqual({});
    expect(config.projects).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('salvages disabled provider preferences and preserves unknown top-level keys on merge', async () => {
    expect(defaultWorkspaceConfig().disabledProviders).toEqual([]);

    write({
      disabledProviders: ['codex', 'future', 'codex', 4, 'opencode'],
      futureTopLevelKey: { keep: true },
    });
    expect((await loadWorkspaceConfig()).disabledProviders).toEqual(['codex', 'opencode']);

    const written = await mergeWriteWorkspaceConfig((config) => {
      config.disabledProviders = ['claude'];
    });
    expect(written.disabledProviders).toEqual(['claude']);
    const raw = JSON.parse(readFileSync(workspaceConfigPath(), 'utf8')) as Record<string, unknown>;
    expect(raw.futureTopLevelKey).toEqual({ keep: true });
  });

  it('takes zero-config roots from the environment while explicit stored values win', async () => {
    process.env.CEZ_BROWSE_ROOT = '~/source';
    process.env.CEZ_PROJECTS_DIR = '~/checkouts';
    expect(defaultWorkspaceConfig()).toMatchObject({
      browseRoot: '~/source',
      projectsDir: '~/checkouts',
    });
    write({ browseRoot: '/srv/source', projectsDir: '/srv/checkouts' });
    expect(await loadWorkspaceConfig()).toMatchObject({
      browseRoot: '/srv/source',
      projectsDir: '/srv/checkouts',
    });
  });

  it('resolves skills auto-update as explicit setting, then 0/1 env, then true', () => {
    expect(effectiveSkillsAutoUpdate({}, {})).toBe(true);
    expect(effectiveSkillsAutoUpdate({}, { CEZ_SKILLS_AUTO_UPDATE: '0' })).toBe(false);
    expect(effectiveSkillsAutoUpdate({}, { CEZ_SKILLS_AUTO_UPDATE: '1' })).toBe(true);
    expect(effectiveSkillsAutoUpdate({}, { CEZ_SKILLS_AUTO_UPDATE: 'invalid' })).toBe(true);
    expect(effectiveSkillsAutoUpdate({ skillsAutoUpdate: false }, { CEZ_SKILLS_AUTO_UPDATE: '1' })).toBe(false);
    expect(effectiveSkillsAutoUpdate({ skillsAutoUpdate: true }, { CEZ_SKILLS_AUTO_UPDATE: '0' })).toBe(true);
  });

  it('resolves composer defaults as stored value, exact 0/1 env, then fallback', () => {
    expect(effectiveComposerDefault(undefined, undefined, true)).toBe(true);
    expect(effectiveComposerDefault(undefined, '0', true)).toBe(false);
    expect(effectiveComposerDefault(undefined, '1', false)).toBe(true);
    expect(effectiveComposerDefault(undefined, 'yes', false)).toBe(false);
    expect(effectiveComposerDefault(false, '1', true)).toBe(false);
    expect(effectiveComposerDefault(true, '0', false)).toBe(true);
  });

  it('degrades invalid composer defaults per key and preserves unknown nested keys', async () => {
    write({ composerDefaults: { autonomous: 'yes', worktree: false, future: 42 } });
    expect((await loadWorkspaceConfig()).composerDefaults).toEqual({ worktree: false, future: 42 });
  });

  it('degrades a bad stored preference per-key and preserves raw absence on unrelated writes', async () => {
    write({ skillsAutoUpdate: 'no', futureKey: true });
    expect((await loadWorkspaceConfig()).skillsAutoUpdate).toBeUndefined();
    await mergeWriteWorkspaceConfig((config) => {
      config.resources.maxParallel = 3;
    });
    const raw = JSON.parse(readFileSync(workspaceConfigPath(), 'utf8')) as Record<string, unknown>;
    expect(raw.skillsAutoUpdate).toBeUndefined();
    expect(raw.futureKey).toBe(true);
  });

  it('round-trips a merge-written config, with the file at mode 0600', async () => {
    await mergeWriteWorkspaceConfig((config) => {
      config.schemaVersion = 1;
      config.resources.maxParallel = 4;
      config.projects.push(project('cezar'));
    });
    expect(statSync(workspaceConfigPath()).mode & 0o777).toBe(0o600);
    const config = await loadWorkspaceConfig();
    expect(config.schemaVersion).toBe(1);
    expect(config.resources.maxParallel).toBe(4);
    expect(config.projects).toEqual([project('cezar')]);
  });

  it('a corrupt file degrades to defaults with one warning and is left on disk untouched', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    write('{not json');
    const config = await loadWorkspaceConfig();
    expect(config).toEqual(defaultWorkspaceConfig());
    expect(warn).toHaveBeenCalledTimes(1);
    // never overwritten by a load — only the next successful merge-write replaces it
    expect(readFileSync(workspaceConfigPath(), 'utf8')).toBe('{not json');
  });

  it('a non-object top level degrades to defaults too (never throws)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    write('[1, 2, 3]');
    expect(await loadWorkspaceConfig()).toEqual(defaultWorkspaceConfig());
  });

  it('every atomic write stages through its own tmp file (pid + random, never a shared name)', () => {
    // Two cezar processes (a `serve` per repo, a settings PUT, `cezar run`)
    // share `~/.cezar/` — a fixed `${path}.tmp` would let one writer O_TRUNC
    // the other's staging file mid-write and rename corruption into place.
    const path = workspaceConfigPath();
    const a = atomicTmpPath(path);
    const b = atomicTmpPath(path);
    expect(a).not.toBe(b); // unique per call, even within one process
    for (const tmp of [a, b]) {
      expect(tmp.startsWith(`${path}.`)).toBe(true); // stays in the target's directory
      expect(tmp.endsWith('.tmp')).toBe(true);
      expect(tmp).toContain(`.${process.pid}.`); // per-process namespace
    }
  });

  it('a merge-write leaves no staging file behind', async () => {
    await mergeWriteWorkspaceConfig((config) => {
      config.projects.push(project('cezar'));
    });
    const dir = readdirSync(dirname(workspaceConfigPath()));
    expect(dir.filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect((await loadWorkspaceConfig()).projects.map((p) => p.id)).toEqual(['cezar']);
  });

  it('concurrent merge-writes from stale in-memory copies keep both writers projects', async () => {
    // Writer A reads the (empty) config into memory…
    const stale = await loadWorkspaceConfig();
    expect(stale.projects).toEqual([]);
    // …then writer B registers its project first…
    await mergeWriteWorkspaceConfig((config) => {
      config.projects.push(project('writer-b'));
    });
    // …and writer A merge-writes WITHOUT using its stale copy: the mutator
    // gets a freshly re-read config, so B's registration survives.
    await mergeWriteWorkspaceConfig((config) => {
      expect(config.projects.map((p) => p.id)).toEqual(['writer-b']);
      config.projects.push(project('writer-a'));
    });
    const config = await loadWorkspaceConfig();
    expect(config.projects.map((p) => p.id).sort()).toEqual(['writer-a', 'writer-b']);
  });

  it('unknown keys survive load + merge-write at every level (.passthrough)', async () => {
    write({
      futureTopLevelKey: { nested: true },
      resources: { maxParallel: 3, futureResourceKey: 'kept' },
      projects: [{ ...project('cezar'), futureProjectKey: 42 }],
    });
    await mergeWriteWorkspaceConfig((config) => {
      config.schemaVersion = 1;
    });
    const raw = JSON.parse(readFileSync(workspaceConfigPath(), 'utf8')) as Record<string, unknown>;
    expect(raw.futureTopLevelKey).toEqual({ nested: true });
    expect((raw.resources as Record<string, unknown>).futureResourceKey).toBe('kept');
    expect((raw.resources as Record<string, unknown>).maxParallel).toBe(3);
    expect((raw.projects as Record<string, unknown>[])[0]?.futureProjectKey).toBe(42);
    expect(raw.schemaVersion).toBe(1);
  });

  it('degrades bad values per-key instead of discarding the file', async () => {
    write({
      schemaVersion: 'two',
      browseRoot: 42,
      projectsDir: 42,
      resources: { maxParallel: 99, maxMonitoringSessions: 99, monitoringWakeIntervalMinutes: 0, memoryLimitMb: 'lots', worktreeRetentionDefault: -1 },
      projects: [project('good')],
    });
    const config = await loadWorkspaceConfig();
    expect(config.schemaVersion).toBe(0);
    expect(config.browseRoot).toBe('~/');
    expect(config.projectsDir).toBe('~/cezar/projects');
    expect(config.resources).toEqual({ maxParallel: 2, maxMonitoringSessions: 2, monitoringWakeIntervalMinutes: null, memoryLimitMb: null, worktreeRetentionDefault: 10 });
    expect(config.projects).toEqual([project('good')]);
  });

  it('drops a corrupt registry entry but keeps the rest (per-entry salvage)', async () => {
    write({
      projects: [
        project('good'),
        { id: 'Bad Slug!', root: '/tmp/x' }, // id fails the slug regex
        { id: 'relative', root: 'not/absolute' }, // root must be absolute
        'not-an-object',
        { ...project('also-good'), source: 'weird' }, // bad enum degrades per-key
      ],
    });
    const config = await loadWorkspaceConfig();
    expect(config.projects.map((p) => p.id)).toEqual(['good', 'also-good']);
    expect(config.projects[1]?.source).toBe('local');
  });

  it('per-project maxParallel: keeps a valid value, degrades a bad one to inherit, absent stays absent', async () => {
    write({
      projects: [
        { ...project('capped'), maxParallel: 1 }, // valid override
        { ...project('too-big'), maxParallel: 999 }, // out of range → inherit (undefined)
        project('inherits'), // no key → inherit (undefined)
      ],
    });
    const config = await loadWorkspaceConfig();
    // A bad maxParallel degrades that one key without evicting the entry.
    expect(config.projects.map((p) => p.id)).toEqual(['capped', 'too-big', 'inherits']);
    expect(config.projects[0]?.maxParallel).toBe(1);
    expect(config.projects[1]?.maxParallel).toBeUndefined();
    expect(config.projects[2]?.maxParallel).toBeUndefined();
  });

  it('memoryLimitMb keeps an explicit null and a real value', async () => {
    write({ resources: { memoryLimitMb: null } });
    expect((await loadWorkspaceConfig()).resources.memoryLimitMb).toBeNull();
    write({ resources: { memoryLimitMb: 2048 } });
    expect((await loadWorkspaceConfig()).resources.memoryLimitMb).toBe(2048);
  });

  it('mergeWriteWorkspaceConfig accepts a returned replacement config', async () => {
    const written = await mergeWriteWorkspaceConfig((config) => ({
      ...config,
      projectsDir: '/srv/checkouts',
    }));
    expect(written.projectsDir).toBe('/srv/checkouts');
    expect((await loadWorkspaceConfig()).projectsDir).toBe('/srv/checkouts');
  });

  describe('registry backup and self-heal', () => {
    const registerOne = () =>
      mergeWriteWorkspaceConfig((config) => {
        config.projects.push(project('shop'));
      });

    it('snapshots a non-empty registry beside the config on every merge-write', async () => {
      await registerOne();
      const snapshot = JSON.parse(readFileSync(workspaceConfigBackupPath(), 'utf8')) as WorkspaceConfig;
      expect(snapshot.projects.map((p) => p.id)).toEqual(['shop']);
      expect(statSync(workspaceConfigBackupPath()).mode & 0o777).toBe(0o600);
    });

    it('refreshes the snapshot when the last project is unregistered, so it cannot resurrect (#731)', async () => {
      await registerOne();
      await mergeWriteWorkspaceConfig((config) => {
        config.projects = [];
      });
      // The snapshot now mirrors the emptied registry — no stale entry survives.
      expect(
        (JSON.parse(readFileSync(workspaceConfigBackupPath(), 'utf8')) as WorkspaceConfig).projects,
      ).toEqual([]);
      // A config that parses and is simply empty is the user's own state.
      expect((await loadWorkspaceConfig()).projects).toEqual([]);
      // And losing config.json entirely must NOT bring the removed project back
      // from a stale snapshot — recovery settles on the empty registry the user
      // intended, which was the #731 data-integrity defect.
      rmSync(workspaceConfigPath());
      expect((await loadWorkspaceConfig()).projects).toEqual([]);
    });

    it('restores the registry when the config file went missing', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await registerOne();
      rmSync(workspaceConfigPath());

      const restored = await loadWorkspaceConfig();
      expect(restored.projects.map((p) => p.id)).toEqual(['shop']);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('restored 1 project(s)'));
    });

    it('restores the registry from an empty or corrupt config file', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      await registerOne();

      write('');
      expect((await loadWorkspaceConfig()).projects.map((p) => p.id)).toEqual(['shop']);

      write('{ not json');
      expect((await loadWorkspaceConfig()).projects.map((p) => p.id)).toEqual(['shop']);
    });

    it('writes the recovered registry back on the next merge-write, so a restart keeps it', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      await registerOne();
      rmSync(workspaceConfigPath());

      await mergeWriteWorkspaceConfig((config) => {
        config.projects.push(project('warehouse'));
      });
      const onDisk = JSON.parse(readFileSync(workspaceConfigPath(), 'utf8')) as WorkspaceConfig;
      expect(onDisk.projects.map((p) => p.id)).toEqual(['shop', 'warehouse']);
    });

    it('falls back to the defaults when neither the config nor a usable snapshot exists', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      writeFileSync(workspaceConfigBackupPath(), JSON.stringify({ projects: [] }), 'utf8');
      write('{ not json');

      expect((await loadWorkspaceConfig()).projects).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('is corrupt'));
    });
  });
});
