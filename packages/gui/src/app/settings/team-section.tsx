'use client';

import { useActionState, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { cn } from '@/components/ui/cn';
import { TrashIcon } from '@/components/icons';
import { inviteMember, changeMemberRole, removeMember, type TeamActionState } from './team-actions';
import type { WorkspaceRole } from '@/lib/supabase/types';

interface Member {
  userId: string;
  email: string;
  name: string;
  avatarUrl: string;
  role: WorkspaceRole;
}

interface TeamSectionProps {
  members: Member[];
  isAdmin: boolean;
  currentUserId: string;
}

export function TeamSection({ members, isAdmin, currentUserId }: TeamSectionProps) {
  const [inviteState, inviteAction, invitePending] = useActionState<TeamActionState, FormData>(
    inviteMember,
    {},
  );
  const router = useRouter();
  const [memberError, setMemberError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onRoleChange = (userId: string, role: WorkspaceRole): void => {
    setMemberError(null);
    startTransition(async () => {
      const res = await changeMemberRole(userId, role);
      if (!res?.ok) setMemberError(res?.error ?? 'Failed to change role');
      else router.refresh();
    });
  };

  const onRemove = (userId: string, label: string): void => {
    if (!confirm(`Remove ${label} from this workspace?`)) return;
    setMemberError(null);
    startTransition(async () => {
      const res = await removeMember(userId);
      if (!res?.ok) setMemberError(res?.error ?? 'Failed to remove member');
      else router.refresh();
    });
  };

  return (
    <div className="space-y-6">
      {memberError && (
        <div className="rounded-md border border-error/40 bg-error/10 px-3 py-2 text-xs text-error">
          {memberError}
        </div>
      )}
      {/* Members table (md+) */}
      <div className="hidden overflow-hidden rounded-md border border-outline-variant md:block">
        <table className="min-w-full text-sm">
          <thead className="bg-surface-container">
            <tr>
              <Th>Member</Th>
              <Th>Role</Th>
              {isAdmin && <Th className="text-right">Actions</Th>}
            </tr>
          </thead>
          <tbody>
            {members.map((m, idx) => (
              <tr
                key={m.userId}
                className={cn(
                  'transition-colors hover:bg-surface-container/60',
                  idx > 0 && 'border-t border-outline-variant/60',
                )}
              >
                <td className="px-4 py-3 align-middle">
                  <div className="flex items-center gap-3">
                    {m.avatarUrl ? (
                      <img src={m.avatarUrl} alt="" className="h-8 w-8 rounded-md object-cover" />
                    ) : (
                      <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary-container text-xs font-semibold text-primary-on-container">
                        {initialsOf(m.name || m.email)}
                      </div>
                    )}
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-on-surface">{m.name}</div>
                      <div className="truncate text-xs text-on-surface-variant">{m.email}</div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 align-middle">
                  {isAdmin && m.userId !== currentUserId ? (
                    <select
                      value={m.role}
                      onChange={(e) => onRoleChange(m.userId, e.target.value as WorkspaceRole)}
                      disabled={pending}
                      className="min-h-11 rounded-md border border-outline-variant bg-surface px-2 text-xs text-on-surface focus:border-primary focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 lg:h-8 lg:min-h-0"
                    >
                      <option value="admin">admin</option>
                      <option value="actor">actor</option>
                      <option value="viewer">viewer</option>
                    </select>
                  ) : (
                    <RoleChip role={m.role}>
                      {m.role}
                      {m.userId === currentUserId && (
                        <span className="ml-1 text-outline">· you</span>
                      )}
                    </RoleChip>
                  )}
                </td>
                {isAdmin && (
                  <td className="px-4 py-3 text-right align-middle">
                    {m.userId !== currentUserId && (
                      <button
                        onClick={() => onRemove(m.userId, m.name || m.email)}
                        disabled={pending}
                        className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-outline-variant text-on-surface-variant transition-colors hover:border-error/40 hover:text-error disabled:cursor-not-allowed disabled:opacity-50 lg:h-7 lg:w-7"
                        title="Remove member"
                        aria-label={`Remove ${m.name || m.email}`}
                      >
                        <TrashIcon className="h-4 w-4" />
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
            {members.length === 0 && (
              <tr>
                <td
                  colSpan={isAdmin ? 3 : 2}
                  className="px-4 py-6 text-center text-sm text-on-surface-variant"
                >
                  No members yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Members cards (< md) */}
      <div className="space-y-3 md:hidden">
        {members.length === 0 ? (
          <div className="rounded-md border border-outline-variant px-4 py-6 text-center text-sm text-on-surface-variant">
            No members yet.
          </div>
        ) : (
          members.map((m) => (
            <div
              key={m.userId}
              className="rounded-md border border-outline-variant bg-surface-container-low p-3"
            >
              <div className="flex items-center gap-3">
                {m.avatarUrl ? (
                  <img
                    src={m.avatarUrl}
                    alt=""
                    className="h-9 w-9 shrink-0 rounded-md object-cover"
                  />
                ) : (
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary-container text-xs font-semibold text-primary-on-container">
                    {initialsOf(m.name || m.email)}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-on-surface">{m.name}</div>
                  <div className="truncate text-xs text-on-surface-variant">{m.email}</div>
                </div>
              </div>
              <div className="mt-3 flex items-center gap-2">
                {isAdmin && m.userId !== currentUserId ? (
                  <>
                    <select
                      value={m.role}
                      onChange={(e) => onRoleChange(m.userId, e.target.value as WorkspaceRole)}
                      disabled={pending}
                      className="h-11 flex-1 rounded-md border border-outline-variant bg-surface px-2 text-base text-on-surface focus:border-primary focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <option value="admin">admin</option>
                      <option value="actor">actor</option>
                      <option value="viewer">viewer</option>
                    </select>
                    <button
                      onClick={() => onRemove(m.userId, m.name || m.email)}
                      disabled={pending}
                      className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-outline-variant text-on-surface-variant transition-colors hover:border-error/40 hover:text-error disabled:cursor-not-allowed disabled:opacity-50"
                      aria-label={`Remove ${m.name || m.email}`}
                    >
                      <TrashIcon className="h-4 w-4" />
                    </button>
                  </>
                ) : (
                  <RoleChip role={m.role}>
                    {m.role}
                    {m.userId === currentUserId && <span className="ml-1 text-outline">· you</span>}
                  </RoleChip>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Invite form */}
      {isAdmin && (
        <form
          action={inviteAction}
          className="rounded-md border border-outline-variant bg-surface-container/40 p-4"
        >
          <div className="mb-3 font-display text-[11px] font-semibold uppercase tracking-[0.05em] text-on-surface-variant">
            Invite a member
          </div>
          <div className="flex flex-col flex-wrap items-stretch gap-3 sm:flex-row sm:items-end">
            <div className="w-full sm:min-w-[220px] sm:flex-1">
              <label htmlFor="invite-email" className="mb-1 block text-xs text-on-surface-variant">
                Email
              </label>
              <input
                id="invite-email"
                name="email"
                type="email"
                inputMode="email"
                placeholder="user@example.com"
                required
                className="h-9 w-full rounded-md border border-outline-variant bg-surface px-3 text-base text-on-surface placeholder:text-outline focus:border-primary focus:outline-none lg:text-sm"
              />
            </div>
            <div className="w-full sm:w-auto">
              <label htmlFor="invite-role" className="mb-1 block text-xs text-on-surface-variant">
                Role
              </label>
              <select
                id="invite-role"
                name="role"
                className="h-9 w-full rounded-md border border-outline-variant bg-surface px-3 text-base text-on-surface focus:border-primary focus:outline-none sm:w-auto lg:text-sm"
              >
                <option value="actor">actor</option>
                <option value="admin">admin</option>
                <option value="viewer">viewer</option>
              </select>
            </div>
            <button
              type="submit"
              disabled={invitePending}
              className="inline-flex h-9 w-full items-center justify-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-on transition-colors hover:bg-primary-container hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
            >
              {invitePending ? 'Inviting…' : 'Invite'}
            </button>
            <div className="flex items-center gap-2 text-xs sm:ml-auto">
              {inviteState.ok && <span className="text-primary">Invited</span>}
              {inviteState.error && <span className="text-error">{inviteState.error}</span>}
            </div>
          </div>
        </form>
      )}
    </div>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={cn(
        'whitespace-nowrap px-4 py-3 text-left font-display text-[11px] font-semibold uppercase tracking-[0.05em] text-on-surface-variant',
        className,
      )}
    >
      {children}
    </th>
  );
}

function RoleChip({ role, children }: { role: WorkspaceRole; children: React.ReactNode }) {
  const tone =
    role === 'admin'
      ? 'border-primary/30 bg-primary/10 text-primary'
      : role === 'actor'
        ? 'border-tertiary/30 bg-tertiary/10 text-tertiary'
        : 'border-outline-variant bg-surface-container text-on-surface-variant';
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border px-2 py-0.5 font-mono text-[11px]',
        tone,
      )}
    >
      {children}
    </span>
  );
}

function initialsOf(s: string): string {
  return s
    .split(/[\s@.]+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}
