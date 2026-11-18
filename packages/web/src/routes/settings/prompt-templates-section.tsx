import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckIcon, NotebookPenIcon, PlusIcon, SparklesIcon, XIcon } from 'lucide-react'
import { useRef, useState } from 'react'

import { putUiState } from '@/api/client'
import { queryKeys, useSkills, useUiState } from '@/api/queries'
import type { Skill } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { Chip } from '@/components/chip'
import { Button } from '@/components/ui/button'
import { IconTooltip } from '@/components/ui/icon-tooltip'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'
import { LoadingState, RowsSkeleton, SettingsSkeleton } from '@/components/loading-state'
import {
  DEFAULT_PROMPT_TEMPLATES,
  makeTemplateId,
  normalizePromptTemplates,
  PROMPT_TEMPLATE_TEXT_LIMIT,
  type PromptTemplate,
} from '@/lib/prompt-templates'
import { isProjectSkill, partitionSkillsForDisplay, searchSkills, skillKeywords } from '@/lib/skills'
import { cn } from '@/lib/utils'
import { FormRow, SettingsCard, useSavedFlash } from './form-row'

/**
 * Settings → Prompt templates (#413): "add the settings pane for editing these prompt templates
 * so I can make sure it always start as I wanted" — the issue's own words. The list here is
 * exactly the one the GitHub hand-over and Inbox follow-up composers read
 * (`PromptTemplateMenu` / `normalizePromptTemplates`), so an edit here reshapes both at once.
 *
 * Zero-config: an untouched repo shows `DEFAULT_PROMPT_TEMPLATES` with nothing persisted yet.
 * The first Save writes the full (possibly edited-in-place) list to `ui-state.json`'s additive
 * `promptTemplates` key — same "edit locally, explicit Save" shape as Settings → Instructions' system
 * prompt, because a PUT on every keystroke would be a worse control, not a simpler one.
 */
/** `embedded`: rendered inside Settings → Instructions, which already provides the page chassis
 *  (padding, width), so the form draws no outer wrapper of its own. */
export function PromptTemplatesSection({ embedded = false }: { embedded?: boolean } = {}) {
  const uiState = useUiState()

  if (uiState.isPending) {
    return (
      <LoadingState label="Loading prompt templates…" data-slot="prompt-templates-loading">
        {embedded ? <RowsSkeleton rows={3} /> : <SettingsSkeleton />}
      </LoadingState>
    )
  }
  if (uiState.isError) {
    return (
      <CenteredState
        icon={<NotebookPenIcon />}
        tone="danger"
        title="Prompt templates did not load"
        subtitle={uiState.error.message}
        heading="h2"
      />
    )
  }
  // Keyed on whether the server has ever written this key: an untouched repo (undefined) and an
  // explicitly-cleared one ([]) both come through `normalizePromptTemplates` correctly already,
  // so the form below never has to know the difference.
  return <PromptTemplatesForm initial={normalizePromptTemplates(uiState.data.promptTemplates)} embedded={embedded} />
}

