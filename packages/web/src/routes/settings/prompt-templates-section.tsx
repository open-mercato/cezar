import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckIcon, ChevronDownIcon, NotebookPenIcon, PlusIcon, SparklesIcon, Trash2Icon, XIcon } from 'lucide-react'
import { useRef, useState } from 'react'

import { putUiState } from '@/api/client'
import { queryKeys, useSkills, useUiState } from '@/api/queries'
import type { Skill } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
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
import {
  DEFAULT_PROMPT_TEMPLATES,
  makeTemplateId,
  normalizePromptTemplates,
  PROMPT_TEMPLATE_TEXT_LIMIT,
  type PromptTemplate,
} from '@/lib/prompt-templates'
import { isProjectSkill, partitionSkillsForDisplay, searchSkills, skillKeywords } from '@/lib/skills'
import { cn } from '@/lib/utils'
import { SettingsError, SettingsGroup, SettingsLoading, SettingsPane } from './settings-field'

/**
 * Settings → Prompt templates (#413): "add the settings pane for editing these prompt templates
 * so I can make sure it always start as I wanted" — the issue's own words. The list here is
 * exactly the one the GitHub hand-over and Inbox follow-up composers read
 * (`PromptTemplateMenu` / `normalizePromptTemplates`), so an edit here reshapes both at once.
 *
 * Zero-config: an untouched repo shows `DEFAULT_PROMPT_TEMPLATES` with nothing persisted yet.
 * The first Save writes the full (possibly edited-in-place) list to `ui-state.json`'s additive
 * `promptTemplates` key — same "edit locally, explicit Save" shape as Settings → Agents' system
 * prompt, because a PUT on every keystroke would be a worse control, not a simpler one.
 */
export function PromptTemplatesSection() {
  const uiState = useUiState()

  if (uiState.isPending) {
    return <SettingsLoading data-slot="prompt-templates-loading" label="Loading prompt templates…" />
  }
  if (uiState.isError) {
    return <SettingsError title="Prompt templates did not load">{uiState.error.message}</SettingsError>
  }
  // Keyed on whether the server has ever written this key: an untouched repo (undefined) and an
  // explicitly-cleared one ([]) both come through `normalizePromptTemplates` correctly already,
  // so the form below never has to know the difference.
  return <PromptTemplatesForm initial={normalizePromptTemplates(uiState.data.promptTemplates)} />
}

