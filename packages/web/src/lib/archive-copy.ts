/** Archiving reclaims the task's worktree (spec 2026-11-19-worktree-disk-usage §2): one line the
 *  Archive controls share so the cockpit says it the same way everywhere. */
export const ARCHIVE_FREES_WORKTREE = 'Frees its worktree on disk; the branch is kept and Continue restores it'

/** The Archive hint, plus the archived-task lifetime when the project's is known (0 = never). */
export function archiveDetail(deleteDays?: number): string {
  if (!deleteDays) return ARCHIVE_FREES_WORKTREE
  return `${ARCHIVE_FREES_WORKTREE}. Deleted after ${deleteDays} day${deleteDays === 1 ? '' : 's'} archived`
}
