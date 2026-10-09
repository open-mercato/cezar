import { SparklesIcon } from 'lucide-react'

import type { SkillSummary } from './subagent-dock'

/**
 * The Skills dock (#1202): which skill is governing this run, pinned above the composer as a
 * sibling of the Agents dock.
 *
 * It exists because the Agents dock used to answer this question by accident and wrongly — a
 * skill was mapped to `toolKind: 'task'`, so invoking one lit up `Agents · 1/1 — starting…` for
 * a fan-out that never happened. Skills now have their own kind, and their own line.
 *
 * Deliberately thinner than the Agents dock, and the asymmetry is the point:
 *
 *  - **No `N/M`, no activity line, no glyph.** A `Skill` call settles as soon as its instructions
 *    are returned, while the work it describes runs on in the main transcript — so the wire has
 *    no honest progress to report. A "0/1 running" would be a lie and a "1/1 done" would be
 *    read as "the skill is finished" while the agent is still following it.
 *  - **Not collapsible.** One line with no detail underneath has nothing to collapse.
 *
 * What it does say is the one true thing: these are the instructions in force.
 */
export function SkillsDock({ skills }: { skills: SkillSummary[] }) {
  // The overwhelming majority of runs invoke no skill and never mount this.
  if (skills.length === 0) return null

  return (
    <section
      data-slot="skills-dock"
      className="flex min-w-0 items-center gap-2 overflow-hidden rounded-xl border border-border bg-card px-4 py-2.5 text-[13px] shadow-xs"
    >
      <SparklesIcon aria-hidden className="size-3.5 shrink-0 text-soft-foreground" />
      <span className="shrink-0 font-semibold">{skills.length === 1 ? 'Skill' : 'Skills'}</span>
      <span data-slot="skills-names" className="min-w-0 truncate text-muted-foreground">
        · {skills.map((skill) => skill.name).join(' · ')}
      </span>
    </section>
  )
}
