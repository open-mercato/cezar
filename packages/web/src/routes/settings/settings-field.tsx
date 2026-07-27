import type { ReactNode } from 'react'

/**
 * One labelled settings row — title, one-line hint, control(s).
 *
 * Extracted when step 3.5 split Resources into a global pane (parallel + memory) and a project
 * pane (worktrees): both halves are the same rhythm, and two private copies of it would be two
 * things to keep in step. Settings reads as ONE surface across the project/global boundary
 * precisely because every section renders through the same chassis.
 */
export function SettingsField({
  title,
  hint,
  children,
}: {
  title: string
  hint: string
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-2">
      <div>
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <p className="text-[13px] text-muted-foreground">{hint}</p>
      </div>
      {children}
    </section>
  )
}
