import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { removeTempDir } from '../test-fixtures/remove-temp-dir.testkit.ts';
import { RunManager } from './run.ts';

// The namer itself is replaced: what matters here is WHETHER the manager reaches for it, and the
// real one would start an agent process.
const generateRunName = vi.hoisted(() => vi.fn(async () => null));
vi.mock('../runs/auto-name.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../runs/auto-name.ts')>()),
  generateRunName,
}));

/**
 * `dispose()` promises that the manager "makes no further moves on its own". Turn-end
 * bookkeeping is fire-and-forget and awaits (`git diff --shortstat`, the config read) before it
 * decides to refresh the title, so it routinely RESUMES after a dispose that happened meanwhile —
 * and used to go on to launch a namer agent in the project's root. For a removed project that is
 * a model call nobody asked for; on Windows it is also a process whose cwd keeps the folder from
 * being deleted for as long as the namer runs (found as `EBUSY` in every test teardown that
 * removed its temp repository after a cancelled run).
 */
describe('a disposed manager launches no namer', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-dispose-namer-'));
    // Naming on, and live title refresh at its shipped default (on).
    vi.stubEnv('CEZ_AUTONAME', '1');
    vi.stubEnv('CEZ_TITLE_UPDATES', '1');
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
    generateRunName.mockClear();
  });

  afterEach(async () => {
    manager.dispose();
    vi.unstubAllEnvs();
    store.flush();
    await removeTempDir(repoRoot);
  });

  const newRun = () =>
    store.createRun({ title: 't', workflow: 'quick-task', task: 'fix the login bug', steps: [] });

  /** The refresh hands the namer off without awaiting it; give that hand-off a few turns. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

  // Guard — passes with or without the fix: the path under test really does reach the namer, so
  // the case below is not green merely because nothing would have happened anyway.
  it('refreshes the title at turn end while the manager is alive', async () => {
    const run = newRun();
    await manager.recordTurnEnd(run.id, 'caught the AuthError in the login handler');
    await settle();
    expect(generateRunName).toHaveBeenCalledTimes(1);
  });

  it('does not reach the namer when disposed while the turn-end bookkeeping was awaiting', async () => {
    const run = newRun();
    const bookkeeping = manager.recordTurnEnd(run.id, 'caught the AuthError in the login handler');
    manager.dispose(); // lands inside the bookkeeping's first await
    await bookkeeping;
    await settle();
    expect(generateRunName).not.toHaveBeenCalled();
  });
});
