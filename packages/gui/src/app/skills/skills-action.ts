'use server';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { revalidatePath } from 'next/cache';
import { getSessionUser } from '@/lib/auth';
import { getActiveWorkspace } from '@/lib/workspace';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { loadWorkspaceConfig } from '@/lib/load-workspace-config';
import { ensureRepoClone, withRepoLock } from '@/lib/repo-clone';

const exec = promisify(execFile);

export interface RefreshSkillsResult {
  ok: boolean;
  error?: string;
  count?: number;
}

/**
 * Re-discovers `<repo>/<skillsDir>/**\/*.md` skills from a fresh clone of the
 * workspace repo and caches their metadata in `repo_skills`. Admin-only.
 *
 * Prefers a GitHub App installation token when the App is configured (§3.9),
 * falling back to the caller's per-user OAuth token.
 */
export async function refreshRepoSkills(): Promise<RefreshSkillsResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: 'Not authenticated' };
  const workspace = await getActiveWorkspace();
  if (!workspace) return { ok: false, error: 'No workspace selected' };
  if (workspace.role !== 'admin') return { ok: false, error: 'Only admins can refresh skills' };

  const supabase = await createSupabaseServerClient();
  const config = await loadWorkspaceConfig(workspace.id, supabase, {
    repoOwner: workspace.repoOwner,
    repoName: workspace.repoName,
  });

  const owner = workspace.repoOwner;
  const repo = workspace.repoName;
  const baseBranch = config.autofix.baseBranch || 'main';
  const skillsDir = config.autofix.skillsDir || '.ai/skills';

  // Resolve a GitHub token: prefer a GitHub App installation token if the App
  // is configured; fall back to the user's OAuth token. Wrapped so an App
  // failure degrades to OAuth rather than failing the whole action.
  const core = await import('@cezar/core');
  let token = user.githubToken || process.env.GITHUB_TOKEN || '';
  if (core.GitHubAppService.isConfigured()) {
    try {
      token = await new core.GitHubAppService().getInstallationToken(owner);
    } catch (err) {
      // Fall back to OAuth — log for visibility but don't fail here.
      console.warn('[refreshRepoSkills] GitHub App token failed, falling back to OAuth:', err);
    }
  }
  if (!token) return { ok: false, error: 'No GitHub token — sign out and back in to refresh' };

  // Hold the per-repo worktree lock across the clone + reads (rev-parse +
  // discoverSkills) so a concurrent triage/autofix job can't checkout/reset the
  // shared tree out from under us (see withRepoLock in lib/repo-clone).
  let commitSha: string | null = null;
  let skills: Awaited<ReturnType<typeof core.discoverSkills>>;
  try {
    ({ commitSha, skills } = await withRepoLock(owner, repo, async () => {
      const repoRoot = await ensureRepoClone(owner, repo, token, baseBranch);
      let sha: string | null = null;
      try {
        const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
        sha = stdout.trim() || null;
      } catch {
        sha = null;
      }
      return { commitSha: sha, skills: await core.discoverSkills(repoRoot, skillsDir) };
    }));
  } catch (err) {
    return {
      ok: false,
      error: `Clone failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // discoverSkills now returns the merged catalog (built-in shipped with
  // Cezar + repo skills under .ai/skills). We cache both so the GUI doesn't
  // need to re-discover built-ins on every render — the source field tells
  // the UI which chip to show.
  const metadata = skills.map((s) => ({
    name: s.name,
    description: s.description ?? null,
    suggestedStages: s.suggestedStages,
    path: s.path,
    source: s.source,
  }));

  const { error } = await supabase.from('repo_skills').upsert(
    {
      workspace_id: workspace.id,
      repo,
      commit_sha: commitSha,
      skills: metadata,
      fetched_at: new Date().toISOString(),
    },
    { onConflict: 'workspace_id,repo' },
  );
  if (error) return { ok: false, error: error.message };

  revalidatePath('/skills');
  return { ok: true, count: skills.length };
}
