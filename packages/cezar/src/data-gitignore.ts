import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `.ai/cezar/.gitignore` — keep run data out of the user's repo history while workflows and
 * skills stay committable (BACKWARD_COMPATIBILITY.md §3: any new run-data file is added here in
 * the same PR).
 *
 * Additive by construction: entries the user added stay, and a missing one is appended rather
 * than the file being rewritten. Never throws — a read-only repo means one un-ignored directory,
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
  'artifacts/', // agent-published pages per run (spec 2026-10-22-html-artifacts-and-impact)
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

export function ensureDataGitignore(repoRoot: string): void {
  const path = join(repoRoot, '.ai/cezar', '.gitignore');
  let fd: number | undefined;
  try {
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    // CodeQL22: exclusive creation preserves a concurrent creator. Never truncate or
    // reopen the pathname after reading it; append only through this descriptor.
    const flags = constants.O_RDWR | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
    try {
      fd = openSync(path, flags | constants.O_CREAT | constants.O_EXCL, 0o666);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
      fd = openSync(path, flags);
    }
    const opened = fstatSync(fd);
    const entry = lstatSync(path);
    // The identity check also protects platforms without O_NOFOLLOW.
    if (!opened.isFile() || !entry.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino) return;
    const current = readFileSync(fd, 'utf8');
    const lines = current.split('\n');
    const missing = DATA_GITIGNORE_ENTRIES.filter((w) => !lines.includes(w));
    if (missing.length > 0) {
      const glue = current && !current.endsWith('\n') ? '\n' : '';
      writeFileSync(fd, `${glue}${missing.join('\n')}\n`, 'utf8');
    }
  } catch {
    // non-fatal
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best-effort cleanup */ }
    }
  }
}
