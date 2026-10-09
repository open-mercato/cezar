import { ArrowRightIcon } from 'lucide-react'
import { useState } from 'react'
import { Link } from '@/lib/project-router'

import { useHealth, useLaunchKey, useProjects } from '@/api/queries'
import type { Skill } from '@open-mercato/cezar-api-client'
import { repoChipOf } from '@/components/app-shell-container'
import { BookmarkletRow } from '@/components/bookmarklet-row'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { bookmarkletUrl } from '@/lib/bookmarklet'
import { isProjectSkill } from '@/lib/skills'
import { useActiveProjectId } from '@/lib/project-router'
import { cn } from '@/lib/utils'

import { Markdown } from '@/routes/task-thread/markdown'

/**
 * The ONE skill detail rendering (R6 Step 1.4, spec §"Skills, Workflows, Inbox"): the
 * Skills catalog pane and the "View skill" preview the pickers open
 * (GitHub tab, /new composer) both render THIS component — the two surfaces can never drift.
 *
 * Body is markdown (the redesign upgrade over the legacy `<pre>`), through the same
 * Streamdown/Shiki path the thread uses.
 */

export type SkillActivation = {
  ariaLabel: string
  checked: boolean
  disabled: boolean
  onCheckedChange: () => void
}

const SKILL_SOURCE_DESCRIPTIONS: Record<Skill['source'], string> = {
  ai: 'From this project’s .ai/skills; always enabled while present.',
  cezar: 'From this project’s .ai/cezar/skills; always enabled while present.',
  agents: 'From .agents/skills or an agent-specific folder; always enabled while present.',
  global: 'User-wide from ~/.agents/skills or ~/.claude/skills, shared across projects.',
  team: 'Shared from a team repository configured for this project; importable skills can be enabled or disabled here.',
  builtin: 'Built into Cezar rather than installed from a skill repository.',
}

