import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { SkillSource } from '@cezar/core';
import { normalizeSkillSource } from '@cezar/core';
import { getActiveWorkspace } from '@/lib/workspace';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { readSkillBody } from '@/lib/skill-body';
import { getSkillActivationContext, isSkillActive } from '@/lib/skill-state';
import { SkillDetailView, type SkillDetail } from './skill-detail-view';

interface RepoSkillsRow {
  commit_sha: string | null;
  skills: unknown;
  fetched_at: string | null;
}

interface WorkflowBindingDbRow {
  step_id: string;
  skill_name: string | null;
  backend: string | null;
  model: string | null;
  extra_tools: unknown;
}

interface OverrideRow {
  body: string;
  execution_mode: string;
  triggers: unknown;
  outputs: unknown;
  capabilities: unknown;
  enabled: boolean;
  updated_at: string | null;
}

interface IssueRow {
  number: number;
  title: string;
}

interface ParsedSkill {
  name: string;
  description: string | null;
  suggestedStages: string[];
  path: string;
  source: SkillSource;
  /** Inlined body for sources that don't have a workspace-clone path (external-repo PR2). */
  body?: string;
}

interface ExternalSourceRow {
  id: string;
  name: string;
}

interface ExternalCacheRow {
  source_id: string;
  skills: unknown;
}

interface UploadedSkillRow {
  name: string;
  body: string;
  description: string | null;
  suggested_stages: unknown;
  updated_at: string;
}

interface SkillsShRow {
  name: string;
  source_slug: string;
  body: string;
  description: string | null;
  suggested_stages: unknown;
  install_url: string | null;
  last_synced_at: string;
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
        body: typeof o.body === 'string' ? o.body : undefined,
      };
    })
    .filter((s): s is ParsedSkill => s !== null);
}

function parseStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is string => typeof s === 'string');
}

