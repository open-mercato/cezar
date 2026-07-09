import Link from 'next/link';
import { getSessionUser } from '@/lib/auth';
import { getActiveWorkspace } from '@/lib/workspace';
import { createSupabaseAdminClient, createSupabaseServerClient } from '@/lib/supabase/server';
import type { RunnerKind, RunnerStatus } from '@/lib/supabase/types';
import { PageContainer } from '@/components/ui/page-container';
import {
  RunnersSection,
  type RunnerRowView,
  type RunnerDisplayStatus,
  type JoinTokenView,
} from './runners-section';

interface RunnerDbRow {
  id: string;
  workspace_id: string | null;
  name: string;
  kind: RunnerKind;
  backends: string[];
  status: RunnerStatus;
  last_heartbeat_at: string | null;
  created_at: string;
  owner_user_id: string | null;
  owner_login: string | null;
}

interface JoinTokenDbRow {
  id: string;
  created_by: string;
  created_by_login: string;
  label: string;
  created_at: string;
  revoked_at: string | null;
}

const ONLINE_WINDOW_MS = 2 * 60_000;
const STALE_WINDOW_MS = 30 * 60_000;

/** Derive a display status from the last heartbeat (independent of the stored
 * `status` enum, which lags between heartbeats). */
function displayStatus(lastHeartbeatAt: string | null): RunnerDisplayStatus {
  if (!lastHeartbeatAt) return 'offline';
  const age = Date.now() - new Date(lastHeartbeatAt).getTime();
  if (Number.isNaN(age)) return 'offline';
  if (age <= ONLINE_WINDOW_MS) return 'online';
  if (age <= STALE_WINDOW_MS) return 'stale';
  return 'offline';
}

function toView(r: RunnerDbRow, currentUserId: string | null): RunnerRowView {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    backends: Array.isArray(r.backends) ? r.backends : [],
    displayStatus: displayStatus(r.last_heartbeat_at),
    lastHeartbeatAt: r.last_heartbeat_at,
    createdAt: r.created_at,
    managed: r.workspace_id == null,
    ownerLogin: r.owner_login,
    mine: r.owner_user_id != null && r.owner_user_id === currentUserId,
  };
}

export default async function RunnersPage() {
  const workspace = await getActiveWorkspace();

  if (!workspace) {
    return (
      <PageContainer max="max-w-[1080px]">
        <header className="mb-6">
          <h1 className="font-display text-xl sm:text-[28px] font-semibold leading-tight tracking-tight text-on-surface">
            Runners
          </h1>
        </header>
        <div className="rounded-lg border border-dashed border-outline-variant bg-surface-container-low p-8 text-center text-sm text-on-surface-variant">
          No workspace selected. Create one first.
        </div>
      </PageContainer>
    );
  }

  const user = await getSessionUser();
  const admin = createSupabaseAdminClient();
  // Join tokens go through the user-scoped client: RLS shows members their
  // own tokens and admins every token in the workspace.
  const userClient = await createSupabaseServerClient();
  const [{ data: ownRows }, { data: managedRows }, { data: tokenRows }] = await Promise.all([
    admin
      .from('runners')
      .select(
        'id, workspace_id, name, kind, backends, status, last_heartbeat_at, created_at, owner_user_id, owner_login',
      )
      .eq('workspace_id', workspace.id)
      .order('created_at', { ascending: true })
      .returns<RunnerDbRow[]>(),
    admin
      .from('runners')
      .select(
        'id, workspace_id, name, kind, backends, status, last_heartbeat_at, created_at, owner_user_id, owner_login',
      )
      .is('workspace_id', null)
      .order('created_at', { ascending: true })
      .returns<RunnerDbRow[]>(),
    userClient
      .from('runner_join_tokens')
      .select('id, created_by, created_by_login, label, created_at, revoked_at')
      .eq('workspace_id', workspace.id)
      .order('created_at', { ascending: false })
      .returns<JoinTokenDbRow[]>(),
  ]);

  const isAdmin = workspace.role === 'admin';
  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '') ||
    '';

  const joinTokens: JoinTokenView[] = (tokenRows ?? []).map((t) => ({
    id: t.id,
    label: t.label,
    createdByLogin: t.created_by_login,
    createdAt: t.created_at,
    revokedAt: t.revoked_at,
    mine: user != null && t.created_by === user.id,
  }));

  return (
    <PageContainer max="max-w-[1080px]">
      <header className="mb-6">
        <nav
          className="mb-2 flex items-center gap-2 text-xs text-on-surface-variant"
          aria-label="Breadcrumb"
        >
          <Link href="/settings" className="hover:text-on-surface">
            Settings
          </Link>
          <span className="text-outline">›</span>
          <span className="text-on-surface">Runners</span>
        </nav>
        <h1 className="font-display text-xl sm:text-[28px] font-semibold leading-tight tracking-tight text-on-surface">
          Runners
        </h1>
        <p className="mt-2 max-w-[820px] text-sm leading-relaxed text-on-surface-variant">
          Self-hosted runners pick up{' '}
          <code className="rounded bg-surface-container px-1 py-px font-mono text-[12px] text-on-surface">
            claude-cli
          </code>{' '}
          /{' '}
          <code className="rounded bg-surface-container px-1 py-px font-mono text-[12px] text-on-surface">
            codex-cli
          </code>{' '}
          jobs on your own infra under your own CLI login. Runners register themselves with a{' '}
          <strong className="font-medium text-on-surface">join token</strong> you mint below; a
          runner belongs to whoever minted its token, and jobs you request run on your runners. The
          managed cloud handles{' '}
          <code className="rounded bg-surface-container px-1 py-px font-mono text-[12px] text-on-surface">
            anthropic-api
          </code>{' '}
          jobs. See{' '}
          <code className="rounded bg-surface-container px-1 py-px font-mono text-[12px] text-on-surface">
            docs/runner-setup.md
          </code>{' '}
          for the full setup.
        </p>
      </header>

      <RunnersSection
        ownRunners={(ownRows ?? []).map((r) => toView(r, user?.id ?? null))}
        managedRunners={(managedRows ?? []).map((r) => toView(r, user?.id ?? null))}
        joinTokens={joinTokens}
        isAdmin={isAdmin}
        appUrl={appUrl}
      />
    </PageContainer>
  );
}
