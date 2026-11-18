import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Host-side skill writes may traverse only ordinary directories inside their checkout. */
export function skillDestination(cwd: string, ...parts: string[]): string {
  const root = realpathSync(cwd);
  const target = resolve(root, ...parts);
  const fromRoot = relative(root, target);
  if (!fromRoot || isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
    throw new Error('Skill destination is outside the checkout');
  }
  const entries = fromRoot.split(sep);
  let path = root;
  for (const [index, entry] of entries.entries()) {
    path = join(path, entry);
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory() && !(index === entries.length - 1 && stat.isFile())) {
        throw new Error(`Unsafe skill destination: ${entries.slice(0, index + 1).join('/')}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      break; // There are no entries below a missing ancestor.
    }
  }
  return target;
}

/** Replace the directory entry instead of opening a possibly hard-linked existing file for write. */
export function writeSkillFile(cwd: string, path: string, text: string): void {
  const target = skillDestination(cwd, path);
  mkdirSync(dirname(target), { recursive: true });
  const temp = join(dirname(target), `.cez-skill-${randomUUID()}`);
  try {
    writeFileSync(temp, text, { encoding: 'utf8', flag: 'wx' });
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
}
