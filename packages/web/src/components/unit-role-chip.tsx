import type { ReactNode } from 'react'
import type { UnitRole, UnitSize } from '@open-mercato/cezar-api-client'

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/**
 * The rank badge on a unit run (spec `2026-09-08-units-hierarchy` §Cockpit).
 *
 * The cockpit speaks plain hierarchy — commander, manager, worker — because that is what a user
 * is buying. The Roman names cezar's ranks are modelled on live in the tooltip, with the line of
 * history that explains why the rank exists at all. The enum ids (`caesar`, `legate`,
 * `centurion`) are persisted on run records and in file paths, so they stay as they are.
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

/** The Roman inspiration behind each rank — what the tooltip tells whoever hovers. */
export const UNIT_ROLE_LORE: Record<UnitRole, { roman: string; history: string }> = {
  caesar: {
    roman: 'Caesar',
    history:
      'The imperator set the campaign’s objective and commanded his legions through legates; he planned, judged and decided, and rarely fought himself.',
  },
  legate: {
    roman: 'Legate',
    history:
      'The legatus legionis, a senator Caesar appointed to command one legion of about five thousand men. He turned the campaign plan into orders for his centurions and answered to Caesar for the result.',
  },
  centurion: {
    roman: 'Centurion',
    history:
      'The professional officer who commanded a century of about eighty legionaries. Promoted from the ranks, he led from the front — the rank that actually did the fighting.',
  },
}

/** The mission sizes, in the same plain language, with their Roman shape in the tooltip. */
export const UNIT_SIZE_LABELS: Record<UnitSize, string> = {
  legionary: 'Single task',
  squad: 'Team',
  army: 'Hierarchy',
}

export const UNIT_SIZE_LORE: Record<UnitSize, { roman: string; history: string }> = {
  legionary: {
    roman: 'Legionary',
    history: 'One soldier of the legion, one task — a plain cezar run, exactly as today.',
  },
  squad: {
    roman: 'Contubernium',
    history:
      'Eight legionaries who shared a tent and fought as one under their centurion. Here: a worker and the sub-agents it dispatches itself.',
  },
  army: {
    roman: 'Legion',
    history:
      'Caesar’s army: cohorts of centuries under legates, one commander, one objective. Here: a commander that delegates to managers and workers and reports once.',
  },
}

/** A hover card with the Roman name and its history — shared by the rank chip and the size cards. */
export function RomanTooltip({
  lore,
  children,
}: {
  lore: { roman: string; history: string }
  children: ReactNode
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent className="max-w-72 text-left" data-slot="roman-tooltip">
          <span className="block font-semibold">{lore.roman}</span>
          <span className="block text-contrast-foreground/80">{lore.history}</span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export function UnitRoleChip({ role, className }: { role: UnitRole; className?: string }) {
  return (
    <RomanTooltip lore={UNIT_ROLE_LORE[role]}>
      <span
        data-slot="unit-role"
        data-role={role}
        className={cn(
          'inline-block shrink-0 cursor-default rounded-full px-2 py-0.5 text-[10.5px] font-semibold tracking-[0.05em] uppercase',
          role === 'caesar' ? 'bg-violet/15 text-violet' : 'bg-muted text-muted-foreground',
          className,
        )}
      >
        {UNIT_ROLE_LABELS[role]}
      </span>
    </RomanTooltip>
  )
}
