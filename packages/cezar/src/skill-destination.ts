import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Host-side skill writes may traverse only ordinary directories inside their checkout. */
export function skillDestination(cwd: string, ...parts: string[]): string {
  return resolveSkillDestination(cwd, parts, false);
}

/** Ordinary team skills also support a linked directory whose canonical target is in the checkout. */
export function linkedTeamSkillDestination(cwd: string, path: string): string {
  return resolveSkillDestination(cwd, [path], true);
}

function checkoutRelativePath(root: string, target: string): string {
  const fromRoot = relative(root, target);
  if (!fromRoot || isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
    throw new Error('Skill destination is outside the checkout');
  }
  return fromRoot;
}

function resolveSkillDestination(cwd: string, parts: string[], allowDirectoryLinks: boolean): string {
  const root = realpathSync(cwd);
  const entries = checkoutRelativePath(root, resolve(root, ...parts)).split(sep);
  let path = root;
  for (const [index, entry] of entries.entries()) {
    path = join(path, entry);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) return join(path, ...entries.slice(index + 1));
    if (allowDirectoryLinks && stat.isSymbolicLink()) {
      const resolved = realpathSync(path);
      checkoutRelativePath(root, resolved);
      if (lstatSync(resolved).isDirectory()) {
        path = resolved;
        continue;
      }
    }
    if (stat.isDirectory() || (index === entries.length - 1 && stat.isFile())) continue;
    throw new Error(`Unsafe skill destination: ${entries.slice(0, index + 1).join('/')}`);
  }
  return path;
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
