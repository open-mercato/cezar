'use client';

import { useState } from 'react';
import { Sidebar } from '../sidebar';
import { TopBar } from '../topbar';
import { MobileTopBar } from './mobile-topbar';
import { MobileNavDrawer } from './mobile-nav-drawer';
import { BottomTabBar } from './bottom-tab-bar';
import { Toaster } from '../ui/toaster';
import type { SessionUser } from '@/lib/auth';
import type { ActiveWorkspace, WorkspaceListItem } from '@/lib/workspace';
import type { Database } from '@/lib/supabase/types';

type SyncStatusRow = Database['public']['Tables']['sync_status']['Row'];

interface AppShellProps {
  user: SessionUser;
  workspace: ActiveWorkspace | null;
  workspaces: WorkspaceListItem[];
  workspaceId: string | null;
  readOnly: boolean;
  initialSyncStatus: SyncStatusRow | null;
  syncMode: 'auto' | 'manual';
  syncIntervalMinutes: number;
  webhookHealth: 'live' | 'polling';
  lastWebhookAt: string | null;
  children: React.ReactNode;
}

/**
 * Responsive app shell (spec §3.3). Desktop (`lg+`) is visually identical to the
 * old static two-column layout — the `Sidebar` (`hidden lg:flex`) + desktop
 * `TopBar` (`hidden lg:flex`) restore it. Below `lg` the sidebar/topbar drop out
 * and the `MobileTopBar` + `MobileNavDrawer` + (`< sm`) `BottomTabBar` take over.
 */
export function AppShell({
  user,
  workspace,
  workspaces,
  workspaceId,
  readOnly,
  initialSyncStatus,
  syncMode,
  syncIntervalMinutes,
  webhookHealth,
  lastWebhookAt,
  children,
}: AppShellProps) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const openNav = () => setMobileNavOpen(true);
  const closeNav = () => setMobileNavOpen(false);

  const topBarUser = {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
  };
  const workspaceLabel = workspace ? `${workspace.repoOwner}/${workspace.repoName}` : null;

  return (
    <Toaster>
      <div className="flex min-h-screen min-h-dvh">
        <Sidebar user={user} workspace={workspace} workspaces={workspaces} />

        <div className="flex min-h-screen min-h-dvh flex-1 flex-col overflow-x-hidden">
          {/* Desktop top bar (hidden lg:flex inside the component) */}
          <TopBar
            user={topBarUser}
            workspaceId={workspaceId}
            readOnly={readOnly}
            initialSyncStatus={initialSyncStatus}
            syncMode={syncMode}
            syncIntervalMinutes={syncIntervalMinutes}
            webhookHealth={webhookHealth}
            lastWebhookAt={lastWebhookAt}
          />

          {/* Mobile/tablet top bar (flex lg:hidden inside the component) */}
          <MobileTopBar
            onOpenNav={openNav}
            user={topBarUser}
            workspaceLabel={workspaceLabel}
            workspaceId={workspaceId}
            readOnly={readOnly}
            initialSyncStatus={initialSyncStatus}
            syncMode={syncMode}
            syncIntervalMinutes={syncIntervalMinutes}
            webhookHealth={webhookHealth}
            lastWebhookAt={lastWebhookAt}
          />

          {/* Bottom padding (`< sm`) keeps content clear of the BottomTabBar +
            safe area; reset at `sm`. */}
          <main className="flex-1 pb-[calc(4rem+env(safe-area-inset-bottom))] sm:pb-0">
            {children}
          </main>
        </div>

        <MobileNavDrawer
          open={mobileNavOpen}
          onClose={closeNav}
          user={user}
          workspace={workspace}
          workspaces={workspaces}
        />

        <BottomTabBar onOpenNav={openNav} />
      </div>
    </Toaster>
  );
}
