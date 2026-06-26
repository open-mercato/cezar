'use server';

import { resolve, sep } from 'node:path';
import { revalidatePath } from 'next/cache';
import type { Skill } from '@cezar/core';
import { getSessionUser } from '@/lib/auth';
import { getActiveWorkspace } from '@/lib/workspace';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import {
  ensureExternalRepoClone,
  readExternalRepoHead,
  redactTokenFromMessage,
  withExternalRepoLock,
} from '@/lib/external-repo-clone';

/**
 * Issue #262 (PR 2) — admin-only CRUD + sync for external skill repos.
 *
 * "External" here means any GitHub repo that's not the workspace's own. The
 * workspace repo continues to live under `repo_skills` and reuses
 * `refreshRepoSkills()`. These actions cover the second source kind from the
 * roadmap; PR 3 (disk) and PR 4 (skills.sh) add their own.
 */

export type ActionResult<T = {}> = (T & { ok: true }) | { ok: false; error: string };

export interface ExternalRepoConfigInput {
  owner: string;
  repo: string;
  branch?: string;
  folder?: string;
}

const DEFAULT_BRANCH = 'main';
const DEFAULT_FOLDER = '.ai/skills';

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/i;
const OWNER_PATTERN = /^[a-z0-9][a-z0-9-]{0,38}$/i;
const REPO_PATTERN = /^[a-z0-9._-]{1,100}$/i;
// Reject leading `-` so `git checkout <branch>` can't interpret it as a flag.
const BRANCH_PATTERN = /^(?!-)[^\s~^:?*\\]{1,250}$/;
// Repo-relative subpath: ASCII alnum + `._-/`, no leading `/`, no `..` segments.
// Forbids both absolute paths and traversal so `resolve(repoRoot, folder)` can
// never climb out of the cloned worktree.
const FOLDER_PATTERN = /^[A-Za-z0-9._/-]{1,250}$/;

function validateInput(
  name: string,
  config: ExternalRepoConfigInput,
): { ok: true; cfg: Required<ExternalRepoConfigInput> } | { ok: false; error: string } {
  if (!NAME_PATTERN.test(name)) {
    return { ok: false, error: 'name must be alphanumeric + `-`/`_` (max 63 chars)' };
  }
  if (!OWNER_PATTERN.test(config.owner)) {
    return { ok: false, error: 'owner must be a valid GitHub login' };
  }
  if (!REPO_PATTERN.test(config.repo)) {
    return { ok: false, error: 'repo must be a valid GitHub repo name' };
  }
  const branch = (config.branch ?? DEFAULT_BRANCH).trim() || DEFAULT_BRANCH;
  const folder = (config.folder ?? DEFAULT_FOLDER).trim() || DEFAULT_FOLDER;
  if (!BRANCH_PATTERN.test(branch)) {
    return { ok: false, error: 'branch contains invalid characters or starts with `-`' };
  }
  if (!FOLDER_PATTERN.test(folder)) {
    return { ok: false, error: 'folder must be a repo-relative subpath (ASCII alnum + `._-/`)' };
  }
  // Belt-and-braces against `..` segments slipping past the regex.
  if (folder.startsWith('/') || folder.split('/').some((seg) => seg === '..')) {
    return { ok: false, error: 'folder cannot be absolute or contain `..` segments' };
  }
  return {
    ok: true,
    cfg: { owner: config.owner, repo: config.repo, branch, folder },
  };
}

export async function addExternalRepoSource(params: {
  name: string;
  config: ExternalRepoConfigInput;
}): Promise<ActionResult<{ id: string }>> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: 'Not authenticated' };
  const workspace = await getActiveWorkspace();
  if (!workspace) return { ok: false, error: 'No workspace selected' };
  if (workspace.role !== 'admin') {
    return { ok: false, error: 'Only admins can add skill sources' };
  }

  const validated = validateInput(params.name, params.config);
  if (!validated.ok) return validated;

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from('skill_sources')
    .insert({
      workspace_id: workspace.id,
      kind: 'external-repo',
      name: params.name,
      config: validated.cfg,
      created_by: user.id,
      updated_by: user.id,
    })
    .select('id')
    .single();
  if (error || !data) {
    return { ok: false, error: error?.message ?? 'insert failed' };
  }
  revalidatePath('/skills');
  revalidatePath('/workflows', 'layout');
  return { ok: true, id: data.id };
}

export async function updateExternalRepoSource(params: {
  id: string;
  name: string;
  config: ExternalRepoConfigInput;
}): Promise<ActionResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: 'Not authenticated' };
  const workspace = await getActiveWorkspace();
  if (!workspace) return { ok: false, error: 'No workspace selected' };
  if (workspace.role !== 'admin') {
    return { ok: false, error: 'Only admins can update skill sources' };
  }

  const validated = validateInput(params.name, params.config);
  if (!validated.ok) return validated;

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from('skill_sources')
    .update({
      name: params.name,
      config: validated.cfg,
      updated_by: user.id,
    })
    .eq('id', params.id)
    .eq('workspace_id', workspace.id)
    .select('id')
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  // Stale ID or cross-workspace target: predicate matched zero rows. Surface
  // it as a real error so the UI doesn't show 'updated' on a silent no-op.
  if (!data) return { ok: false, error: 'skill source not found' };
  revalidatePath('/skills');
  revalidatePath('/workflows', 'layout');
  return { ok: true };
}

