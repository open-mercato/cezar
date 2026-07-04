import { getActiveWorkspace } from '@/lib/workspace';
import { getSessionUser } from '@/lib/auth';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { SettingsForm } from './settings-form';
import { TeamSection } from './team-section';
import { AutomationSection } from './automation-section';
import { LabelsSection, type AcceptedLabelRow } from './labels-section';
import { SettingsTabs, SettingsCard } from './settings-tabs';
import { PageContainer } from '@/components/ui/page-container';
import type {
  DigestMode,
  LabelAnalysisInputsSummary,
  LabelAnalysisResult,
  LabelAnalysisStatus,
  WorkspaceRole,
} from '@/lib/supabase/types';

async function loadWorkspaceConfig(workspaceId: string): Promise<{
  config: Record<string, unknown>;
  autoTriageEnabled: boolean;
  autofixEnabled: boolean;
  separateCommentPerStep: boolean;
  actionAutoComment: boolean;
  syncMode: 'auto' | 'manual';
  syncIntervalMinutes: number;
  digestMode: DigestMode;
  digestIntervalMinutes: number;
}> {
  const supabase = createSupabaseAdminClient();
  const { data } = await supabase
    .from('workspaces')
    .select(
      'config, auto_triage_enabled, autofix_enabled, separate_comment_per_step, action_auto_comment, sync_mode, sync_interval_minutes, digest_mode, digest_interval_minutes',
    )
    .eq('id', workspaceId)
    .single();
  return {
    config: (data?.config as Record<string, unknown>) ?? {},
    autoTriageEnabled: data?.auto_triage_enabled ?? true,
    autofixEnabled: data?.autofix_enabled ?? false,
    separateCommentPerStep: data?.separate_comment_per_step ?? false,
    actionAutoComment: data?.action_auto_comment ?? true,
    syncMode: data?.sync_mode ?? 'auto',
    syncIntervalMinutes: data?.sync_interval_minutes ?? 15,
    digestMode: data?.digest_mode ?? 'auto',
    digestIntervalMinutes: data?.digest_interval_minutes ?? 60,
  };
}

interface MemberRow {
  user_id: string;
  role: WorkspaceRole;
}

async function loadMembers(workspaceId: string) {
  const supabase = createSupabaseAdminClient();
  const { data } = await supabase
    .from('workspace_members')
    .select('user_id, role')
    .eq('workspace_id', workspaceId);

  if (!data) return [];

  const { data: authUsers } = await supabase.auth.admin.listUsers();
  const userMap = new Map(
    (authUsers?.users ?? []).map((u) => [
      u.id,
      {
        email: u.email ?? '',
        name: u.user_metadata?.full_name ?? u.user_metadata?.user_name ?? u.email ?? '',
        avatarUrl: u.user_metadata?.avatar_url ?? '',
      },
    ]),
  );

  return (data as MemberRow[]).map((m) => {
    const info = userMap.get(m.user_id);
    return {
      userId: m.user_id,
      email: info?.email ?? '',
      name: info?.name ?? m.user_id.slice(0, 8),
      avatarUrl: info?.avatarUrl ?? '',
      role: m.role,
    };
  });
}

export default async function SettingsPage() {
  const [workspace, user] = await Promise.all([getActiveWorkspace(), getSessionUser()]);

  if (!workspace || !user) {
    return (
      <PageContainer max="max-w-[1080px]">
        <header className="mb-6">
          <h1 className="font-display text-xl font-semibold leading-tight tracking-tight text-on-surface sm:text-2xl lg:text-[28px]">
            Settings
          </h1>
        </header>
        <div className="rounded-lg border border-dashed border-outline-variant bg-surface-container-low p-8 text-center text-sm text-on-surface-variant">
          No workspace selected. Create one first.
        </div>
      </PageContainer>
    );
  }

  const [
    {
      config,
      autoTriageEnabled,
      autofixEnabled,
      separateCommentPerStep,
      actionAutoComment,
      syncMode,
      syncIntervalMinutes,
      digestMode,
      digestIntervalMinutes,
    },
    members,
    labelsInitial,
    acceptedLabels,
  ] = await Promise.all([
    loadWorkspaceConfig(workspace.id),
    loadMembers(workspace.id),
    loadLabelsInitial(workspace.id),
    loadAcceptedLabels(workspace.id),
  ]);
  const isAdmin = workspace.role === 'admin';

  return (
    <SettingsTabs
      workspace={{
        name: workspace.name,
        repoOwner: workspace.repoOwner,
        repoName: workspace.repoName,
        role: workspace.role,
      }}
      automation={
        <SettingsCard
          title="Automation"
          description="How aggressively Cezar acts on incoming GitHub events. Defaults are safe; turning autofix on lets Cezar open draft PRs without a human in the loop."
        >
          <AutomationSection
            autoTriageEnabled={autoTriageEnabled}
            autofixEnabled={autofixEnabled}
            separateCommentPerStep={separateCommentPerStep}
            actionAutoComment={actionAutoComment}
            syncMode={syncMode}
            syncIntervalMinutes={syncIntervalMinutes}
            digestMode={digestMode}
            digestIntervalMinutes={digestIntervalMinutes}
            readOnly={!isAdmin}
          />
        </SettingsCard>
      }
      team={
        <SettingsCard
          title="Team"
          description="Workspace members and their roles. Only admins can invite, remove, or change roles."
        >
          <TeamSection members={members} isAdmin={isAdmin} currentUserId={user.id} />
        </SettingsCard>
      }
      configuration={
        <SettingsCard
          title="Configuration"
          description="Low-level autofix knobs — sync cadence, model selection, attempt budgets. Most workspaces leave the defaults alone."
        >
          <SettingsForm config={config} readOnly={!isAdmin} />
        </SettingsCard>
      }
      labels={
        <SettingsCard
          title="Labels"
          description="Per-repo labeling guide. Cezar analyses your label usage and produces a catalog with descriptions, when to add, and when to remove — for issues and PRs separately."
        >
          <LabelsSection
            initial={labelsInitial}
            acceptedLabels={acceptedLabels}
            readOnly={!isAdmin}
          />
        </SettingsCard>
      }
    />
  );
}

interface LabelsInitialAnalysis {
  id: string;
  status: LabelAnalysisStatus;
  started_at: string | null;
  finished_at: string | null;
  result: LabelAnalysisResult | null;
  error: string | null;
  inputs_summary: LabelAnalysisInputsSummary | null;
  created_at: string;
  updated_at: string;
}

async function loadLabelsInitial(workspaceId: string): Promise<{
  analysis: LabelsInitialAnalysis | null;
  acceptedLabelCount: number;
}> {
  const supabase = createSupabaseAdminClient();
  const { data: analyses } = await supabase
    .from('workspace_label_analyses')
    .select(
      'id, status, started_at, finished_at, result, error, inputs_summary, created_at, updated_at',
    )
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(1);
  const { count } = await supabase
    .from('workspace_labels')
    .select('*', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId);
  return {
    analysis: (analyses?.[0] as LabelsInitialAnalysis | undefined) ?? null,
    acceptedLabelCount: count ?? 0,
  };
}

async function loadAcceptedLabels(workspaceId: string): Promise<AcceptedLabelRow[]> {
  const supabase = createSupabaseAdminClient();
  const { data } = await supabase
    .from('workspace_labels')
    .select(
      'id, name, scope, color, description, when_to_add, when_to_remove, add_meaning, remove_meaning, exists_on_github, source',
    )
    .eq('workspace_id', workspaceId)
    .order('scope', { ascending: true })
    .order('name', { ascending: true });
  return (data ?? []) as AcceptedLabelRow[];
}
