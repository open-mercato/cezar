import type { Skill, SkillSource } from '@cezar/core';
import { getActiveWorkspace } from '@/lib/workspace';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { PageContainer } from '@/components/ui/page-container';
import {
  getWorkspaceSkillStates,
  seedBuiltinSkillStatesIfNeeded,
} from '@/lib/skill-state';
import { SkillsView, type SkillRow } from './skills-view';

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

interface ParsedSkill {
  name: string;
  description: string | null;
  suggestedStages: string[];
  path: string;
  /** Persisted by `refreshRepoSkills` since #issue-262 PR 1; older rows may
   *  still hold the legacy `'repo'` literal — normalized in `normalizeSource`. */
  source: SkillSource;
}

function normalizeSource(raw: unknown): SkillSource {
  // Legacy `repo_skills` rows wrote `'repo'`; map it onto the new vocabulary.
  if (raw === 'repo') return 'workspace-repo';
  if (
    raw === 'built-in' ||
    raw === 'workspace-repo' ||
    raw === 'external-repo' ||
    raw === 'disk' ||
    raw === 'skills-sh'
  ) {
    return raw;
  }
  // Unknown / missing — best-effort fallback. The catalog merge below replaces
  // it with the authoritative source when the same name appears in another row.
  return 'workspace-repo';
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
        source: normalizeSource(o.source),
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

  // Pull everything in parallel — repo_skills cache, overrides, the per-skill
  // enabled flags, and the workspace's seed marker.
  const [
    { data: skillsRow },
    { data: overrideRows },
    states,
    { data: workspaceRow },
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
    getWorkspaceSkillStates(workspace.id, supabase),
    supabase
      .from('workspaces')
      .select('skill_states_seeded')
      .eq('id', workspace.id)
      .maybeSingle<{ skill_states_seeded: boolean }>(),
  ]);

  // `refreshRepoSkills` caches the merged catalog (built-in + repo) into
  // `repo_skills.skills`. For never-synced workspaces, fall back to the
  // built-ins shipped with @cezar/core so the page always lists something.
  let parsed = parseSkills(skillsRow?.skills);
  if (parsed.length === 0) {
    const core = await import('@cezar/core');
    try {
      const builtins = await core.discoverBuiltinSkills();
      parsed = builtins.map((s: Skill) => ({
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

  // Lazy seed: first time a workspace opens /skills, populate `enabled=true`
  // rows for every built-in so the Active list isn't empty out of the box.
  const workspaceSeeded = workspaceRow?.skill_states_seeded ?? false;
  if (!workspaceSeeded && parsed.length > 0) {
    const seed = await seedBuiltinSkillStatesIfNeeded(
      workspace.id,
      false,
      parsed.map<Skill>((p) => ({
        name: p.name,
        description: p.description ?? undefined,
        body: '',
        path: p.path,
        suggestedStages: p.suggestedStages,
        source: p.source,
      })),
      supabase,
    );
    if (seed.seeded) {
      for (const p of parsed) {
        if (p.source === 'built-in' && !states.has(p.name)) {
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
    // to override.enabled or the seeded default (the seed already mirrored
    // built-in defaults into `states`).
    const active = state
      ? state.enabled
      : isOverridden
        ? override.enabled
        : !workspaceSeeded && s.source === 'built-in';
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

  return (
    <SkillsView
      rows={rows}
      overridesCount={overrideByName.size}
      commitSha={skillsRow?.commit_sha ?? null}
      fetchedAt={skillsRow?.fetched_at ?? null}
      readOnly={!isAdmin}
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
