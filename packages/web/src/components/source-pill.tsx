import {
  CheckIcon,
  CircleSlashIcon,
  EyeIcon,
  PlusIcon,
  SparklesIcon,
  WorkflowIcon,
  XIcon,
} from 'lucide-react'
import { useRef, useState } from 'react'

import type { Skill, WorkflowDef } from '@open-mercato/cezar-api-client'
import { chevron, chipClass } from '@/components/picker-pill'
import { SkillPreviewDialog } from '@/components/skill-detail'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  isProjectSkill,
  partitionSkillsForDisplay,
  queryScore,
  searchSkills,
  searchWorkflows,
  skillKeywords,
} from '@/lib/skills'
import { cn } from '@/lib/utils'
import { QUICK_TASK, type TaskSource } from '@/lib/task-source'

/**
 * The workflow/skill picker (#385's searchable cmdk dropdown, #519's tier ordering): ONE pill
 * for both kinds of source — and one that can be EMPTY.
 *
 * `null` — no skill, no workflow — is a first-class state rather than a hidden default. It is
 * what a fresh `/new` opens on, and there are three ways back to it: the ✕ on the pill (one
 * click, no menu), picking the selected row again (the toggle the GitHub hand-off's workflow
 * row already had — this picker was the one that swallowed the second click), and the "No
 * skill" row at the head of the list. Before that the only exit was picking the `quick-task`
 * WORKFLOW, which reads as a third mode to learn rather than as "none of the above" — the
 * report this fixes was a user hunting for it.
 *
 * `quick-task` is therefore not a row of its own: it IS the run an empty picker performs, and
 * one run behind two names is what made the exit invisible. The "No skill" row carries the
 * catalog's own description for it, so a workspace whose file shadows the built-in still
 * describes what it will actually run.
 *
 * Groups render No skill, Most used (skills picked before, frequency descending), Project
 * skills (bold), Workflows, then Global.
 */
