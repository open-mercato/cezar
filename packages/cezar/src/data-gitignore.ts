import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  'worktrees/',
  'tmp/', // per-run agent temp directories (#785)
  'drafts/', // unsent composer text + pasted screenshots (#939) — never in git history
  'todos.json',
  'todos.json.tmp',
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
] as const;

export function ensureDataGitignore(repoRoot: string): void {
  const path = join(repoRoot, '.ai/cezar', '.gitignore');
  try {
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const lines = current.split('\n');
    const missing = DATA_GITIGNORE_ENTRIES.filter((w) => !lines.includes(w));
    if (missing.length > 0) {
      const glue = current && !current.endsWith('\n') ? '\n' : '';
      writeFileSync(path, `${current}${glue}${missing.join('\n')}\n`, 'utf8');
    }
  } catch {
    // non-fatal
  }
}
