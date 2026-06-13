import type { SkillSource } from '@cezar/core';
import { normalizeSkillSource } from '@cezar/core';
import { getActiveWorkspace } from '@/lib/workspace';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { PageContainer } from '@/components/ui/page-container';
import {
  getSkillActivationContext,
  isSkillDefaultActive,
  seedBuiltinSkillStatesIfNeeded,
} from '@/lib/skill-state';
import { isSkillsShConfigured } from '@/lib/skills-sh-api';
import { SkillsView, type SkillRow } from './skills-view';
import type { ExternalRepoSourceRow } from './external-sources-section';
import type { UploadedSkillRow } from './uploaded-skills-section';
import type { SkillsShImportRow } from './skills-sh-section';

interface RepoSkillsRow {
  commit_sha: string | null;
  skills: unknown;
  fetched_at: string | null;
}

interface OverrideRow {
  skill_name: string;
  enabled: boolean;
  execution_mode: string;
  updated_at: string | null;
}

interface ExternalSourceRow {
  id: string;
  name: string;
  config: unknown;
  last_synced_at: string | null;
  last_sync_error: string | null;
}

interface ExternalCacheRow {
  source_id: string;
  skills: unknown;
}

interface UploadedSkillsDbRow {
  name: string;
  body: string;
  description: string | null;
  suggested_stages: unknown;
  uploaded_at: string;
  updated_at: string;
}

interface SkillsShDbRow {
  id: string;
  name: string;
  source_slug: string;
  description: string | null;
  suggested_stages: unknown;
  install_url: string | null;
  last_synced_at: string;
  last_sync_error: string | null;
}

interface ExternalRepoConfig {
  owner: string;
  repo: string;
  branch: string;
  folder: string;
}

function parseExternalConfig(raw: unknown): ExternalRepoConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const owner = typeof o.owner === 'string' ? o.owner : null;
  const repo = typeof o.repo === 'string' ? o.repo : null;
  if (!owner || !repo) return null;
  return {
    owner,
    repo,
    branch: typeof o.branch === 'string' && o.branch ? o.branch : 'main',
    folder: typeof o.folder === 'string' && o.folder ? o.folder : '.ai/skills',
  };
}

interface ParsedSkill {
  name: string;
  description: string | null;
  suggestedStages: string[];
  path: string;
  /** Persisted by `refreshRepoSkills` since #issue-262 PR 1; older rows may
   *  still hold the legacy `'repo'` literal — bridged by `normalizeSkillSource`. */
  source: SkillSource;
}

function parseSkills(raw: unknown): ParsedSkill[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s): ParsedSkill | null => {
      if (!s || typeof s !== 'object') return null;
      const o = s as Record<string, unknown>;
      const name = typeof o.name === 'string' ? o.name : null;
      if (!name) return null;
      return {
        name,
        description: typeof o.description === 'string' ? o.description : null,
        suggestedStages: Array.isArray(o.suggestedStages)
          ? (o.suggestedStages as unknown[]).filter((x): x is string => typeof x === 'string')
          : [],
        path: typeof o.path === 'string' ? o.path : '',
        source: normalizeSkillSource(o.source),
      };
    })
    .filter((s): s is ParsedSkill => s !== null);
}

function inferTrigger(stages: string[]): SkillRow['trigger'] {
  const triageish = new Set([
    'bug-detector', 'priority', 'categorize', 'security', 'quality',
    'good-first-issue', 'missing-info', 'claim-detector',
    'contributor-welcome', 'recurring-questions', 'duplicates',
    'stale', 'done-detector', 'auto-label',
  ]);
  return stages.some((s) => triageish.has(s)) ? 'on-sync' : 'cron';
}

function inferMode(stages: string[]): SkillRow['mode'] {
  const framedish = new Set(['verify-in-repo', 'root-cause', 'fix', 'review', 'review-loop']);
  return stages.some((s) => framedish.has(s)) ? 'framed' : 'inline';
}

