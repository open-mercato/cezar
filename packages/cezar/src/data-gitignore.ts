import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * `.ai/cezar/.gitignore` — keep run data out of the user's repo history while workflows and
 * skills stay committable (BACKWARD_COMPATIBILITY.md §3: any new run-data file is added here in
 * the same PR).
 *
 * Additive by construction: entries the user added stay, and a missing one is appended rather
 * than the file being rewritten. A file the user committed is left alone (#1486): its missing
 * entries go to the repo's `info/exclude` instead, so a release never dirties the checkout. Never throws — a read-only repo means one un-ignored directory,
 * not a failed boot.
 *
 * Lives in its own module rather than in `index.ts` so it can be tested: importing `index.ts`
 * runs the CLI.
 */
export const DATA_GITIGNORE_ENTRIES = [
  'runs.json',
  'runs.json.tmp',
  'runs/',
  'webhooks/', // project-private signing keys and delivery snapshots
  'dispatch/', // filesystem channel for dispatched task trees
  // The per-project attachment library (#929): every named file a user attaches to any task is
  // copied here. It is USER content — a production log, an internal PDF, a brief — so it must
  // never surface in their `git status`, let alone ride a `git add -A` into a public repo. This
  // list is a per-entry allowlist rather than a blanket `*` on purpose (`workflows/` and
  // `skills/` alongside it are meant to be committable), which means a new state directory that
  // is not named here is covered by nothing at all. `data-gitignore.test.ts` guards that rule.
  'attachments/',
  'worktrees/',
  'lifecycle/', // independent durable worktree preparation/cleanup history
  'config.lifecycle.lock/',
  'config.json.*.tmp',
  'tmp/', // per-run agent temp directories (#785)
  'drafts/',
  // Per-task workspace layouts (spec `2026-10-07-task-workspace` §5.3): a screen preference, not repo content.
  'layouts/', // unsent composer text + pasted screenshots (#939) — never in git history
  'todos.json',
  'todos.json.tmp',
  // Private, per-project MCP servers (spec 2026-10-07-private-project-mcp) — personal tokens.
  'mcp.local.json',
  'mcp.local.json.cez-tmp-*',
  'tracker.json',
  'tracker.json.tmp',
  'tracker.json.*.tmp',
  'tracker-association.lock/',
  'launch-key',
  'automations.json',
  'automations.json.tmp',
  'automation-state.json',
  'automation-state.json.tmp',
  'automation-receipts.ndjson',
  'automation-receipts.ndjson.tmp',
  'automation-log.ndjson',
  'automation-log.ndjson.tmp',
  'automation-poll.lock',
  'automation-poll.lock.guard/',
  'automation-mutation.lock.guard/',
  'automation-mutation.lock',
] as const;

/** cezar's own data directory as a git pathspec exclusion. An in-place task's Changes and its
 *  landing commit leave it out (spec 2026-10-20-trunk-based-projects): its config, ui-state and
 *  .gitignore are not untracked by default, but they are never the task's work. */
export const CEZAR_DATA_EXCLUDE = ':(exclude).ai/cezar';

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).toString();
}

/** True only when git confirms the file is tracked; any git failure (non-git dir, no git) is false. */
function isTracked(repoRoot: string, path: string): boolean {
  try { git(repoRoot, ['ls-files', '--error-unmatch', '--', path]); return true; } catch { return false; }
}

/** The file's text, or null when it is absent: reading directly leaves no check-then-use window. */
function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Mirror the missing entries into `info/exclude` (shared by task worktrees). Never throws. */
function excludeMissing(repoRoot: string, tracked: string[]): void {
  try {
    const raw = git(repoRoot, ['rev-parse', '--git-path', 'info/exclude']).trim();
    if (!raw) return;
    const file = isAbsolute(raw) ? raw : resolve(repoRoot, raw);
    const current = readIfPresent(file) ?? '';
    const lines = current.split('\n');
    const missing = DATA_GITIGNORE_ENTRIES
      .filter((w) => !tracked.includes(w))
      .map((w) => `/.ai/cezar/${w}`)
      .filter((w) => !lines.includes(w));
    if (missing.length === 0) return;
    mkdirSync(dirname(file), { recursive: true });
    const glue = current && !current.endsWith('\n') ? '\n' : '';
    writeFileSync(file, `${current}${glue}${missing.join('\n')}\n`, 'utf8');
  } catch {
    // non-fatal: read-only exclude leaves entries un-ignored, never a failed boot
  }
}

export function ensureDataGitignore(repoRoot: string): void {
  const path = join(repoRoot, '.ai/cezar', '.gitignore');
  try {
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    const existing = readIfPresent(path);
    const current = existing ?? '';
    const lines = current.split('\n');
    if (existing !== null && isTracked(repoRoot, path)) {
      excludeMissing(repoRoot, lines);
      return;
    }
    const missing = DATA_GITIGNORE_ENTRIES.filter((w) => !lines.includes(w));
    if (missing.length > 0) {
      const glue = current && !current.endsWith('\n') ? '\n' : '';
      writeFileSync(path, `${current}${glue}${missing.join('\n')}\n`, 'utf8');
    }
  } catch {
    // non-fatal
  }
}