export async function removeExternalRepoSource(id: string): Promise<ActionResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: 'Not authenticated' };
  const workspace = await getActiveWorkspace();
  if (!workspace) return { ok: false, error: 'No workspace selected' };
  if (workspace.role !== 'admin') {
    return { ok: false, error: 'Only admins can remove skill sources' };
  }

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from('skill_sources')
    .delete()
    .eq('id', id)
    .eq('workspace_id', workspace.id)
    .select('id')
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: 'skill source not found' };

  // NOTE: workspace_skill_states rows whose skill_name was only in this
  // source's cache survive the delete (no FK). They're at worst inactive
  // cruft; the runtime ignores them when no skill of that name is loaded.
  // Cross-source cleanup is intentionally deferred — naively dropping the
  // names would also wipe legitimate state for built-in/workspace-repo
  // skills that happen to share the name. A future migration with a
  // source_id-aware state model is the right place for this cleanup.

  revalidatePath('/skills');
  revalidatePath('/workflows', 'layout');
  return { ok: true };
}

export async function refreshExternalRepoSource(
  id: string,
): Promise<ActionResult<{ count: number }>> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: 'Not authenticated' };
  const workspace = await getActiveWorkspace();
  if (!workspace) return { ok: false, error: 'No workspace selected' };
  if (workspace.role !== 'admin') {
    return { ok: false, error: 'Only admins can sync skill sources' };
  }

  const supabase = createSupabaseAdminClient();
  const { data: source, error: loadError } = await supabase
    .from('skill_sources')
    .select('id, workspace_id, kind, config')
    .eq('id', id)
    .eq('workspace_id', workspace.id)
    .single();
  if (loadError || !source) {
    return { ok: false, error: loadError?.message ?? 'source not found' };
  }
  if (source.kind !== 'external-repo') {
    return { ok: false, error: `unsupported source kind: ${source.kind}` };
  }

  const config = source.config as {
    owner?: string;
    repo?: string;
    branch?: string;
    folder?: string;
  } | null;
  if (!config?.owner || !config.repo) {
    return { ok: false, error: 'source config missing owner/repo' };
  }
  const owner = config.owner;
  const repo = config.repo;
  const branch = config.branch || DEFAULT_BRANCH;
  const folder = config.folder || DEFAULT_FOLDER;

  // Resolve a GitHub token: prefer a GitHub App installation token if the App
  // is configured *and* installed on the external owner; fall back to the
  // caller's OAuth token; then to the ambient GITHUB_TOKEN. Public repos work
  // without any token at all (helper accepts null).
  const core = await import('@cezar/core');
  let token: string | null = user.githubToken || process.env.GITHUB_TOKEN || null;
  if (core.GitHubAppService.isConfigured()) {
    try {
      token = await new core.GitHubAppService().getInstallationToken(owner);
    } catch (err) {
      console.warn(
        `[refreshExternalRepoSource] App token for ${owner} failed, falling back: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  let commitSha: string | null = null;
  let skills: Skill[];
  try {
    ({ commitSha, skills } = await withExternalRepoLock(id, async () => {
      const repoRoot = await ensureExternalRepoClone(id, { owner, repo, branch }, token);
      const sha = await readExternalRepoHead(id);
      // Belt-and-braces containment check: regex above already forbids absolute
      // paths and `..` segments, but assert the resolved path is still inside
      // the clone before handing it to `discoverSkills` (which uses
      // `resolve(repoRoot, folder)`).
      const resolvedFolder = resolve(repoRoot, folder);
      if (resolvedFolder !== repoRoot && !resolvedFolder.startsWith(repoRoot + sep)) {
        throw new Error('folder escapes the clone root');
      }
      const discovered = await core.discoverSkills(repoRoot, folder);
      // Force the external-repo source label — `discoverSkills` defaults to
      // 'workspace-repo' for anything it finds outside the built-in dir.
      const tagged: Skill[] = discovered
        .filter((s) => s.source !== 'built-in')
        .map((s) => ({ ...s, source: 'external-repo' as const }));
      return { commitSha: sha, skills: tagged };
    }));
  } catch (err) {
    // Defense in depth — `gitTokenEnv` keeps the token out of argv, so it
    // shouldn't appear in execFile's error message. Scrub anyway in case a
    // pre-fix clone left a token-bearing URL in `.git/config` that surfaces
    // through git's stderr.
    const rawMessage = err instanceof Error ? err.message : String(err);
    const message = redactTokenFromMessage(rawMessage, token);
    await supabase
      .from('skill_sources')
      .update({ last_sync_error: message, updated_by: user.id })
      .eq('id', id)
      .eq('workspace_id', workspace.id);
    return { ok: false, error: `sync failed: ${message}` };
  }

  // Persist body inline — dispatch never re-clones.
  const cached = skills.map((s) => ({
    name: s.name,
    description: s.description ?? null,
    suggestedStages: s.suggestedStages,
    path: s.path,
    source: 'external-repo' as const,
    body: s.body,
  }));

  const now = new Date().toISOString();
  const { error: upsertError } = await supabase.from('external_repo_skills').upsert(
    {
      source_id: id,
      commit_sha: commitSha,
      skills: cached,
      fetched_at: now,
    },
    { onConflict: 'source_id' },
  );
  if (upsertError) return { ok: false, error: upsertError.message };

  await supabase
    .from('skill_sources')
    .update({
      last_synced_at: now,
      last_sync_error: null,
      updated_by: user.id,
    })
    .eq('id', id)
    .eq('workspace_id', workspace.id);

  revalidatePath('/skills');
  revalidatePath('/workflows', 'layout');
  return { ok: true, count: skills.length };
}
