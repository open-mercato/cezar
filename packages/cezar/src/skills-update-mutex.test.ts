import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const homeDir = vi.hoisted(() => vi.fn());
vi.mock('node:os', async (original) => ({
  ...await original<typeof import('node:os')>(), homedir: homeDir,
}));
import { SkillsUpdateService } from './skills-update.ts';

afterEach(() => vi.unstubAllEnvs());

it('keeps the check and update mutex under home when CEZ_HOME relocates the state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-mutex-'));
  const home = join(root, 'home');
  const state = join(root, 'state');
  const repo = join(root, 'repo');
  homeDir.mockReturnValue(home);
  vi.stubEnv('CEZ_HOME', state);
  vi.stubEnv('CEZ_DRY_RUN', '0');
  await mkdir(repo);
  await writeFile(join(repo, 'skills-lock.json'), JSON.stringify({ skills: { om: { source: 'open-mercato/skills' } } }));
  const operations: string[] = [];
  const locks: Array<{ home: boolean; state: boolean }> = [];
  const service = new SkillsUpdateService({
    resolveNpx: async () => '/npx',
    run: async (_file, args) => {
      operations.push(args[2]!);
      locks.push({
        home: await readFile(join(home, '.cache', 'cez', 'skills-update.lock'), 'utf8').then((text) => text.includes(String(process.pid)), () => false),
        state: await readFile(join(state, '.cache', 'cez', 'skills-update.lock')).then(() => true, () => false),
      });
      return { stdout: 'om update available', stderr: '' };
    },
  });
  try {
    expect((await service.check(repo)).available).toBe(true);
    await service.update(repo);
    expect(operations).toContain('check');
    expect(operations).toContain('update');
    expect(locks).toEqual(operations.map(() => ({ home: true, state: false })));
    expect(JSON.parse(await readFile(join(state, '.cache', 'cez', 'skills-update-state.json'), 'utf8')).version).toBe(1);
    await expect(readFile(join(home, '.cache', 'cez', 'skills-update.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
