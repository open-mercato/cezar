import Link from 'next/link';
import { signOut } from '@/app/auth/actions';
import { switchWorkspace } from '@/app/workspace/actions';
import { NavItems } from './shell/nav-items';
import type { SessionUser } from '@/lib/auth';
import type { ActiveWorkspace, WorkspaceListItem } from '@/lib/workspace';
import { cn } from './ui/cn';

interface SidebarProps {
  user: SessionUser;
  workspace: ActiveWorkspace | null;
  workspaces: WorkspaceListItem[];
}

export function Sidebar({ user, workspace, workspaces }: SidebarProps) {
  const initials = (user.name || user.email || '?')
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <aside className="sticky top-0 hidden h-screen w-sidebar shrink-0 flex-col overflow-y-auto border-r border-outline-variant bg-surface-container-low lg:flex">
      {/* Brand */}
      <div className="px-6 pt-6 pb-5">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 880 200"
          className="h-7 w-auto text-on-surface"
          fill="currentColor"
          role="img"
          aria-label="Cezar"
        >
          <title>Cezar</title>
          <path fillRule="evenodd" d="M20 20H180V180H20ZM52 52H148V148H52ZM76 70L76 130L126 100Z" />
          <g transform="translate(127 0)">
            <path
              fillRule="evenodd"
              d="M73 20H183V52H105V148H183V180H73ZM209 20H319V52H241V84H297V116H241V148H319V180H209ZM345 20H455V52L385 148H455V180H345V148L415 52H345ZM481 180L511 20H561L591 180ZM520 110L530 50H542L552 110ZM513 180L525 130H547L559 180ZM617 20H727V102H649V180H617ZM649 42H705V80H649ZM649 102H681L727 180H695Z"
            />
          </g>
        </svg>
        <div className="mt-2 text-xs text-on-surface-variant">
          {workspace ? `${workspace.repoOwner}/${workspace.repoName}` : 'Global Workspace'}
        </div>
      </div>

      {/* Workspace switcher (compact, optional) */}
      {workspace ? (
        workspaces.length > 1 ? (
          <div className="mb-3 px-3">
            <WorkspaceSwitcher current={workspace} workspaces={workspaces} />
          </div>
        ) : null
      ) : (
        <div className="mb-3 px-3">
          <Link
            href="/workspaces/new"
            className="block rounded-md border border-dashed border-outline-variant px-3 py-2 text-center text-xs text-on-surface-variant hover:border-primary hover:text-on-surface"
          >
            + Add workspace
          </Link>
        </div>
      )}

      {/* Nav */}
      <nav className="flex flex-col gap-1 px-3">
        <NavItems />
        {workspace?.role === 'admin' && (
          <Link
            href="/workspaces/new"
            className="mt-1 rounded-md px-3 py-2 text-sm text-on-surface-variant hover:bg-surface-container hover:text-on-surface"
          >
            + New workspace
          </Link>
        )}
      </nav>

      {/* User block at bottom */}
      <div className="mt-auto border-t border-outline-variant p-4">
        <div className="flex items-center gap-3">
          {user.avatarUrl ? (
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
            className="mt-3 w-full rounded-md px-2 py-1.5 text-left text-xs text-on-surface-variant hover:bg-surface-container hover:text-on-surface"
          >
            Sign out
          </button>
        </form>
      </div>
    </aside>
  );
}

export function WorkspaceSwitcher({
  current,
  workspaces,
}: {
  current: ActiveWorkspace;
  workspaces: WorkspaceListItem[];
}) {
  return (
    <div className="flex flex-col gap-1">
      {workspaces.map((ws) => (
        <form key={ws.id} action={switchWorkspace.bind(null, ws.id)}>
          <button
            type="submit"
            className={cn(
              'w-full rounded-md border px-3 py-2 text-left transition-colors',
              ws.id === current.id
                ? 'border-primary/40 bg-surface-container'
                : 'border-transparent hover:border-outline-variant hover:bg-surface-container',
            )}
          >
            <div className="truncate text-xs font-medium text-on-surface">{ws.name}</div>
            <div className="truncate text-xs text-on-surface-variant">
              {ws.repoOwner}/{ws.repoName}
            </div>
          </button>
        </form>
      ))}
    </div>
  );
}