function PromptTemplatesForm({ initial, embedded }: { initial: PromptTemplate[]; embedded: boolean }) {
  const queryClient = useQueryClient()
  const skills = useSkills()
  // Already cached by the section gate above; read again here for the picker's #519 tiers.
  const uiState = useUiState()
  const [templates, setTemplates] = useState<PromptTemplate[]>(initial)
  const [newLabel, setNewLabel] = useState('')
  const [newText, setNewText] = useState('')
  const [saved, flash] = useSavedFlash()

  const save = useMutation({
    mutationFn: (next: PromptTemplate[]) => putUiState({ promptTemplates: next }),
    onSuccess: (merged) => {
      queryClient.setQueryData(queryKeys.uiState, merged)
      flash()
      toast('Prompt templates saved')
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  const dirty = JSON.stringify(templates) !== JSON.stringify(initial)
  const invalid = templates.some((t) => t.label.trim() === '' || t.text.trim() === '')

  const updateTemplate = (id: string, patch: Partial<Pick<PromptTemplate, 'label' | 'text'>>) =>
    setTemplates((current) => current.map((t) => (t.id === id ? { ...t, ...patch } : t)))

  /** Assign/unassign a skill. Unassigning the last one DROPS the key rather than leaving `[]`,
   *  matching what `normalizePromptTemplates` produces — otherwise assign-then-unassign would
   *  leave the form permanently "dirty" against an `initial` that never had the key. */
  const toggleTemplateSkill = (id: string, name: string) =>
    setTemplates((current) =>
      current.map((template) => {
        if (template.id !== id) return template
        const assigned = template.skills ?? []
        const next = assigned.includes(name)
          ? assigned.filter((existing) => existing !== name)
          : [...assigned, name]
        const { skills: _previous, ...rest } = template
        return next.length > 0 ? { ...rest, skills: next } : rest
      }),
    )

  const removeTemplate = (id: string) =>
    setTemplates((current) => current.filter((t) => t.id !== id))

  const addTemplate = () => {
    const label = newLabel.trim()
    const text = newText.trim()
    if (!label || !text) return
    setTemplates((current) => [...current, { id: makeTemplateId(), label, text }])
    setNewLabel('')
    setNewText('')
  }

  const resetToDefaults = () => setTemplates(DEFAULT_PROMPT_TEMPLATES.map((t) => ({ ...t })))

  return (
    <div data-slot="prompt-templates-section" className="flex w-full flex-col gap-5">
      <SettingsCard
        id={embedded ? undefined : 'prompt-templates'}
        title="Prompt templates"
        description="Reusable snippets you can insert into a prompt — the new-task composer, the GitHub hand-over, and the Inbox's “Add instructions” box all offer this list. Assign a template to a skill and it fills the prompt in for you when you pick that skill, as long as you have not typed anything yet."
        action={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-action="prompt-templates-reset"
            disabled={save.isPending}
            onClick={resetToDefaults}
          >
            Reset to defaults
          </Button>
        }
      >
        <FormRow stacked label="Templates" description="Edit in place, then Save — the list is written as a whole.">
          <div data-slot="prompt-template-list" className="flex flex-col gap-3">
            {templates.length === 0 ? (
              <p data-slot="prompt-templates-empty" className="text-ui text-muted-foreground">
                No templates. Add one below, or reset to the built-ins.
              </p>
            ) : (
              templates.map((template) => (
                <div
                  key={template.id}
                  data-slot="prompt-template-row"
                  data-template={template.id}
                  className="flex flex-col gap-1.5 rounded-md border border-border bg-card p-3"
                >
                  <div className="flex items-center gap-2">
                    <Input
                      aria-label={`Label for ${template.label || 'this template'}`}
                      data-slot="prompt-template-label-input"
                      value={template.label}
                      maxLength={80}
                      onChange={(event) => updateTemplate(template.id, { label: event.target.value })}
                      className="h-8 flex-1"
                    />
                    <Button
                      type="button"
                      variant="danger-ghost"
                      size="sm"
                      data-action="prompt-template-remove"
                      aria-label={`Remove ${template.label || 'this template'}`}
                      onClick={() => removeTemplate(template.id)}
                    >
                      <XIcon aria-hidden="true" className="size-3.5" />
                      Remove
                    </Button>
                  </div>
                  <Textarea
                    aria-label={`Text for ${template.label || 'this template'}`}
                    data-slot="prompt-template-text-input"
                    value={template.text}
                    maxLength={PROMPT_TEMPLATE_TEXT_LIMIT}
                    onChange={(event) => updateTemplate(template.id, { text: event.target.value })}
                    className="min-h-14 text-ui"
                  />
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                    <TemplateSkillsPicker
                      label={template.label}
                      skills={skills.data ?? []}
                      skillUsage={uiState.data?.skillUsage}
                      selected={template.skills ?? []}
                      onToggle={(name) => toggleTemplateSkill(template.id, name)}
                    />
                    {/* Chips live OUTSIDE the dropdown — the house rule from the GitHub picker:
                        cmdk may filter the list, never your selection. */}
                    {(template.skills ?? []).map((name) => (
                      <IconTooltip key={name} label={`Stop applying “${template.label}” automatically with ${name}`}>
                        <Chip
                          data-slot="prompt-template-skill-chip"
                          data-skill={name}
                          aria-label={`Stop applying ${template.label || 'this template'} automatically with ${name}`}
                          onClick={() => toggleTemplateSkill(template.id, name)}
                          className="font-mono text-foreground hover:bg-danger/10 hover:text-danger"
                        >
                          {name}
                          <XIcon aria-hidden="true" className="size-3" />
                        </Chip>
                      </IconTooltip>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        </FormRow>

        <FormRow stacked label="New template" description="A label for the menu and the text it inserts.">
          <div
            data-slot="prompt-template-new"
            className="flex flex-col gap-1.5"
          >
            <Input
              aria-label="New template label"
              data-slot="prompt-template-new-label"
              placeholder='Label (e.g. "Add tests")'
              value={newLabel}
              maxLength={80}
              onChange={(event) => setNewLabel(event.target.value)}
              className="h-8"
            />
            <Textarea
              aria-label="New template text"
              data-slot="prompt-template-new-text"
              placeholder="The instructions to insert…"
              value={newText}
              maxLength={PROMPT_TEMPLATE_TEXT_LIMIT}
              onChange={(event) => setNewText(event.target.value)}
              className="min-h-14 text-ui"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-action="prompt-template-add"
              disabled={!newLabel.trim() || !newText.trim()}
              onClick={addTemplate}
              className="self-start"
            >
              <PlusIcon aria-hidden="true" className="size-3.5" />
              Add template
            </Button>
          </div>
        </FormRow>

        <FormRow saved={saved} label="Save templates" description={invalid ? undefined : 'Writes the whole list; the composers read it at once.'}>
          {invalid ? (
            <p data-slot="prompt-templates-invalid" className="text-meta text-danger">
              Every template needs both a label and text.
            </p>
          ) : null}
          <Button
            type="button"
            variant="contrast"
            size="sm"
            data-action="prompt-templates-save"
            disabled={!dirty || invalid || save.isPending}
            onClick={() => save.mutate(templates)}
          >
            Save
          </Button>
        </FormRow>
      </SettingsCard>
    </div>
  )
}

/**
 * "Apply automatically with…" — assigns a template to skills. Multi-select (toggling keeps the
 * popover open, because wiring a template to a few skills is several toggles), searchable, and
 * grouped Project-first (#377) — the same cmdk grammar as the GitHub hand-over's skills picker,
 * so this reads as the same control rather than a second dialect of it.
 *
 * Renders a disabled trigger, not nothing, when no skills are discovered: "there are no skills to
 * assign to" is worth saying out loud in a Settings pane whose whole subject is the assignment.
 */
function TemplateSkillsPicker({
  label,
  skills,
  skillUsage,
  selected,
  onToggle,
}: {
  label: string
  skills: readonly Skill[]
  skillUsage: Readonly<Record<string, number>> | undefined
  selected: readonly string[]
  onToggle: (name: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  // #668: rank the full catalog in JS first, then split into the #519 tiers — otherwise the
  // Most used tier is built from the unfiltered set and survives a query (cmdk's own sort is
  // unreliable here, so we drive the filter ourselves like the other pickers).
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
        data-slot="prompt-template-skill-option"
        data-skill={skill.name}
        data-selected={isSelected ? 'true' : undefined}
        onSelect={() => onToggle(skill.name)}
      >
        <span className={cn('shrink-0 font-mono text-ui', emphasized && 'font-semibold')}>
          {skill.name}
        </span>
        {skill.description ? (
          <span className="min-w-0 flex-1 truncate text-label text-soft-foreground">
            {skill.description}
          </span>
        ) : null}
        {isSelected ? (
          <CheckIcon aria-hidden="true" className="ml-auto size-3.5 shrink-0 text-primary" />
        ) : null}
      </CommandItem>
    )
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setSearch('')
      }}
    >
      <PopoverTrigger asChild>
        <Chip
          data-slot="prompt-template-skills-trigger"
          aria-label={`Apply ${label || 'this template'} automatically with a skill`}
          disabled={skills.length === 0}
          active={selected.length > 0}
          chevron
          icon={<SparklesIcon aria-hidden="true" className="size-3 shrink-0 text-violet" />}
        >
          {skills.length === 0 ? 'no skills found' : 'apply with…'}
        </Chip>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={8} className="w-[336px] max-w-[calc(100vw-2rem)] p-0">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="search skills…"
            value={search}
            onValueChange={setSearch}
            onInput={() => listRef.current?.scrollTo(0, 0)}
          />
          <CommandList
            ref={listRef}
            data-slot="prompt-template-skill-menu"
            className="max-h-[min(16rem,calc(var(--radix-popover-content-available-height)-3rem))]"
          >
            {mostUsed.length === 0 && project.length === 0 && global.length === 0 ? (
              <CommandEmpty>Nothing matches.</CommandEmpty>
            ) : null}
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
            {global.length > 0 ? (
              <CommandGroup heading="Global">{global.map((skill) => skillItem(skill, false))}</CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
