import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initWorkspace } from './boot.ts';
import { loadWorkspaceConfig } from './config.ts';
import { clearProjectProbeCache, registerProject } from './projects.ts';

/**
 * `initWorkspace` — the one function every boot path (`serve`, `run`, the
 * single-project `projects list`) calls, and therefore the only thing that
 * decides whether starting cezar in a folder writes to the user's registry.
 * `shouldAutoRegisterProject` has its own unit tests; these assert the WIRING,
 * because a boot that quietly went back to the old path would leave every one
 * of those tests green.
 */
describe('initWorkspace', () => {
  const originalHome = process.env.CEZ_HOME;
  let home: string;
  let repos: string;

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-boot-home-'));
    repos = mkdtempSync(join(realpathSync(tmpdir()), 'cez-boot-repos-'));
    process.env.CEZ_HOME = home;
    clearProjectProbeCache();
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(repos, { recursive: true, force: true });
  });

  const makeRepo = (name: string): string => {
    const dir = join(repos, name);
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    return dir;
  };

  const registeredRoots = async (): Promise<string[]> =>
    (await loadWorkspaceConfig()).projects.map((project) => project.root);

  it('seeds the registry from the folder cezar first runs in', async () => {
    const root = makeRepo('first');
    const id = await initWorkspace(root);
    expect(id).toBe('first');
    expect(await registeredRoots()).toEqual([realpathSync(root)]);
  });

  it('does not add the folder once the user has projects', async () => {
    await registerProject(makeRepo('kept'));
    const scratch = makeRepo('scratch');

    // No id to plumb into the server — it derives the boot slug itself and
    // lists the folder as unregistered (see the projects API tests).
    expect(await initWorkspace(scratch)).toBeUndefined();
    expect(await registeredRoots()).toEqual([realpathSync(join(repos, 'kept'))]);
  });

  it('still opens a known project: same id, refreshed lastOpenedAt', async () => {
    const root = makeRepo('known');
    const first = await registerProject(root);
    await registerProject(makeRepo('other'));

    const id = await initWorkspace(root);
    expect(id).toBe(first.id);
    const entry = (await loadWorkspaceConfig()).projects.find((project) => project.id === first.id);
    expect(Date.parse(entry?.lastOpenedAt ?? '')).toBeGreaterThanOrEqual(
      Date.parse(first.lastOpenedAt),
    );
    expect(await registeredRoots()).toHaveLength(2);
  });

  it('runs migrations even when it registers nothing', async () => {
    await registerProject(makeRepo('kept'));
    await initWorkspace(makeRepo('scratch'));
    // The migration cursor is the observable proof migrations ran — the
    // suppressed registration must not short-circuit the rest of boot.
    expect((await loadWorkspaceConfig()).schemaVersion).toBeGreaterThan(0);
  });
});
