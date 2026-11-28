import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeWorktree } from './git-worktree.ts';

vi.mock('node:child_process', { spy: true });
vi.mock('node:fs/promises', { spy: true });
vi.mock('./worktree-in-use.ts', () => ({ worktreeInUse: async () => null }));

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
let root: string;
let worktree: string;
let target: string;

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'cez-remove-worktree-'));
  worktree = join(root, 'task');
  target = join(root, 'catalog');
  await fs.mkdir(worktree);
  await fs.mkdir(target);
  await fs.writeFile(join(target, 'SKILL.md'), 'Catalog skill');
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
});

afterEach(async () => {
  Object.defineProperty(process, 'platform', platform);
  vi.resetAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

function stubGitRemoval(onRemove: () => void) {
  return vi.mocked(execFile).mockImplementation((...args) => {
    if (Array.isArray(args[1]) && args[1][0] === 'worktree' && args[1][1] === 'remove') onRemove();
    const callback = args.at(-1) as (error: null, stdout: string, stderr: string) => void;
    callback(null, '', '');
    return {} as ReturnType<typeof execFile>;
  });
}

describe('removeWorktree on Windows (#2476)', () => {
  it('detaches skill junctions in both agent directories before invoking Git', async () => {
    const links: string[] = [];
    for (const dir of ['.agents', '.claude']) {
      const skills = join(worktree, dir, 'skills');
      await fs.mkdir(skills, { recursive: true });
      const link = join(skills, 'catalog');
      await fs.symlink(target, link, 'junction');
      links.push(link);
    }
    const git = stubGitRemoval(() => {
      for (const link of links) expect(existsSync(link)).toBe(false);
    });

    await removeWorktree(root, worktree, 'cez/task');

    expect(git).toHaveBeenCalledWith('git', ['worktree', 'remove', '--force', worktree], expect.anything(), expect.any(Function));
    expect(existsSync(worktree)).toBe(false);
    expect(await fs.readFile(join(target, 'SKILL.md'), 'utf8')).toBe('Catalog skill');
  });

  it('does not descend into a linked skills directory', async () => {
    await fs.mkdir(join(worktree, '.agents'));
    const skills = join(worktree, '.agents', 'skills');
    await fs.symlink(target, skills, 'junction');
    const git = stubGitRemoval(() => expect(existsSync(skills)).toBe(false));

    await removeWorktree(root, worktree);

    expect(git).toHaveBeenCalled();
    expect(await fs.readFile(join(target, 'SKILL.md'), 'utf8')).toBe('Catalog skill');
  });

  it('leaves cleanup pending when a junction cannot be detached', async () => {
    const skills = join(worktree, '.agents', 'skills');
    await fs.mkdir(skills, { recursive: true });
    const link = join(skills, 'catalog');
    await fs.symlink(target, link, 'junction');
    const git = stubGitRemoval(() => {});
    vi.mocked(unlink).mockRejectedValueOnce(new Error('access denied'));

    await removeWorktree(root, worktree, 'cez/task');

    expect(unlink).toHaveBeenCalledWith(link);
    expect(git).not.toHaveBeenCalled();
    expect(existsSync(worktree)).toBe(true);
  });
});
