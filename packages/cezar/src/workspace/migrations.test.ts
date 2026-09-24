import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceConfigPath, workspaceUiStatePath } from '../paths.ts';
import { defaultWorkspaceConfig, loadWorkspaceConfig } from './config.ts';
import { runMigrations, WORKSPACE_MIGRATIONS, type WorkspaceMigration } from './migrations.ts';

/**
 * Workspace migration framework + migration 001 under test (spec
 * 2026-07-20-multi-project-workspace, step 1.4): idempotent re-runs, additive
 * imports that never overwrite globally-set keys, per-step `schemaVersion`
 * persistence, and the non-blocking degradation rule (an unwritable home logs
 * one warning, never throws).
 */
describe('workspace migrations', () => {
  const originalHome = process.env.CEZ_HOME;
  let home: string;
  let repoRoot: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-migrations-home-'));
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-migrations-repo-'));
    process.env.CEZ_HOME = home; // paths.ts sends all workspace paths here
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = originalHome;
    chmodSync(home, 0o700); // undo the unwritable-home test before cleanup
    rmSync(home, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const writeRepoFile = (name: string, value: unknown) => {
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai/cezar', name), JSON.stringify(value), 'utf8');
  };

  const rawGlobalConfig = () =>
    JSON.parse(readFileSync(workspaceConfigPath(), 'utf8')) as Record<string, unknown>;
  const rawGlobalUiState = () =>
    JSON.parse(readFileSync(workspaceUiStatePath(), 'utf8')) as Record<string, unknown>;

  it('fresh home: creates config.json with defaults and schemaVersion 1', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await runMigrations({ bootRepoRoot: null });
    const config = await loadWorkspaceConfig();
    expect(config).toEqual({ ...defaultWorkspaceConfig(), schemaVersion: 1 });
    expect(statSync(workspaceConfigPath()).mode & 0o777).toBe(0o600);
    // nothing to import → the global ui-state file is not created
    expect(existsSync(workspaceUiStatePath())).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('imports the boot repo resource + ui-state keys, leaving repo files untouched', async () => {
    writeRepoFile('config.json', { maxParallel: 5, memoryLimitMb: 1024, defaultRunner: 'codex' });
    writeRepoFile('ui-state.json', {
      appearance: { accent: 'violet', density: 'compact' },
      notifications: { enabled: false },
      githubView: 'prs', // project-scoped — must NOT go global
    });
    const repoConfigBefore = readFileSync(join(repoRoot, '.ai/cezar/config.json'), 'utf8');
    const repoUiBefore = readFileSync(join(repoRoot, '.ai/cezar/ui-state.json'), 'utf8');

    await runMigrations({ bootRepoRoot: repoRoot });

    const config = await loadWorkspaceConfig();
    expect(config.schemaVersion).toBe(1);
    expect(config.resources.maxParallel).toBe(5);
    expect(config.resources.memoryLimitMb).toBe(1024);
    expect(rawGlobalUiState()).toEqual({
      appearance: { accent: 'violet', density: 'compact' },
      notifications: { enabled: false },
    });
    expect(statSync(workspaceUiStatePath()).mode & 0o777).toBe(0o600);
    // additive: per-repo files are byte-identical
    expect(readFileSync(join(repoRoot, '.ai/cezar/config.json'), 'utf8')).toBe(repoConfigBefore);
    expect(readFileSync(join(repoRoot, '.ai/cezar/ui-state.json'), 'utf8')).toBe(repoUiBefore);
  });

  it('never overwrites keys already set globally (crash-interrupted re-run safety)', async () => {
    writeFileSync(
      workspaceConfigPath(),
      JSON.stringify({ resources: { maxParallel: 8 } }),
      'utf8',
    );
    writeFileSync(
      workspaceUiStatePath(),
      JSON.stringify({ appearance: { accent: 'lime' } }),
      'utf8',
    );
    writeRepoFile('config.json', { maxParallel: 5, memoryLimitMb: 1024 });
    writeRepoFile('ui-state.json', { appearance: { accent: 'violet' }, notifications: { enabled: true } });

    await runMigrations({ bootRepoRoot: repoRoot });

    const config = await loadWorkspaceConfig();
    expect(config.resources.maxParallel).toBe(8); // globally set — kept
    expect(config.resources.memoryLimitMb).toBe(1024); // absent globally — imported
    const uiState = rawGlobalUiState();
    expect(uiState.appearance).toEqual({ accent: 'lime' }); // globally set — kept
    expect(uiState.notifications).toEqual({ enabled: true }); // absent — imported
  });

  it('re-running the migration body is idempotent: imported values are not re-imported', async () => {
    writeRepoFile('config.json', { maxParallel: 5 });
    writeRepoFile('ui-state.json', { appearance: { accent: 'violet' } });
    await runMigrations({ bootRepoRoot: repoRoot });

    // Simulate a crash between the migration body and the version bump: force
    // schemaVersion back to 0 and re-run against CHANGED repo values. The
    // first pass wrote the keys globally, so the re-run must not overwrite.
    const raw = rawGlobalConfig();
    writeFileSync(workspaceConfigPath(), JSON.stringify({ ...raw, schemaVersion: 0 }), 'utf8');
    writeRepoFile('config.json', { maxParallel: 3 });
    writeRepoFile('ui-state.json', { appearance: { accent: 'lime' } });
    await runMigrations({ bootRepoRoot: repoRoot });

    const config = await loadWorkspaceConfig();
    expect(config.schemaVersion).toBe(1);
    expect(config.resources.maxParallel).toBe(5);
    expect(rawGlobalUiState().appearance).toEqual({ accent: 'violet' });
  });

  it('a completed migration is skipped entirely on the next boot', async () => {
    await runMigrations({ bootRepoRoot: null });
    const run = vi.fn(async () => {});
    await runMigrations({ bootRepoRoot: null }, [{ to: 1, id: '001-spy', run }]);
    expect(run).not.toHaveBeenCalled();
  });

  it('out-of-range repo values are not imported (defaults kept)', async () => {
    writeRepoFile('config.json', { maxParallel: 99, memoryLimitMb: 12.5 });
    await runMigrations({ bootRepoRoot: repoRoot });
    const config = await loadWorkspaceConfig();
    expect(config.resources.maxParallel).toBe(2);
    expect(config.resources.memoryLimitMb).toBeNull();
  });

  it('an unwritable home degrades with ONE warning and never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    chmodSync(home, 0o500); // read-only home dir → the atomic write fails
    await expect(runMigrations({ bootRepoRoot: null })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('001-workspace-config');
    chmodSync(home, 0o700);
    expect(existsSync(workspaceConfigPath())).toBe(false);
  });

  it('runs migrations in ascending order and persists schemaVersion after EACH step', async () => {
    const order: number[] = [];
    let versionSeenBySecond: unknown;
    const fake = (to: number, run: () => Promise<void>): WorkspaceMigration => ({
      to,
      id: `00${to}-fake`,
      run,
    });
    const first = fake(1, async () => {
      order.push(1);
    });
    const second = fake(2, async () => {
      order.push(2);
      // migration 1's bump must already be on disk when migration 2 runs
      versionSeenBySecond = rawGlobalConfig().schemaVersion;
    });
    await runMigrations({ bootRepoRoot: null }, [second, first]); // deliberately out of order
    expect(order).toEqual([1, 2]);
    expect(versionSeenBySecond).toBe(1);
    expect((await loadWorkspaceConfig()).schemaVersion).toBe(2);
  });

  it('a failing migration warns once and stops the chain (later steps do not run)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const second = vi.fn(async () => {});
    await runMigrations({ bootRepoRoot: null }, [
      { to: 1, id: '001-boom', run: async () => Promise.reject(new Error('boom')) },
      { to: 2, id: '002-after', run: second },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('001-boom');
    expect(second).not.toHaveBeenCalled();
    // nothing persisted — the next boot retries from 0 (idempotent)
    expect(existsSync(workspaceConfigPath())).toBe(false);
  });

  it('stays at schemaVersion 1 — a purely additive key needs no migration', () => {
    // Agent profiles (spec 2026-07-29) added `agentProfiles` and `projects[].agentProfile`, both
    // optional with an absent value that means exactly today's behaviour. There is nothing to
    // move, so there is nothing to migrate; this pins that so a no-op migration is not added
    // reflexively the next time a key lands here.
    expect(WORKSPACE_MIGRATIONS.map((m) => m.to)).toEqual([1]);
  });
});
