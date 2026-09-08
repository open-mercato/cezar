import type { UnitRole } from '@open-mercato/cezar-api-client'

import { cn } from '@/lib/utils'

/**
 * The rank badge on a unit run (spec `2026-09-08-units-hierarchy` §Cockpit).
 *
 * Deliberately the SAME chip the agents dock uses for a sub-agent's type (`agent-type` slot):
 * uppercase, 10.5px, tracked, `bg-muted`. A rank and an agent type are the same kind of fact —
 * "what this worker is" — so they read as one vocabulary rather than two.
 *
 * Caesar is the one exception, in violet: it is the mission's commander, and violet is already
 * this design system's "this is the thing in charge / this wants you" ink (the running dot, the
 * Guard banner). Status colour still lives only in the dot — a rank is not a status, and this
 * chip never changes with one.
 */

/** Display names, capitalized once here so no surface invents its own spelling. */
export const UNIT_ROLE_LABELS: Record<UnitRole, string> = {
  caesar: 'Caesar',
  legate: 'Legate',
  centurion: 'Centurion',
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