export default async function SkillDetailPage({ params }: { params: Promise<{ name: string }> }) {
  const { name: rawName } = await params;
  const name = decodeURIComponent(rawName);

  const workspace = await getActiveWorkspace();
  if (!workspace) {
    return (
      <div className="px-6 py-6">
        <div className="rounded-md border border-dashed border-outline-variant bg-surface-container-low p-8 text-center text-sm text-on-surface-variant">
          No workspace selected.{' '}
          <Link href="/workspaces/new" className="text-primary hover:underline">
            Create one first
          </Link>
          .
        </div>
      </div>
    );
  }

  const supabase = createSupabaseAdminClient();
  const [
    { data: skillsRow },
    { data: bindingRows },
    { data: overrideRow },
    { data: issueRows },
    activation,
    { data: externalSourceRows },
    { data: uploadedRow },
    { data: skillsShRow },
  ] = await Promise.all([
    supabase
      .from('repo_skills')
      .select('commit_sha, skills, fetched_at')
      .eq('workspace_id', workspace.id)
      .eq('repo', workspace.repoName)
      .maybeSingle<RepoSkillsRow>(),
    supabase
      .from('workflow_bindings')
      .select('step_id, skill_name, backend, model, extra_tools')
      .eq('workspace_id', workspace.id)
      .is('repo', null)
      .returns<WorkflowBindingDbRow[]>(),
    supabase
      .from('skill_overrides')
      .select('body, execution_mode, triggers, outputs, capabilities, enabled, updated_at')
      .eq('workspace_id', workspace.id)
      .eq('skill_name', name)
      .maybeSingle<OverrideRow>(),
    supabase
      .from('issues')
      .select('number, title')
      .eq('workspace_id', workspace.id)
      .order('updated_at', { ascending: false })
      .limit(20)
      .returns<IssueRow[]>(),
    getSkillActivationContext(workspace.id, supabase),
    supabase
      .from('skill_sources')
      .select('id, name')
      .eq('workspace_id', workspace.id)
      .eq('kind', 'external-repo')
      .returns<ExternalSourceRow[]>(),
    // Issue #262 (PR 3) — disk uploads can shadow workspace skills on
    // collision-free names; check if this `name` came from disk.
    supabase
      .from('uploaded_skills')
      .select('name, body, description, suggested_stages, updated_at')
      .eq('workspace_id', workspace.id)
      .eq('name', name)
      .maybeSingle<UploadedSkillRow>(),
    // Issue #262 (PR 4) — same fallback for skills.sh imports.
    supabase
      .from('skills_sh_skills')
      .select('name, source_slug, body, description, suggested_stages, install_url, last_synced_at')
      .eq('workspace_id', workspace.id)
      .eq('name', name)
      .maybeSingle<SkillsShRow>(),
  ]);

  const parsed = parseSkills(skillsRow?.skills);
  let skill = parsed.find((s) => s.name === name);

  // Issue #262 PR2 — fall back to external_repo_skills when the skill isn't in
  // the workspace's repo_skills cache. Scoped by source_id so the service-role
  // client doesn't bleed cross-tenant cache bodies into the Node process.
  if (!skill) {
    const externalSourceIds = (externalSourceRows ?? []).map((row) => row.id);
    if (externalSourceIds.length > 0) {
      const { data: externalCacheRows } = await supabase
        .from('external_repo_skills')
        .select('source_id, skills')
        .in('source_id', externalSourceIds)
        .returns<ExternalCacheRow[]>();
      const seenNames = new Set(parsed.map((p) => p.name));
      for (const row of externalCacheRows ?? []) {
        for (const ext of parseSkills(row.skills)) {
          if (seenNames.has(ext.name)) continue;
          seenNames.add(ext.name);
          parsed.push({ ...ext, source: 'external-repo' });
        }
      }
      skill = parsed.find((s) => s.name === name);
    }
  }

  // Issue #262 PR3 — disk uploads come next in the fallback chain.
  const isDisk = !skill && uploadedRow !== null;
  if (isDisk) {
    skill = {
      name: uploadedRow!.name,
      description: uploadedRow!.description,
      suggestedStages: parseStringArray(uploadedRow!.suggested_stages),
      path: '',
      source: 'disk',
    };
  }

  // Issue #262 PR4 — skills.sh registry imports are the last fallback.
  const isSkillsSh = !skill && skillsShRow !== null;
  if (isSkillsSh) {
    skill = {
      name: skillsShRow!.name,
      description: skillsShRow!.description,
      suggestedStages: parseStringArray(skillsShRow!.suggested_stages),
      path: '',
      source: 'skills-sh',
    };
  }

  if (!skill) notFound();

  // Resolve the body source per provenance: disk / skills.sh / external all
  // inline the body in their DB cache; the legacy workspace/built-in/override
  // path still flows through `readSkillBody` against the workspace clone.
  const upstreamBody =
    isDisk || isSkillsSh
      ? null
      : skill.source === 'external-repo'
        ? (skill.body ?? null)
        : await readSkillBody(workspace.repoOwner, workspace.repoName, skill.path);

  const bindings = (bindingRows ?? []).filter((b) => b.skill_name === skill.name);
  const isOverride = !isDisk && !isSkillsSh && overrideRow !== null;

  // Issue #262 — runtime activation lives in `workspace_skill_states`, not
  // `skill_overrides.enabled`. Use the canonical predicate so the detail page
  // agrees with the catalog, the workflow picker, and the workflow runtime.
  const enabled = isSkillActive(activation.states.get(skill.name), skill.source, activation.seeded);

  // When an override exists, its body/metadata wins. Otherwise we surface the
  // upstream body and the metadata defaults (which the user can edit and save
  // to *create* the override).
  const detail: SkillDetail = {
    name: skill.name,
    description: skill.description,
    path: skill.path,
    body: isDisk
      ? uploadedRow!.body
      : isSkillsSh
        ? skillsShRow!.body
        : isOverride
          ? overrideRow!.body
          : upstreamBody,
    upstreamBody,
    source: isDisk ? 'disk' : isSkillsSh ? 'skills-sh' : isOverride ? 'override' : 'repo',
    enabled,
    overrideUpdatedAt: isDisk
      ? uploadedRow!.updated_at
      : isSkillsSh
        ? skillsShRow!.last_synced_at
        : isOverride
          ? overrideRow!.updated_at
          : null,
    metadata: {
      executionMode: isOverride ? overrideRow!.execution_mode : 'continuous',
      triggers: isOverride ? parseStringArray(overrideRow!.triggers) : ['issue-created'],
      outputs: isOverride ? parseStringArray(overrideRow!.outputs) : ['stdout.json'],
      capabilities: isOverride ? parseStringArray(overrideRow!.capabilities) : ['reasoning'],
    },
    stages: skill.suggestedStages,
    bindings: bindings.map((b) => ({
      stepId: b.step_id,
      backend: (b.backend as 'anthropic-api' | 'claude-cli' | 'codex-cli' | null) ?? null,
      model: b.model,
      extraTools: Array.isArray(b.extra_tools)
        ? (b.extra_tools as unknown[]).filter((t): t is string => typeof t === 'string')
        : [],
    })),
    commitSha: skillsRow?.commit_sha ?? null,
    fetchedAt: skillsRow?.fetched_at ?? null,
    testIssues: (issueRows ?? []).map((i) => ({ number: i.number, title: i.title })),
  };

  const isAdmin = workspace.role === 'admin';

  return <SkillDetailView skill={detail} readOnly={!isAdmin} />;
}