/** The source tag every skill listing shows — project sources read emphasized (#377). */
export function SkillSourceTag({
  source,
  className,
  teamRepo,
}: {
  source: Skill['source']
  className?: string
  teamRepo?: string
}) {
  const project = isProjectSkill({ source })
  const description =
    source === 'team' && teamRepo
      ? `Shared from ${teamRepo}, a team skills repository configured for this project.`
      : SKILL_SOURCE_DESCRIPTIONS[source]
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            data-slot="skill-source"
            data-source={source}
            aria-label={description}
            className={cn(
              'shrink-0 rounded-full border border-border px-2 py-px font-mono text-[10.5px]',
              project ? 'font-semibold text-foreground' : 'text-soft-foreground',
              className,
            )}
          >
            {source}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6} className="max-w-[260px]">
          {description}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export function SkillDetailBody({
  skill,
  usedBy,
  heading: Heading = 'h2',
  enabled = true,
  activation,
}: {
  skill: Skill
  /** "workflow › step" breadcrumbs (`skillUsedBy`). Omit to hide the section (the pickers'
   *  preview has no workflow catalog at hand — absence must not read as "unused"). */
  usedBy?: readonly string[]
  heading?: 'h2' | 'h3'
  enabled?: boolean
  activation?: SkillActivation
}) {
  return (
    <div data-slot="skill-detail" className="mx-auto w-full min-w-0 max-w-[var(--measure)]">
      <section data-slot="skill-properties" className="rounded-lg border border-border bg-muted/20 p-4">
        <div className="flex min-w-0 items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2.5">
              <Heading className="min-w-0 font-mono text-lg font-semibold break-all">{skill.name}</Heading>
              <SkillSourceTag source={skill.source} teamRepo={skill.team?.repo} />
            </div>
            <p data-slot="skill-path" className="mt-1 font-mono text-[10.5px] break-all text-soft-foreground">
              {skill.path}
              {skill.team ? ` · from ${skill.team.repo}` : ''}
            </p>
            {skill.description ? (
              <p data-slot="skill-description" className="mt-2.5 text-[13px] text-muted-foreground">
                {skill.description}
              </p>
            ) : null}
          </div>
          {activation ? (
            <Switch
              data-slot="skill-activation-detail"
              aria-label={activation.ariaLabel}
              checked={activation.checked}
              disabled={activation.disabled}
              onCheckedChange={activation.onCheckedChange}
              size="sm"
              className="mt-1.5 shrink-0"
            />
          ) : null}
        </div>

        {enabled ? <SkillBookmarklet skill={skill} /> : null}

        {usedBy !== undefined ? (
          <section data-slot="skill-used-by" className="mt-4 border-t border-border pt-4">
            <h3 className="text-[11px] font-semibold tracking-[.04em] text-soft-foreground uppercase">
              Used by
            </h3>
            {usedBy.length > 0 ? (
              <ul className="mt-1.5 flex flex-col gap-1">
                {usedBy.map((entry) => (
                  <li key={entry} className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
                    <ArrowRightIcon aria-hidden="true" className="size-3 shrink-0 text-soft-foreground" />
                    {entry}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1.5 text-xs text-soft-foreground">
                Not referenced by any workflow yet — quick-task picks it up when the task mentions it.
              </p>
            )}
          </section>
        ) : null}
      </section>

      <section data-slot="skill-content" className="mt-6 min-w-0 border-t border-border pt-5">
        <h3 className="text-[11px] font-semibold tracking-[.04em] text-soft-foreground uppercase">Content</h3>
        <div data-slot="skill-body" className="mt-3 text-sm">
          <Markdown>{skill.body}</Markdown>
        </div>
      </section>
    </div>
  )
}

function SkillBookmarklet({ skill }: { skill: Skill }) {
  const launchKey = useLaunchKey()
  const health = useHealth()
  const projects = useProjects()
  const [auto, setAuto] = useState(false)
  const key = launchKey.data?.key ?? ''
  const origin = window.location.origin
  const projectId = useActiveProjectId() ?? health.data?.bootProject ?? null
  const repoName =
    projects.data?.projects.find((project) => project.id === projectId)?.name ??
    repoChipOf(health.data)?.name ??
    null
  const url = bookmarkletUrl(skill.name, auto, key, origin, projectId)
  return (
    <section data-slot="skill-run-from-github" className="mt-5 border-t border-border pt-4">
      <h3 className="text-[11px] font-semibold tracking-[.04em] text-soft-foreground uppercase">Run from GitHub</h3>
      <p className="mt-1.5 text-xs text-muted-foreground">
        Drag the button to your bookmarks bar, then click it on a GitHub PR or issue.
      </p>
      <div className="mt-3 flex items-center gap-2 text-xs font-medium">
        <Switch
          data-slot="bookmarklet-auto"
          size="sm"
          aria-label="Start automatically"
          checked={auto}
          onCheckedChange={setAuto}
        />
        <span>Start automatically</span>
      </div>
      <div className="mt-3">
        <BookmarkletRow
          label={repoName ? `/${skill.name} (${repoName})` : `/${skill.name}`}
          url={url}
          showIcon={false}
          copySlot="skill-bookmarklet-copy"
        />
      </div>
      <p className="mt-2 text-xs text-soft-foreground">
        To update an existing bookmarklet after changing this option, drag the button to your bookmarks bar again.
      </p>
      <Link
        to="/settings/bookmarklets"
        data-slot="skill-bookmarklets-settings"
        className="mt-2 inline-block text-xs font-medium text-violet hover:underline"
      >
        Manage saved bookmarklets
      </Link>
    </section>
  )
}

/**
 * The read-only "View skill" preview the cmdk pickers open. `skill === null` keeps the dialog
 * mounted-but-closed so open/close animates. The footer link jumps to the full catalog entry.
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
            <DialogDescription className="sr-only">Skill preview with GitHub launcher</DialogDescription>
            <SkillDetailBody skill={skill} heading="h3" />
            <p className="mt-5">
              <Link
                to={`/skills?skill=${encodeURIComponent(skill.name)}`}
                data-slot="skill-preview-manage"
                onClick={onClose}
                className="text-xs font-semibold text-violet hover:underline"
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
