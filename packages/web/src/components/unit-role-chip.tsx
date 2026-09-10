import type { UnitRole } from '@open-mercato/cezar-api-client'

import { cn } from '@/lib/utils'

/**
 * The rank badge on a unit run (spec `2026-09-08-units-hierarchy` §Cockpit).
 *
 * The cockpit speaks plain hierarchy — commander, manager, worker — because that is what a user
 * is buying. The enum ids (`caesar`, `legate`, `centurion`) are cezar's Roman code names; they
 * are persisted on run records and in file paths, so they stay as they are.
 *
 * Deliberately the SAME chip the agents dock uses for a sub-agent's type (`agent-type` slot):
 * uppercase, 10.5px, tracked, `bg-muted`. The commander is the one exception, in violet: it is
 * the mission's root, and violet is already this design system's "this is the thing in charge"
 * ink. Status colour still lives only in the dot — a rank is not a status.
 */

/** Display names, capitalized once here so no surface invents its own spelling. */
export const UNIT_ROLE_LABELS: Record<UnitRole, string> = {
  caesar: 'Commander',
  legate: 'Manager',
  centurion: 'Worker',
}

export function UnitRoleChip({ role, className }: { role: UnitRole; className?: string }) {
  return (
    <span
      data-slot="unit-role"
      data-role={role}
      className={cn(
        'inline-block shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-semibold tracking-[0.05em] uppercase',
        role === 'caesar' ? 'bg-violet/15 text-violet' : 'bg-muted text-muted-foreground',
        className,
      )}
    >
      {UNIT_ROLE_LABELS[role]}
    </span>
  )
}
