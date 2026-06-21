'use client';

import { useMemo } from 'react';
import { BellIcon } from './icons';
import { SyncIndicator } from './sync-indicator';
import type { Database } from '@/lib/supabase/types';

type SyncStatusRow = Database['public']['Tables']['sync_status']['Row'];

interface TopBarProps {
  user: { id: string; email: string; name: string; avatarUrl: string };
  workspaceId: string | null;
  readOnly: boolean;
  initialSyncStatus: SyncStatusRow | null;
  syncMode: 'auto' | 'manual';
  syncIntervalMinutes: number;
  webhookHealth: 'live' | 'polling';
  lastWebhookAt: string | null;
}

export function TopBar({
  user,
  workspaceId,
  readOnly,
  initialSyncStatus,
  syncMode,
  syncIntervalMinutes,
  webhookHealth,
  lastWebhookAt,
}: TopBarProps) {
  const initials = useMemo(
    () =>
      (user.name || user.email || '?')
        .split(/\s+/)
        .map((p) => p[0])
        .filter(Boolean)
        .slice(0, 2)
        .join('')
        .toUpperCase(),
    [user.name, user.email],
  );

  return (
    <header className="sticky top-0 z-sticky hidden h-topbar items-center justify-end gap-4 border-b border-outline-variant bg-surface px-6 backdrop-blur lg:flex">
      <div className="flex items-center gap-2">
        {workspaceId && (
          <SyncIndicator
            workspaceId={workspaceId}
            readOnly={readOnly}
            initialStatus={initialSyncStatus}
            syncMode={syncMode}
            syncIntervalMinutes={syncIntervalMinutes}
            webhookHealth={webhookHealth}
            lastWebhookAt={lastWebhookAt}
          />
        )}

        <button
          type="button"
          className="flex h-9 w-9 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface-container hover:text-on-surface"
          aria-label="Notifications"
        >
          <BellIcon className="h-5 w-5" />
        </button>

        <div className="mx-2 h-6 w-px bg-outline-variant" aria-hidden />

        <div className="flex items-center gap-2 pr-1">
          <div className="text-sm font-medium text-on-surface">{user.name || 'Cezar'}</div>
          {user.avatarUrl ? (
            <img src={user.avatarUrl} alt="" className="h-8 w-8 rounded-md object-cover" />
          ) : (
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary-container text-xs font-semibold text-primary-on-container">
              {initials || 'CZ'}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
