/**
 * Display-only shortening of tool titles and commands: a task's tools run inside its worktree
 * (`<repo>/.ai/cezar/worktrees/<runId>`, `WORKTREES_DIR` server-side), so the absolute prefix is
 * the same noise on every row. The full text stays in the expanded card and the hover title.
 */

/** Characters that end a path token in a shell command. */
const STOP = `\\s'"\`;&|()<>`
/** An absolute path ending in a task worktree directory — any repo, any run id. */
const WORKTREE_ROOT = `(?:/[^${STOP}]*)?/\\.ai/cezar/worktrees/[^/${STOP}]+`

/** A leading `cd <worktree> &&` / `cd <worktree>;` (quoted or not), which only restates the cwd. */
const LEADING_CD = new RegExp(`^\\s*cd\\s+(['"]?)${WORKTREE_ROOT}/?\\1\\s*(?:&&|;)\\s*`)
/** `<worktree>/x` → `x`; a bare `<worktree>` → `.` (both only at a token start). */
const ROOT_WITH_SLASH = new RegExp(`(^|[${STOP}=:])${WORKTREE_ROOT}/`, 'g')
const BARE_ROOT = new RegExp(`(^|[${STOP}=:])${WORKTREE_ROOT}(?=$|[${STOP}])`, 'g')

export function shortenWorktreePaths(text: string): string {
  if (!text.includes('/.ai/cezar/worktrees/')) return text
  return text
    .replace(LEADING_CD, '')
    .replace(ROOT_WITH_SLASH, '$1')
    .replace(BARE_ROOT, '$1.')
}
