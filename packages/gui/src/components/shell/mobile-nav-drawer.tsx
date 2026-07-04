'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { signOut } from '@/app/auth/actions';
import { NavItems } from './nav-items';
import { WorkspaceSwitcher } from '../sidebar';
import { CloseIcon } from '../icons';
import { cn } from '../ui/cn';
import { useScrollLock } from '@/lib/use-scroll-lock';
import { useFocusTrap } from '@/lib/use-focus-trap';
import type { SessionUser } from '@/lib/auth';
import type { ActiveWorkspace, WorkspaceListItem } from '@/lib/workspace';

interface MobileNavDrawerProps {
  open: boolean;
  onClose: () => void;
  user: SessionUser;
  workspace: ActiveWorkspace | null;
  workspaces: WorkspaceListItem[];
}

/**
 * Off-canvas left navigation drawer for `< lg` (spec §3.3). Reuses the shared
 * `NavItems` + `WorkspaceSwitcher` so the nav definition lives in one place.
 * Locks background scroll, traps focus, and closes on backdrop tap, Esc, and
 * route change.
 */
export function MobileNavDrawer({
  open,
  onClose,
  user,
  workspace,
  workspaces,
}: MobileNavDrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();

  useScrollLock(open);
  useFocusTrap(open, panelRef, { onEscape: onClose });

  // Close on route change so a nav tap doesn't leave the drawer open.
  useEffect(() => {
    if (open) onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  const initials = (user.name || user.email || '?')
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <div className={cn('lg:hidden', open ? '' : 'pointer-events-none')} aria-hidden={!open}>
      {/* Backdrop */}
      <div
        onClick={onClose}
        className={cn(
          'fixed inset-0 z-backdrop bg-black/60 transition-opacity duration-200 motion-reduce:transition-none',
          open ? 'opacity-100' : 'opacity-0',
        )}
        aria-hidden
      />

      {/* Panel */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        className={cn(
          'fixed inset-y-0 left-0 z-overlay flex w-[min(20rem,85vw)] flex-col overflow-y-auto border-r border-outline-variant bg-surface-container-low pb-[env(safe-area-inset-bottom)] shadow-ambient transition-transform duration-200 motion-reduce:transition-none',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        {/* Header: brand + close */}
        <div className="flex items-center justify-between px-4 pt-[calc(0.75rem+env(safe-area-inset-top))] pb-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-on-surface">Cezar</div>
            <div className="truncate text-xs text-on-surface-variant">
              {workspace ? `${workspace.repoOwner}/${workspace.repoName}` : 'Global Workspace'}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close navigation"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface-container hover:text-on-surface"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        {/* Workspace switcher */}
        {workspace && workspaces.length > 1 ? (
          <div className="mb-3 px-3">
            <WorkspaceSwitcher current={workspace} workspaces={workspaces} />
          </div>
        ) : null}

        {/* Nav */}
        <nav className="flex flex-col gap-1 px-3">
          <NavItems />
          {workspace?.role === 'admin' && (
            <Link
              href="/workspaces/new"
              className="mt-1 flex min-h-11 items-center rounded-md px-3 py-2 text-sm text-on-surface-variant hover:bg-surface-container hover:text-on-surface"
            >
              + New workspace
            </Link>
          )}
        </nav>

        {/* User block + sign out */}
        <div className="mt-auto border-t border-outline-variant p-4">
          <div className="flex items-center gap-3">
            {user.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={user.avatarUrl} alt="" className="h-9 w-9 rounded-md object-cover" />
            ) : (
              <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary-container text-sm font-semibold text-primary-on-container">
                {initials || 'CZ'}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-on-surface">
                {user.name || 'Cezar User'}
              </div>
              <div className="truncate text-xs text-on-surface-variant">
                {workspace?.role === 'admin' ? 'Admin Account' : (workspace?.role ?? user.email)}
              </div>
            </div>
          </div>
          <form action={signOut}>
            <button
              type="submit"
              className="mt-3 flex min-h-11 w-full items-center rounded-md px-2 py-1.5 text-left text-xs text-on-surface-variant hover:bg-surface-container hover:text-on-surface"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