function PromptTemplatesForm({ initial }: { initial: PromptTemplate[] }) {
  const queryClient = useQueryClient()
  const skills = useSkills()
  // Already cached by the section gate above; read again here for the picker's #519 tiers.
  const uiState = useUiState()
  const [templates, setTemplates] = useState<PromptTemplate[]>(initial)
  const [newLabel, setNewLabel] = useState('')
  const [newText, setNewText] = useState('')

  const save = useMutation({
    mutationFn: (next: PromptTemplate[]) => putUiState({ promptTemplates: next }),
    onSuccess: (merged) => {
      queryClient.setQueryData(queryKeys.uiState, merged)
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
    <SettingsPane data-slot="prompt-templates-section">
      <SettingsGroup
        title="Templates"
        description="Reusable snippets you can insert into a prompt — the new-task composer, the GitHub hand-over, and the Inbox's “Add instructions” box all offer this list. Assign a template to a skill and it fills the prompt in for you when you pick that skill, as long as you have not typed anything yet."
        bare
      >
        <div data-slot="prompt-template-list">
          {templates.length === 0 ? (
            <Empty data-slot="prompt-templates-empty" className="rounded-xl border border-dashed border-border py-10">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <NotebookPenIcon />
                </EmptyMedia>
                <EmptyTitle>No templates</EmptyTitle>
                <EmptyDescription>Add one below, or reset to the built-ins.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Card flush className="divide-y divide-border">
              {templates.map((template) => (
                <div
                  key={template.id}
                  data-slot="prompt-template-row"
                  data-template={template.id}
                  className="flex flex-col gap-2 px-5 py-4"
                >
                  <div className="flex items-center gap-2">
                    <Input
                      aria-label={`Label for ${template.label || 'this template'}`}
                      data-slot="prompt-template-label-input"
                      value={template.label}
                      maxLength={80}
                      aria-invalid={template.label.trim() === '' || undefined}
                      onChange={(event) => updateTemplate(template.id, { label: event.target.value })}
                      className="flex-1 font-medium"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      data-action="prompt-template-remove"
                      title="Remove this template"
                      aria-label={`Remove ${template.label || 'this template'}`}
                      onClick={() => removeTemplate(template.id)}
                    >
                      <Trash2Icon aria-hidden="true" />
                    </Button>
                  </div>
                  <Textarea
                    aria-label={`Text for ${template.label || 'this template'}`}
                    data-slot="prompt-template-text-input"
                    value={template.text}
                    maxLength={PROMPT_TEMPLATE_TEXT_LIMIT}
                    aria-invalid={template.text.trim() === '' || undefined}
                    onChange={(event) => updateTemplate(template.id, { text: event.target.value })}
                    className="min-h-16 text-[13px]"
                  />
                  <div className="flex flex-wrap items-center gap-1.5">
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
                      <button
                        key={name}
                        type="button"
                        data-slot="prompt-template-skill-chip"
                        data-skill={name}
                        title={`Stop applying “${template.label}” automatically with ${name}`}
                        onClick={() => toggleTemplateSkill(template.id, name)}
                        className="inline-flex h-6 items-center gap-1 rounded-full bg-muted px-2 font-mono text-[11px] text-foreground transition-colors hover:bg-danger/10 hover:text-danger"
                      >
                        {name}
                        <XIcon aria-hidden="true" className="size-3" />
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </Card>
          )}
        </div>
      </SettingsGroup>

      <SettingsGroup title="New template">
        <div data-slot="prompt-template-new" className="px-5 py-5">
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor="prompt-template-new-label">Label</FieldLabel>
              <Input
                id="prompt-template-new-label"
                aria-label="New template label"
                data-slot="prompt-template-new-label"
                placeholder='e.g. "Add tests"'
                value={newLabel}
                maxLength={80}
                onChange={(event) => setNewLabel(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="prompt-template-new-text">Instructions</FieldLabel>
              <Textarea
                id="prompt-template-new-text"
                aria-label="New template text"
                data-slot="prompt-template-new-text"
                placeholder="The instructions to insert…"
                value={newText}
                maxLength={PROMPT_TEMPLATE_TEXT_LIMIT}
                onChange={(event) => setNewText(event.target.value)}
                className="min-h-16 text-[13px]"
              />
            </Field>
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
          </FieldGroup>
        </div>
      </SettingsGroup>

      {/* Sticky: the list can be long and Save is the one action that commits everything above. */}
      <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center gap-3 border-t border-border bg-background/95 px-1 py-3 backdrop-blur">
        <Button
          type="button"
          variant="default"
          size="sm"
          data-action="prompt-templates-save"
          disabled={!dirty || invalid || save.isPending}
          onClick={() => save.mutate(templates)}
        >
          Save changes
        </Button>
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
        {invalid ? (
          <p data-slot="prompt-templates-invalid" className="text-xs text-danger">
            Every template needs both a label and text.
          </p>
        ) : dirty ? (
          <p className="text-xs text-muted-foreground">Unsaved changes</p>
        ) : null}
      </div>
    </SettingsPane>
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
        <span className={cn('shrink-0 font-mono text-xs', emphasized && 'font-semibold')}>
          {skill.name}
        </span>
        {skill.description ? (
          <span className="min-w-0 flex-1 truncate text-xs text-soft-foreground">
            {skill.description}
          </span>
        ) : null}
        {isSelected ? (
          <CheckIcon aria-hidden="true" className="ml-auto size-3.5 shrink-0 text-primary-strong" />
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
        <button
          type="button"
          data-slot="prompt-template-skills-trigger"
          aria-label={`Apply ${label || 'this template'} automatically with a skill`}
          title="Pick the skills this template applies itself to"
          disabled={skills.length === 0}
          className={cn(
            'inline-flex h-6 items-center gap-1.5 rounded-full border border-input bg-card px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50',
            selected.length > 0 && 'text-foreground',
          )}
        >
          <SparklesIcon aria-hidden="true" className="size-3 shrink-0 text-violet" />
          {skills.length === 0 ? 'No skills found' : 'Apply with…'}
          <ChevronDownIcon aria-hidden="true" className="size-2.5 shrink-0 text-soft-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={8} className="w-[336px] max-w-[calc(100vw-2rem)] p-0">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search skills…"
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