export function SourcePill({
  source,
  ready,
  skills,
  skillUsage,
  workflows,
  onPick,
}: {
  source: TaskSource | null
  ready: boolean
  skills: readonly Skill[]
  skillUsage: Readonly<Record<string, number>> | undefined
  workflows: readonly WorkflowDef[]
  onPick: (source: TaskSource | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [preview, setPreview] = useState<Skill | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // #484: rank in JS (cmdk's own score-sort does not re-order reliably here), then split the
  // ranked matches into the #519 display tiers so each group stays match-ordered.
  const matched = searchSkills(skills, search, skillUsage)
  const { mostUsed, project, global } = partitionSkillsForDisplay(matched, skillUsage)
  const quickTask = workflows.find((workflow) => workflow.name === QUICK_TASK)
  const matchedWorkflows = searchWorkflows(workflows, search).filter((workflow) => workflow.name !== QUICK_TASK)
  // The empty row answers to what people type when they mean "none of these" — including the
  // built-in's own name, which is no longer a row of its own. Same match signal as every other
  // row, so one query ranks the whole list.
  const noneMatches =
    queryScore('no skill', `none plain ${QUICK_TASK} ${quickTask?.description ?? ''}`, search) > 0
  const nothingMatches =
    !noneMatches
    && mostUsed.length === 0
    && project.length === 0
    && global.length === 0
    && matchedWorkflows.length === 0
  const pick = (next: TaskSource | null) => {
    onPick(next)
    setOpen(false)
  }
  /** Picking what is already picked CLEARS it — the gesture every other toggle in the cockpit
   *  answers to, and the one the report asked for by name. */
  const toggle = (next: TaskSource) =>
    pick(source?.source === next.source && source.ref === next.ref ? null : next)

  const skillItem = (skill: Skill, emphasized: boolean) => {
    const selected = source?.source === 'skill' && source.ref === skill.name
    return (
      <CommandItem
        key={skill.path}
        // The path suffix keeps values unique when a project skill shadows a global one.
        value={`skill ${skill.name} ${skill.path}`}
        keywords={skillKeywords(skill.name, skill.description)}
        data-slot="source-option"
        data-source-kind="skill"
        data-source-ref={skill.name}
        onSelect={() => toggle({ source: 'skill', ref: skill.name })}
      >
        <span className={cn('shrink-0 font-mono text-xs', emphasized && 'font-semibold')}>
          {skill.name}
        </span>
        {skill.description ? (
          <span className="min-w-0 flex-1 truncate text-xs text-soft-foreground">
            {skill.description}
          </span>
        ) : null}
        {/* Read-only "View skill" (spec §Skills) — the Settings catalog's detail component
            as a dialog. stopPropagation: viewing must not pick the source. */}
        <button
          type="button"
          data-slot="source-skill-view"
          aria-label={`View skill ${skill.name}`}
          title="View skill"
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            setPreview(skill)
          }}
          className="ml-auto shrink-0 rounded-sm p-0.5 text-soft-foreground transition-colors hover:text-foreground"
        >
          <EyeIcon aria-hidden="true" className="size-3.5" />
        </button>
        {selected ? <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-primary" /> : null}
      </CommandItem>
    )
  }

  const SourceIcon = source === null ? PlusIcon : source.source === 'skill' ? SparklesIcon : WorkflowIcon
  // An empty picker looks empty: dashed, quiet, an invitation rather than a value. Every other
  // pill in this row shows a resolved choice, so a filled-looking pill that nobody chose was
  // read as one that could not be changed.
  const trigger = (
    <button
      type="button"
      data-slot="source-pill"
      data-source-kind={source?.source ?? 'none'}
      aria-label="Choose a skill or workflow"
      title={
        source === null
          ? 'No skill — the task runs as one plain agent step. Pick a skill or workflow to change that.'
          : `Runs the ${source.source} "${source.ref}" — pick it again, or press ✕, to run without it`
      }
      disabled={!ready}
      onKeyDown={(event) => {
        // A filled pill clears like a token in a tag field. Modifiers stay out of it: ⌘⌫ is a
        // text gesture in the composer this row belongs to, not a picker one.
        if (source === null || event.metaKey || event.ctrlKey || event.altKey) return
        if (event.key !== 'Backspace' && event.key !== 'Delete') return
        event.preventDefault()
        onPick(null)
      }}
      className={cn(
        chipClass,
        'font-mono text-[11.5px]',
        source === null
          ? 'border-dashed text-soft-foreground'
          : 'rounded-r-none border-r-0 border-foreground/60 pr-1.5 font-semibold text-foreground',
      )}
    >
      <SourceIcon
        aria-hidden="true"
        className={cn('size-3 shrink-0', source === null ? 'text-soft-foreground' : 'text-violet')}
      />
      <span className="max-w-44 truncate">{!ready ? '…' : (source?.ref ?? 'Skill')}</span>
      {chevron}
    </button>
  )

  return (
    <>
      <SkillPreviewDialog skill={preview} onClose={() => setPreview(null)} />
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setSearch('')
        }}
      >
        {/* Split control, not a button inside a button: the trigger owns the menu, the ✕ owns
            the clear, and the seam between them is the ✕'s left border. */}
        <span className="inline-flex items-center">
          <PopoverTrigger asChild>{trigger}</PopoverTrigger>
          {source !== null && ready ? (
            <button
              type="button"
              data-slot="source-pill-clear"
              aria-label={`Clear the ${source.source} ${source.ref}`}
              title="Run without it"
              onClick={() => onPick(null)}
              className={cn(
                chipClass,
                'rounded-l-none border-foreground/60 pl-1.5 pr-2 text-soft-foreground hover:text-foreground',
              )}
            >
              <XIcon aria-hidden="true" className="size-3" />
            </button>
          ) : null}
        </span>
        <PopoverContent
          align="start"
          sideOffset={8}
          className="w-[336px] max-w-[calc(100vw-2rem)] p-0"
        >
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="search skills & workflows…"
              value={search}
              onValueChange={setSearch}
              onInput={() => listRef.current?.scrollTo(0, 0)}
            />
            {/* The 3rem headroom is the CommandInput row: the popper's available-height var
                covers the whole popover, and the list must leave the search box visible. */}
            <CommandList
              ref={listRef}
              data-slot="source-menu"
              className="max-h-[min(18rem,calc(var(--radix-popover-content-available-height)-3rem))]"
            >
              {nothingMatches ? <CommandEmpty>Nothing matches.</CommandEmpty> : null}
              {/* Heading-less and first: "run it plain" is not a kind of skill, and the way out
                  of a selection has to be the thing you see when the list opens. */}
              {noneMatches ? (
                <CommandGroup>
                  <CommandItem
                    value="none no-skill"
                    keywords={['none', 'plain', ...skillKeywords(QUICK_TASK)]}
                    data-slot="source-option"
                    data-source-kind="none"
                    onSelect={() => pick(null)}
                  >
                    <CircleSlashIcon aria-hidden="true" className="size-3.5 shrink-0 text-soft-foreground" />
                    <span className="shrink-0 text-xs font-medium">No skill</span>
                    <span className="min-w-0 flex-1 truncate text-xs text-soft-foreground">
                      {quickTask?.description ?? 'One agent run on your task — no ceremony.'}
                    </span>
                    {source === null ? (
                      <CheckIcon aria-hidden="true" className="ml-auto size-3.5 shrink-0 text-primary" />
                    ) : null}
                  </CommandItem>
                </CommandGroup>
              ) : null}
              {/* Most used leads (#519), then Project skills before Global — the closer a
                  skill lives to the repo, the more likely it's the one being picked. */}
              {mostUsed.length > 0 ? (
                <CommandGroup heading="Most used">
                  {mostUsed.map((skill) => skillItem(skill, isProjectSkill(skill)))}
                </CommandGroup>
              ) : null}
              {project.length > 0 ? (
                <CommandGroup heading="Project skills">
                  {project.map((skill) => skillItem(skill, true))}
                </CommandGroup>
              ) : null}
              {matchedWorkflows.length > 0 ? (
                <CommandGroup heading="Workflows">
                  {matchedWorkflows.map((workflow) => {
                    const selected = source?.source === 'workflow' && source.ref === workflow.name
                    return (
                      <CommandItem
                        key={workflow.name}
                        value={`workflow ${workflow.name}`}
                        keywords={skillKeywords(workflow.name, workflow.description)}
                        data-slot="source-option"
                        data-source-kind="workflow"
                        data-source-ref={workflow.name}
                        onSelect={() => toggle({ source: 'workflow', ref: workflow.name })}
                      >
                        <span className="shrink-0 font-mono text-xs">{workflow.name}</span>
                        {workflow.description ? (
                          <span className="min-w-0 flex-1 truncate text-xs text-soft-foreground">
                            {workflow.description}
                          </span>
                        ) : null}
                        {selected ? (
                          <CheckIcon aria-hidden="true" className="ml-auto size-3.5 shrink-0 text-primary" />
                        ) : null}
                      </CommandItem>
                    )
                  })}
                </CommandGroup>
              ) : null}
              {global.length > 0 ? (
                <CommandGroup heading="Global">{global.map((skill) => skillItem(skill, false))}</CommandGroup>
              ) : null}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </>
  )
}
