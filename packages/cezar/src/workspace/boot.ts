import { runMigrations } from './migrations.ts';
import { registerProject, shouldAutoRegisterProject } from './projects.ts';

/**
 * Boot-time workspace bookkeeping (spec 2026-07-20-multi-project-workspace,
 * "Boot flow"): run pending `~/.cezar` migrations first, then register the
 * boot repo in the per-user project registry — but only while that registry
 * is still empty (`shouldAutoRegisterProject`). Once the user has projects,
 * booting elsewhere serves the folder without adding it; adding is then an
 * explicit gesture (`cezar projects add`, the cockpit's Add project dialog).
 * Registration is also suppressed for task worktrees and `$HOME` itself — the
 * process still serves those folders normally. Strictly non-fatal: the
 * zero-config law says a broken or read-only home degrades to a smaller
 * cockpit, never a failed boot, so any workspace error logs one warning and
 * boot continues.
 *
 * Returns the boot project's registry id when registration happened —
 * `serveCommand` plumbs it into the server (`ServerDeps.bootProjectId`) so
 * `/api/v1/projects` and `/api/v1/health` can name the boot project without a
 * lookup. Undefined when registration was suppressed or the workspace is
 * unavailable; the server then derives a fallback on its own and lists the
 * boot folder as an unregistered project.
 *
 * Its own module rather than a private function in `src/index.ts`: this is the
 * one place that decides whether starting cezar somewhere writes to the user's
 * registry, and `src/index.ts` runs `main()` on import, so a test could not
 * reach it there. Every boot path (`serve`, `run`, and the single-project
 * `projects list`) goes through this function.
 */
export async function initWorkspace(repoRoot: string): Promise<string | undefined> {
  try {
    await runMigrations({ bootRepoRoot: repoRoot });
    if (await shouldAutoRegisterProject(repoRoot)) return (await registerProject(repoRoot)).id;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[cez] workspace registry unavailable (${message}) — continuing without it`);
  }
  return undefined;
}
