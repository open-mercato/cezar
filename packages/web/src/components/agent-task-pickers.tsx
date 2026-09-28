import { CheckIcon, ChevronDownIcon, EyeIcon, SparklesIcon, WorkflowIcon } from 'lucide-react'
import { useRef, useState } from 'react'
import type { Skill, WorkflowDef } from '@open-mercato/cezar-api-client'
import { chipClass } from '@/components/picker-pill'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SkillPreviewDialog } from '@/components/skill-detail'
import { isProjectSkill, partitionSkillsForDisplay, searchSkills, searchWorkflows, skillKeywords } from '@/lib/skills'
import { cn } from '@/lib/utils'

/**
 * The workflow dropdown: single-select, and — legacy parity — selecting the chosen workflow
 * again deselects it (no workflow means the toggled skills, or quick-task, drive the run).
 */
export function WorkflowPicker({
  workflows,
  value,
  onChange,
  slotPrefix = 'gh',
}: {
  workflows: readonly WorkflowDef[]
  value: string | null
  onChange: (workflow: string | null) => void
  slotPrefix?: string
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  // #484: rank matches in JS rather than trusting cmdk's built-in score-sort.
  const matched = searchWorkflows(workflows, search)
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setSearch('')
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          data-slot={`${slotPrefix}-workflow-trigger`}
          aria-label="Choose a workflow"
          className={cn(chipClass, value && 'border-foreground/60 font-mono text-[11.5px] font-semibold text-foreground')}
        >
          <WorkflowIcon aria-hidden="true" className="size-3 shrink-0 text-violet" />
          <span className="max-w-44 truncate">{value ?? 'workflow'}</span>
          <ChevronDownIcon aria-hidden="true" className="size-2.5 shrink-0 text-soft-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={8} className="w-[320px] max-w-[calc(100vw-2rem)] p-0">
        <Command label="Choose a workflow" shouldFilter={false}>
          <CommandInput
            placeholder="search workflows…"
            value={search}
            onValueChange={setSearch}
            onInput={() => listRef.current?.scrollTo(0, 0)}
          />
          <CommandList ref={listRef} data-slot={`${slotPrefix}-workflow-menu`} className="max-h-[min(16rem,calc(var(--radix-popover-content-available-height)-3rem))]">
            {matched.length === 0 ? <CommandEmpty>Nothing matches.</CommandEmpty> : null}
            <CommandGroup>
              {matched.map((workflowDef) => {
                const selected = value === workflowDef.name
                return (
                  <CommandItem
                    key={workflowDef.name}
                    value={`workflow ${workflowDef.name}`}
                    keywords={skillKeywords(workflowDef.name, workflowDef.description)}
                    data-slot={`${slotPrefix}-workflow-option`}
                    data-workflow={workflowDef.name}
                    onSelect={() => {
                      onChange(selected ? null : workflowDef.name)
                      setOpen(false)
                    }}
                  >
                    <span className="shrink-0 font-mono text-xs">{workflowDef.name}</span>
                    {workflowDef.description ? (
                      <span className="min-w-0 flex-1 truncate text-xs text-soft-foreground">
                        {workflowDef.description}
                      </span>
                    ) : null}
                    {selected ? (
                      <CheckIcon aria-hidden="true" className="ml-auto size-3.5 shrink-0 text-primary" />
                    ) : null}
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/**
 * The skills dropdown: multi-select — toggling keeps it open, because picking a chain is
 * several toggles — grouped Most used (#519), then Project skills (bold) before Global, per
 * #377. Every row carries a read-only "View skill" eye (spec §Skills): it opens the SAME
 * detail component the Settings catalog renders, as a dialog, without toggling the row.
 */
export function SkillsPicker({
  skills,
  skillUsage,
  selected,
  onToggle,
  maxSelections,
  slotPrefix = 'gh',
}: {
  skills: readonly Skill[]
  skillUsage: Readonly<Record<string, number>> | undefined
  selected: readonly string[]
  onToggle: (name: string) => void
  maxSelections?: number
  slotPrefix?: string
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [preview, setPreview] = useState<Skill | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // #484: rank matches in JS, then split into the #519 tiers (cmdk's own sort is unreliable here).
  const matched = searchSkills(skills, search, skillUsage)
  const { mostUsed, project, global } = partitionSkillsForDisplay(matched, skillUsage)

  const skillItem = (skill: Skill, emphasized: boolean) => {
    const isSelected = selected.includes(skill.name)
    return (
      <CommandItem
        key={skill.path}
        // The path suffix keeps values unique when a project skill shadows a global one.
        value={`skill ${skill.name} ${skill.path}`}
        keywords={skillKeywords(skill.name, skill.description)}
        data-slot={`${slotPrefix}-skill-option`}
        data-skill={skill.name}
        data-selected={isSelected ? 'true' : undefined}
        disabled={!isSelected && maxSelections !== undefined && selected.length >= maxSelections}
        onSelect={() => onToggle(skill.name)}
      >
        <span className={cn('shrink-0 font-mono text-xs', emphasized && 'font-semibold')}>{skill.name}</span>
        {skill.description ? (
          <span className="min-w-0 flex-1 truncate text-xs text-soft-foreground">{skill.description}</span>
        ) : null}
        <button
          type="button"
          data-slot={`${slotPrefix}-skill-view`}
          aria-label={`View skill ${skill.name}`}
          title="View skill"
          // stopPropagation: the eye must never toggle the row it sits on.
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            setPreview(skill)
          }}
          className="ml-auto shrink-0 rounded-sm p-0.5 text-soft-foreground transition-colors hover:text-foreground"
        >
          <EyeIcon aria-hidden="true" className="size-3.5" />
        </button>
        {isSelected ? <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-primary" /> : null}
      </CommandItem>
    )
  }

  if (skills.length === 0) return null
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
        <PopoverTrigger asChild>
          <button
            type="button"
            data-slot={`${slotPrefix}-skills-trigger`}
            aria-label="Choose skills"
            className={cn(chipClass, selected.length > 0 && 'border-foreground/60 font-semibold text-foreground')}
          >
            <SparklesIcon aria-hidden="true" className="size-3 shrink-0 text-violet" />
            skills{selected.length > 0 ? ` · ${selected.length}` : ''}
            <ChevronDownIcon aria-hidden="true" className="size-2.5 shrink-0 text-soft-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" sideOffset={8} className="w-[336px] max-w-[calc(100vw-2rem)] p-0">
          <Command label="Choose skills" shouldFilter={false}>
            <CommandInput
              placeholder="search skills…"
              value={search}
              onValueChange={setSearch}
              onInput={() => listRef.current?.scrollTo(0, 0)}
            />
            <CommandList ref={listRef} data-slot={`${slotPrefix}-skill-menu`} className="max-h-[min(16rem,calc(var(--radix-popover-content-available-height)-3rem))]">
              {mostUsed.length === 0 && project.length === 0 && global.length === 0 ? (
                <CommandEmpty>Nothing matches.</CommandEmpty>
              ) : null}
              {mostUsed.length > 0 ? (
                <CommandGroup heading="Most used">
                  {mostUsed.map((skill) => skillItem(skill, isProjectSkill(skill)))}
                </CommandGroup>
              ) : null}
              {project.length > 0 ? (
                <CommandGroup heading="Project skills">{project.map((skill) => skillItem(skill, true))}</CommandGroup>
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