export default async function SkillsPage() {
  const workspace = await getActiveWorkspace();

  if (!workspace) {
    return (
      <PageContainer>
        <PageHeader />
        <div className="mt-6 rounded-md border border-dashed border-outline-variant bg-surface-container-low p-8 text-center text-sm text-on-surface-variant">
          No workspace selected. Create one first.
        </div>
      </PageContainer>
    );
  }

  const supabase = createSupabaseAdminClient();

  // Pull everything in parallel — repo_skills cache, overrides, the activation
  // context (per-skill state map + workspace seed marker), and the workspace's
  // external skill sources (issue #262 PR 2). The external cache is fetched in
  // a second step so it can be scoped by source_id — without that scoping the
  // service-role client would dump every workspace's cached bodies into memory.
  const [
    { data: skillsRow },
    { data: overrideRows },
    { states, seeded: workspaceSeeded },
    { data: externalSourceRows },
    { data: uploadedRows },
    { data: skillsShRows },
  ] = await Promise.all([
    supabase
      .from('repo_skills')
      .select('commit_sha, skills, fetched_at')
      .eq('workspace_id', workspace.id)
      .eq('repo', workspace.repoName)
      .maybeSingle<RepoSkillsRow>(),
    supabase
      .from('skill_overrides')
      .select('skill_name, enabled, execution_mode, updated_at')
      .eq('workspace_id', workspace.id)
      .returns<OverrideRow[]>(),
    getSkillActivationContext(workspace.id, supabase),
    supabase
      .from('skill_sources')
      .select('id, name, config, last_synced_at, last_sync_error')
      .eq('workspace_id', workspace.id)
      .eq('kind', 'external-repo')
      .returns<ExternalSourceRow[]>(),
    supabase
      .from('uploaded_skills')
      .select('name, body, description, suggested_stages, uploaded_at, updated_at')
      .eq('workspace_id', workspace.id)
      .order('uploaded_at', { ascending: false })
      .returns<UploadedSkillsDbRow[]>(),
    supabase
      .from('skills_sh_skills')
      .select('id, name, source_slug, description, suggested_stages, install_url, last_synced_at, last_sync_error')
      .eq('workspace_id', workspace.id)
      .order('imported_at', { ascending: false })
      .returns<SkillsShDbRow[]>(),
  ]);

  const externalSourceIds = (externalSourceRows ?? []).map((row) => row.id);
  const { data: externalCacheRows } = externalSourceIds.length > 0
    ? await supabase
        .from('external_repo_skills')
        .select('source_id, skills')
        .in('source_id', externalSourceIds)
        .returns<ExternalCacheRow[]>()
    : { data: [] as ExternalCacheRow[] };

  // `refreshRepoSkills` caches the merged catalog (built-in + repo) into
  // `repo_skills.skills`. For never-synced workspaces, fall back to the
  // built-ins shipped with @cezar/core so the page always lists something.
  let parsed = parseSkills(skillsRow?.skills);
  if (parsed.length === 0) {
    const core = await import('@cezar/core');
    try {
      const builtins = await core.discoverBuiltinSkills();
      parsed = builtins.map((s) => ({
        name: s.name,
        description: s.description ?? null,
        suggestedStages: s.suggestedStages,
        path: s.path,
        source: s.source,
      }));
    } catch {
      parsed = [];
    }
  }

  // Issue #262 (PR 2) — fold external repo cached catalogs into the workspace
  // catalog. Workspace + built-in entries win on name collisions because they
  // sit higher in `SKILL_SOURCE_PRIORITY`. External rows that survive the
  // dedupe show up with their own `source: 'external-repo'` badge.
  const cacheBySourceId = new Map<string, ExternalCacheRow>(
    (externalCacheRows ?? []).map((row) => [row.source_id, row]),
  );
  const externalSourceMeta = new Map<string, ExternalSourceRow>(
    (externalSourceRows ?? []).map((row) => [row.id, row]),
  );
  const seenNames = new Set(parsed.map((p) => p.name));
  const externalSkillCounts = new Map<string, number>();
  for (const sourceRow of externalSourceRows ?? []) {
    const cache = cacheBySourceId.get(sourceRow.id);
    const externalSkills = parseSkills(cache?.skills);
    externalSkillCounts.set(sourceRow.id, externalSkills.length);
    for (const skill of externalSkills) {
      if (seenNames.has(skill.name)) continue;
      seenNames.add(skill.name);
      parsed.push({ ...skill, source: 'external-repo' });
    }
  }

  // Issue #262 (PR 3) — disk uploads. Sit below external in
  // `SKILL_SOURCE_PRIORITY`, so they get dedup-shadowed by anything already
  // surfaced above. UI still lists them in the dedicated Uploaded section so
  // the user can manage shadowed uploads even when they don't show up in the
  // main catalog.
  for (const row of uploadedRows ?? []) {
    if (seenNames.has(row.name)) continue;
    seenNames.add(row.name);
    parsed.push({
      name: row.name,
      description: row.description,
      suggestedStages: Array.isArray(row.suggested_stages)
        ? (row.suggested_stages as unknown[]).filter((x): x is string => typeof x === 'string')
        : [],
      path: '',
      source: 'disk',
    });
  }

  // Issue #262 (PR 4) — skills.sh imports. Lowest priority — only surface in
  // the main catalog if nothing higher claimed the name. The Imports section
  // shows shadowed entries so they can still be managed (Refresh / Remove).
  for (const row of skillsShRows ?? []) {
    if (seenNames.has(row.name)) continue;
    seenNames.add(row.name);
    parsed.push({
      name: row.name,
      description: row.description,
      suggestedStages: Array.isArray(row.suggested_stages)
        ? (row.suggested_stages as unknown[]).filter((x): x is string => typeof x === 'string')
        : [],
      path: '',
      source: 'skills-sh',
    });
  }

  // Lazy seed: first time a workspace opens /skills, populate `enabled=true`
  // rows for every built-in so the Active list isn't empty out of the box.
  if (!workspaceSeeded && parsed.length > 0) {
    const seed = await seedBuiltinSkillStatesIfNeeded(
      workspace.id,
      false,
      parsed,
      supabase,
    );
    if (seed.seeded) {
      // Mirror what the seed wrote — built-in AND workspace-repo are the
      // implicit-consent sources (see `DEFAULT_ON_SOURCES` in skill-state.ts).
      for (const p of parsed) {
        if (
          (p.source === 'built-in' || p.source === 'workspace-repo') &&
          !states.has(p.name)
        ) {
          states.set(p.name, { enabled: true, pinnedSource: null });
        }
      }
    }
  }

  const overrideByName = new Map<string, OverrideRow>(
    (overrideRows ?? []).map((o) => [o.skill_name, o]),
  );

  const rows: SkillRow[] = parsed.map((s) => {
    const override = overrideByName.get(s.name);
    const state = states.get(s.name);
    const isOverridden = override !== undefined;
    // Active = explicit state row says enabled. Pre-seed built-ins fall back
    // to override.enabled or the canonical default-on rule (the seed already
    // mirrored built-in defaults into `states`).
    const active = state
      ? state.enabled
      : isOverridden
        ? override.enabled
        : isSkillDefaultActive(s.source, workspaceSeeded);
    return {
      name: s.name,
      description: s.description,
      path: s.path,
      source: isOverridden ? 'override' : s.source,
      mode: inferMode(s.suggestedStages),
      trigger: inferTrigger(s.suggestedStages),
      active,
      lastRunIso: isOverridden ? override.updated_at ?? null : null,
      stages: s.suggestedStages,
    };
  });

  const isAdmin = workspace.role === 'admin';

  const externalSources: ExternalRepoSourceRow[] = (externalSourceRows ?? [])
    .map((row): ExternalRepoSourceRow | null => {
      const cfg = parseExternalConfig(row.config);
      if (!cfg) return null;
      return {
        id: row.id,
        name: row.name,
        owner: cfg.owner,
        repo: cfg.repo,
        branch: cfg.branch,
        folder: cfg.folder,
        lastSyncedAt: row.last_synced_at,
        lastSyncError: row.last_sync_error,
        skillCount: externalSkillCounts.get(row.id) ?? 0,
      };
    })
    .filter((row): row is ExternalRepoSourceRow => row !== null);
  // Keep `externalSourceMeta` reference for a possible future "show name" column
  // — silence unused-var until then.
  void externalSourceMeta;

  const uploadedSkills: UploadedSkillRow[] = (uploadedRows ?? []).map((row) => ({
    name: row.name,
    description: row.description,
    uploadedAt: row.uploaded_at,
    updatedAt: row.updated_at,
  }));

  const skillsShImports: SkillsShImportRow[] = (skillsShRows ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    sourceSlug: row.source_slug,
    installUrl: row.install_url,
    lastSyncedAt: row.last_synced_at,
    lastSyncError: row.last_sync_error,
  }));

  return (
    <SkillsView
      rows={rows}
      overridesCount={overrideByName.size}
      commitSha={skillsRow?.commit_sha ?? null}
      fetchedAt={skillsRow?.fetched_at ?? null}
      readOnly={!isAdmin}
      externalSources={externalSources}
      uploadedSkills={uploadedSkills}
      skillsShImports={skillsShImports}
      skillsShConfigured={isSkillsShConfigured()}
    />
  );
}

function PageHeader() {
  return (
    <header className="mb-6">
      <h1 className="text-2xl font-semibold tracking-tight text-on-surface">Skills</h1>
      <p className="mt-1 text-sm text-on-surface-variant">
        Manage and monitor autonomous AI capabilities across your repositories.
      </p>
    </header>
  );
}
