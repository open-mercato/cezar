import { ArrowRightIcon } from 'lucide-react'
import { Link } from '@/lib/project-router'

import type { Skill } from '@open-mercato/cezar-api-client'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { isProjectSkill } from '@/lib/skills'
import { cn } from '@/lib/utils'

import { Markdown } from '@/routes/task-thread/markdown'

/**
 * The ONE skill detail rendering (R6 Step 1.4, spec §"Skills, Workflows, Inbox"): the
 * Settings → Skills catalog pane and the read-only "View skill" preview the pickers open
 * (GitHub tab, /new composer) both render THIS component — the two surfaces can never drift.
 *
 * Body is markdown (the redesign upgrade over the legacy `<pre>`), through the same
 * Streamdown/Shiki path the thread uses.
 */

/** The source tag every skill listing shows — project sources read emphasized (#377). */
export function SkillSourceTag({ source, className }: { source: Skill['source']; className?: string }) {
  const project = isProjectSkill({ source })
  return (
    <span
      data-slot="skill-source"
      data-source={source}
      className={cn(
        'shrink-0 rounded-full px-2 py-0.5 text-[11px] leading-4',
        project ? 'bg-primary/15 font-medium text-foreground' : 'bg-muted text-muted-foreground',
        className,
      )}
    >
      {source}
    </span>
  )
}

export function SkillDetailBody({
  skill,
  usedBy,
  heading: Heading = 'h2',
}: {
  skill: Skill
  /** "workflow › step" breadcrumbs (`skillUsedBy`). Omit to hide the section (the pickers'
   *  preview has no workflow catalog at hand — absence must not read as "unused"). */
  usedBy?: readonly string[]
  heading?: 'h2' | 'h3'
}) {
  return (
    <div data-slot="skill-detail" className="min-w-0">
      <div className="flex min-w-0 flex-wrap items-center gap-2.5">
        <Heading className="min-w-0 font-mono text-[17px] font-semibold break-all">{skill.name}</Heading>
        <SkillSourceTag source={skill.source} />
      </div>
      {skill.description ? (
        <p data-slot="skill-description" className="mt-2 max-w-prose text-sm text-pretty text-muted-foreground">
          {skill.description}
        </p>
      ) : null}
      <p data-slot="skill-path" className="mt-2 font-mono text-[11px] break-all text-soft-foreground">
        {skill.path}
        {skill.team ? ` · from ${skill.team.repo}` : ''}
      </p>

      {usedBy !== undefined ? (
        <section data-slot="skill-used-by" className="mt-6 border-t border-border pt-5">
          <h3 className="text-[13px] font-semibold text-foreground">Used by</h3>
          {usedBy.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-1">
              {usedBy.map((entry) => (
                <li key={entry} className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
                  <ArrowRightIcon aria-hidden="true" className="size-3 shrink-0 text-soft-foreground" />
                  {entry}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1.5 text-[13px] text-muted-foreground">
              Not referenced by any workflow yet — quick-task picks it up when the task mentions it.
            </p>
          )}
        </section>
      ) : null}

      <section className="mt-6 border-t border-border pt-5">
        <h3 className="text-[13px] font-semibold text-foreground">Content</h3>
        <div data-slot="skill-body" className="mt-2 text-sm">
          <Markdown>{skill.body}</Markdown>
        </div>
      </section>
    </div>
  )
}

/**
 * The read-only "View skill" preview the cmdk pickers open. `skill === null` keeps the dialog
 * mounted-but-closed so open/close animates. The footer link jumps to the full catalog entry
 * under Settings — the browsable home of the same detail.
 */
export function SkillPreviewDialog({ skill, onClose }: { skill: Skill | null; onClose: () => void }) {
  return (
    <Dialog open={skill !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        data-slot="skill-preview"
        className="block max-h-[80dvh] overflow-y-auto sm:max-w-2xl"
      >
        {skill ? (
          <>
            {/* The visible title is SkillDetailBody's heading; these two feed the dialog a11y contract. */}
            <DialogTitle className="sr-only">{skill.name}</DialogTitle>
            <DialogDescription className="sr-only">Read-only skill preview</DialogDescription>
            <SkillDetailBody skill={skill} heading="h3" />
            <p className="mt-5">
              <Link
                to={`/skills?skill=${encodeURIComponent(skill.name)}`}
                data-slot="skill-preview-manage"
                onClick={onClose}
                className="text-[13px] font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground"
              >
                Open in the Skills catalog
              </Link>
            </p>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
