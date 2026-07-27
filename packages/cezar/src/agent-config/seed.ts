import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { agentHomePaths } from '../paths.js';
import { CONFIG_FILES } from './catalog.js';

/**
 * Seed the agents' gitignored personal config layer into a run's worktree
 * (spec #404 §"The worktree problem"). A run's cwd is a worktree, so a repo-root
 * edit to a gitignored file (`.claude/settings.local.json`, `CLAUDE.local.md`)
 * would never reach the agent — the file does not exist there. Copying it in,
 * and excluding it via the shared `info/exclude`, makes the personal layer take
 * effect immediately without ever committing it. Mirrors `materializeSkillDir`.
 *
 * Only Claude's gitignored layer is seeded (the only vendor with a documented
 * untracked personal file). Tracked files keep honest "applies after commit"
 * semantics and are never touched here.
 */

function git(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, encoding: 'utf8' }, (err, stdout) =>
      resolve({ ok: !err, stdout: stdout ?? '' }),
    );
  });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

/** Append `line` to `info/exclude` only if it is not already present (idempotent across runs). */
async function ensureExcluded(commonGitDir: string, line: string): Promise<void> {
  const excludePath = join(commonGitDir, 'info', 'exclude');
  let current = '';
  try {
    current = await readFile(excludePath, 'utf8');
  } catch {
    // no exclude file yet — created below
  }
  const lines = current.split('\n').map((l) => l.trim());
  if (lines.includes(line)) return;
  await mkdir(dirname(excludePath), { recursive: true });
  const sep = current.length === 0 || current.endsWith('\n') ? '' : '\n';
  await writeFile(excludePath, `${current}${sep}${line}\n`, 'utf8');
}

/**
 * Copy the seeded personal-layer files from `repoRoot` into `worktreeCwd`.
 * Guards every file with `git check-ignore` so a file the user genuinely tracked
 * (against the vendor's advice) is neither copied nor excluded. Returns the
 * repo-relative paths actually seeded, for the caller's note. Never throws.
 */
export async function seedAgentConfigLocalLayer(
  repoRoot: string,
  worktreeCwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  if (worktreeCwd === repoRoot) return [];
  const home = agentHomePaths(env);
  const seeded: string[] = [];

  const commonDir = await git(worktreeCwd, ['rev-parse', '--git-common-dir']);
  if (!commonDir.ok) return [];
  const commonGitDir = commonDir.stdout.trim();
  const absCommonGitDir = commonGitDir.startsWith('/') ? commonGitDir : join(worktreeCwd, commonGitDir);

  for (const def of CONFIG_FILES) {
    if (!def.seeded) continue;
    const src = def.resolve(repoRoot, home);
    const rel = relative(repoRoot, src);
    // Never seed something outside the repo, or that isn't there.
    if (rel.startsWith('..') || !(await fileExists(src))) continue;
    // Only seed a genuinely-ignored file — never force-exclude a tracked one.
    const ignored = await git(repoRoot, ['check-ignore', '-q', '--', rel]);
    if (!ignored.ok) continue;

    const dest = join(worktreeCwd, rel);
    try {
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(src, dest);
      await ensureExcluded(absCommonGitDir, rel);
      seeded.push(rel);
    } catch {
      // best-effort: a seed failure must not fail the run
    }
  }
  return seeded;
}
