import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query'
import { TriangleAlertIcon } from 'lucide-react'
import { useId, useRef, useState, type ChangeEvent } from 'react'

import type {
  AutomationImportResolution,
  AutomationImportRow,
  BundleChange,
  BundleSectionPlan,
  BundleSectionResolution,
  ConfigBundle,
  ConfigBundlePreview,
  ConfigBundlePreviewInput,
  ProjectListEntry,
} from '@open-mercato/cezar-api-client'
import { useHealth, useProjects } from '@/api/queries'
import { exportConfigBundle, importConfigBundle, MAX_BUNDLE_BYTES, parseConfigBundle, previewConfigBundle } from '@/api/transfer'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { toast } from '@/components/ui/toaster'
import { CardNote, FormRow, SettingsCard } from './form-row'

/**
 * Global settings → Transfer: export the portable configuration as one bundle, and import one
 * preview-first (spec 2026-11-04-automations-and-config-export-import, §UI/UX). Every choice the
 * user makes re-runs the preview, and Apply sends the digest of the preview it showed — the
 * server refuses a stale one.
 */

const EXCLUDED = ['secret values', 'tracker connections', 'agent accounts', 'webhooks', 'paths']

const SKIP = '__skip__'
/** "Choose a project…" as an option: Radix Select cannot carry an empty-string value. */
const UNMAPPED = '__unmapped__'

export function TransferSection() {
  const health = useHealth()
  // Import is a local-machine capability (a bundle can carry `requiredChecks` commands).
  const localHandoff = health.data?.capabilities?.localHandoff ?? true
  return (
    <div
      data-slot="transfer-section"
      className="flex w-full flex-col gap-5"
    >
      <ExportPanel />
      <ImportPanel localHandoff={localHandoff} />
    </div>
  )
}

// ---- export -----------------------------------------------------------------------------------

function ExportPanel() {
  const projects = useProjects()
  const available = (projects.data?.projects ?? []).filter((p) => p.status !== 'missing')
  // Ids the user UNticked, so a project registered meanwhile is included by default.
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set())
  const picked = available.filter((p) => !excluded.has(p.id))

  const download = useMutation({
    mutationFn: () => exportConfigBundle(picked.length === available.length ? null : picked.map((p) => p.id)),
    onSuccess: ({ blob, filename }) => {
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      document.body.append(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
      toast(`Downloaded ${filename}`)
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  const toggle = (id: string) =>
    setExcluded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <SettingsCard
      id="export"
      title="Export"
      description="Download this machine's portable settings — workspace preferences and, per project, its config, prompt templates and automations — as one JSON file."
      action={
        <Button
          type="button"
          size="sm"
          data-action="transfer-download"
          disabled={download.isPending || projects.isPending}
          onClick={() => download.mutate()}
        >
          {download.isPending ? 'Preparing…' : 'Download'}
        </Button>
      }
    >
      <FormRow
        stacked
        slot="transfer-export"
        label="Projects to include"
        description={
          projects.isPending
            ? 'Loading projects…'
            : available.length === 0
              ? 'No projects registered — the file will carry workspace settings only.'
              : 'Untick a project to leave it out of the file.'
        }
      >
        {available.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            {available.map((project) => (
              <label key={project.id} className="flex items-center gap-2 text-ui">
                <input
                  type="checkbox"
                  data-slot="transfer-export-project"
                  checked={!excluded.has(project.id)}
                  onChange={() => toggle(project.id)}
                />
                <span className="font-medium">{project.name}</span>
              </label>
            ))}
          </div>
        ) : null}
      </FormRow>
      <CardNote slot="transfer-excluded">
        Not included: {EXCLUDED.join(', ')}. Secret names and the tracker to reconnect travel as reminders.
      </CardNote>
    </SettingsCard>
  )
}

// ---- import -----------------------------------------------------------------------------------

interface Choices {
  /** Absent until the user touches a section checkbox — the server default applies until then. */
  selection?: string[]
  mapping: Record<string, string | null>
  resolutions: Record<string, BundleSectionResolution>
}

const NO_CHOICES: Choices = { mapping: {}, resolutions: {} }

function previewInput(bundle: ConfigBundle, choices: Choices): ConfigBundlePreviewInput {
  return {
    bundle,
    ...(choices.selection ? { selection: choices.selection } : {}),
    ...(Object.keys(choices.mapping).length > 0 ? { mapping: choices.mapping } : {}),
    ...(Object.keys(choices.resolutions).length > 0 ? { resolutions: choices.resolutions } : {}),
  }
}

function HostedNotice() {
  return (
    <SettingsCard id="import" title="Import" description="Apply a configuration bundle exported from another cezar.">
      <CardNote slot="transfer-import-hosted">Import is only available on a local cockpit.</CardNote>
    </SettingsCard>
  )
}

function ImportPanel({ localHandoff }: { localHandoff: boolean }) {
  const inputId = useId()
  const fileInput = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<{ name: string; bundle: ConfigBundle; nonce: number } | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [choices, setChoices] = useState<Choices>(NO_CHOICES)
  const [applied, setApplied] = useState<string[] | null>(null)

  const preview = useQuery({
    queryKey: ['transfer', 'preview', file?.nonce, choices],
    queryFn: () => previewConfigBundle(previewInput(file!.bundle, choices)),
    enabled: file !== null && localHandoff,
    retry: false,
    gcTime: 0,
    placeholderData: keepPreviousData,
  })

  const apply = useMutation({
    mutationFn: (plan: ConfigBundlePreview) =>
      importConfigBundle({ ...previewInput(file!.bundle, choices), planDigest: plan.planDigest }),
    onSuccess: (result) => {
      setApplied(result.applied)
      toast(`Applied ${result.applied.length} section${result.applied.length === 1 ? '' : 's'}`)
    },
    // A 409 is usually a stale preview: show the server's words and preview again.
    onError: () => void preview.refetch(),
  })

  if (!localHandoff || preview.data?.importAllowed === false) return <HostedNotice />

  const onPick = async (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0]
    event.target.value = ''
    if (!picked) return
    setApplied(null)
    apply.reset()
    setChoices(NO_CHOICES)
    if (picked.size > MAX_BUNDLE_BYTES) {
      setFile(null)
      setFileError('this file is larger than 5 MB')
      return
    }
    const parsed = parseConfigBundle(await picked.text())
    if (!parsed.ok) {
      setFile(null)
      setFileError(parsed.error)
      return
    }
    setFileError(null)
    setFile({ name: picked.name, bundle: parsed.bundle, nonce: Date.now() })
  }

  const update = (next: (current: Choices) => Choices) => {
    setApplied(null)
    apply.reset()
    setChoices(next)
  }

  const plan = file && !preview.isError ? preview.data : undefined
  const error = fileError ?? (file && preview.isError ? preview.error.message : null)

  return (
    <SettingsCard
      id="import"
      title="Import"
      description="Apply a configuration bundle exported from another cezar. Nothing is written until you apply, and automations always land paused."
    >
      <div data-slot="transfer-import" className="contents">
        <FormRow
          htmlFor={inputId}
          label="Bundle file"
          description={
            error ? (
              <span role="alert" data-slot="transfer-import-error" className="text-danger">{error}</span>
            ) : file ? (
              file.name
            ) : (
              'A .json file from Settings → Data & privacy → Export.'
            )
          }
        >
          <input
            ref={fileInput}
            id={inputId}
            type="file"
            accept="application/json,.json"
            data-slot="transfer-import-file"
            className="sr-only"
            onChange={(event) => void onPick(event)}
          />
          <Button type="button" variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
            Choose file…
          </Button>
        </FormRow>

        {file && !plan && preview.isFetching ? <CardNote>Reading the file…</CardNote> : null}

        {plan ? (
          <FormRow stacked label="What will change" description="Tick the sections to apply, map each project to one on this machine, and resolve conflicts key by key.">
            <PreviewView
              plan={plan}
              choices={choices}
              onChange={update}
              busy={preview.isFetching}
              applying={apply.isPending}
              applyError={apply.isError ? apply.error.message : null}
              applied={applied}
              onApply={() => apply.mutate(plan)}
            />
          </FormRow>
        ) : null}
      </div>
    </SettingsCard>
  )
}

// ---- preview ----------------------------------------------------------------------------------

function PreviewView({
  plan,
  choices,
  onChange,
  busy,
  applying,
  applyError,
  applied,
  onApply,
}: {
  plan: ConfigBundlePreview
  choices: Choices
  onChange: (next: (current: Choices) => Choices) => void
  busy: boolean
  applying: boolean
  applyError: string | null
  applied: string[] | null
  onApply: () => void
}) {
  const projects = useProjects()
  const registered = (projects.data?.projects ?? []).filter((p) => p.status !== 'missing')
  const isSelected = (section: BundleSectionPlan) =>
    choices.selection ? choices.selection.includes(section.id) : section.selected
  const selected = plan.sections.filter(isSelected)
  const blocked = selected.filter((section) => section.issues.length > 0)

  const toggleSection = (section: BundleSectionPlan) =>
    onChange((current) => {
      const base = current.selection ?? plan.sections.filter((s) => s.selected).map((s) => s.id)
      const selection = base.includes(section.id) ? base.filter((id) => id !== section.id) : [...base, section.id]
      return { ...current, selection }
    })

  const setKey = (sectionId: string, key: string, value: 'keep' | 'take') =>
    onChange((current) => {
      const section = current.resolutions[sectionId] ?? {}
      return {
        ...current,
        resolutions: { ...current.resolutions, [sectionId]: { ...section, keys: { ...section.keys, [key]: value } } },
      }
    })

  const setRow = (sectionId: string, index: number, resolution: AutomationImportResolution | undefined) =>
    onChange((current) => {
      const section = current.resolutions[sectionId] ?? {}
      const automations = { ...section.automations }
      if (resolution) automations[String(index)] = resolution
      else delete automations[String(index)]
      return { ...current, resolutions: { ...current.resolutions, [sectionId]: { ...section, automations } } }
    })

  const setMapping = (index: number, value: string) =>
    onChange((current) => {
      const mapping = { ...current.mapping }
      if (value === '') delete mapping[String(index)]
      else mapping[String(index)] = value === SKIP ? null : value
      return { ...current, mapping }
    })

  const projectName = (index: number | undefined) =>
    index === undefined ? 'Workspace' : (plan.projects.find((p) => p.index === index)?.name ?? `Project ${index + 1}`)
  const targetName = (id: string | undefined) => registered.find((p) => p.id === id)?.name ?? id

  return (
    <div data-slot="transfer-preview" aria-busy={busy} className="flex flex-col gap-6">
      {plan.projects.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="eyebrow">Projects</h3>
          <ul className="flex flex-col gap-2">
            {plan.projects.map((project) => (
              <li
                key={project.index}
                data-slot="transfer-project"
                data-match={project.match}
                className="flex flex-wrap items-center gap-2 text-ui"
              >
                <span className="font-medium">{project.name}</span>
                {project.remote ? <span className="text-meta text-soft-foreground">{project.remote}</span> : null}
                <span aria-hidden className="text-soft-foreground">→</span>
                {/* Always a select: a remote match is only a default the user may re-map or skip. */}
                <MappingSelect
                  name={project.name}
                  value={mappingValue(choices.mapping[String(project.index)], project.targetProjectId)}
                  registered={registered}
                  onChange={(value) => setMapping(project.index, value)}
                />
                {project.match === 'remote' ? <span className="text-meta text-soft-foreground">(same remote)</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <h3 className="eyebrow">Sections</h3>
        {plan.sections.length === 0 ? (
          <p className="text-ui text-soft-foreground">This file changes nothing on this machine.</p>
        ) : (
          plan.sections.map((section) => (
            <SectionCard
              key={section.id}
              section={section}
              title={`${projectName(section.projectIndex)} · ${KIND_LABELS[section.kind]}`}
              target={section.projectIndex === undefined ? undefined : targetName(section.targetProjectId)}
              checked={isSelected(section)}
              resolution={choices.resolutions[section.id]}
              onToggle={() => toggleSection(section)}
              onKey={(key, value) => setKey(section.id, key, value)}
              onRow={(index, resolution) => setRow(section.id, index, resolution)}
            />
          ))
        )}
      </section>

      <Reminders plan={plan} />

      <div className="flex flex-col gap-2">
        {blocked.length > 0 ? (
          <p data-slot="transfer-blocked" className="text-ui text-danger">
            Untick or fix the sections with problems before applying.
          </p>
        ) : null}
        {applyError ? (
          <p role="alert" data-slot="transfer-apply-error" className="text-ui text-danger">{applyError}</p>
        ) : null}
        {applied ? (
          <p data-slot="transfer-applied" className="text-ui text-foreground">
            Applied {applied.length} section{applied.length === 1 ? '' : 's'}. Imported automations are paused — enable them on each project’s Automations page.
          </p>
        ) : null}
        <div>
          <Button
            type="button"
            size="sm"
            data-action="transfer-apply"
            disabled={busy || applying || selected.length === 0 || blocked.length > 0 || applied !== null}
            onClick={onApply}
          >
            {applying ? 'Applying…' : `Apply selected (${selected.length})`}
          </Button>
        </div>
      </div>
    </div>
  )
}

const KIND_LABELS: Record<BundleSectionPlan['kind'], string> = {
  workspace: 'settings',
  config: 'config',
  promptTemplates: 'prompt templates',
  automations: 'automations',
}

function mappingValue(chosen: string | null | undefined, target: string | undefined): string {
  if (chosen === null) return SKIP
  return chosen ?? target ?? ''
}

function MappingSelect({
  name,
  value,
  registered,
  onChange,
}: {
  name: string
  value: string
  registered: ProjectListEntry[]
  onChange: (value: string) => void
}) {
  return (
    <Select value={value === '' ? UNMAPPED : value} onValueChange={(next) => onChange(next === UNMAPPED ? '' : next)}>
      <SelectTrigger size="sm" aria-label={`Import ${name} into`} data-slot="transfer-mapping" data-value={value}>
        <SelectValue placeholder="Choose a project…" />
      </SelectTrigger>
      <SelectContent position="popper">
        {/* Selectable, so a mapped project can be put back to unmapped (main's empty option). */}
        <SelectItem value={UNMAPPED}>Choose a project…</SelectItem>
        {registered.map((project) => (
          <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>
        ))}
        <SelectItem value={SKIP}>Skip</SelectItem>
      </SelectContent>
    </Select>
  )
}

function SectionCard({
  section,
  title,
  target,
  checked,
  resolution,
  onToggle,
  onKey,
  onRow,
}: {
  section: BundleSectionPlan
  title: string
  target: string | undefined
  checked: boolean
  resolution: BundleSectionResolution | undefined
  onToggle: () => void
  onKey: (key: string, value: 'keep' | 'take') => void
  onRow: (index: number, resolution: AutomationImportResolution | undefined) => void
}) {
  return (
    <div
      data-slot="transfer-section-card"
      data-section-id={section.id}
      className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3"
    >
      <label className="flex flex-wrap items-center gap-2 text-ui">
        <input type="checkbox" checked={checked} onChange={onToggle} aria-label={title} />
        <span className="font-medium">{title}</span>
        {target ? <span className="text-meta text-soft-foreground">→ {target}</span> : null}
        {section.runsCommands ? (
          <Badge variant="outline" data-slot="transfer-runs-commands" className="border-warning text-warning">
            <TriangleAlertIcon aria-hidden /> runs shell commands
          </Badge>
        ) : null}
      </label>
      {section.issues.length > 0 ? (
        <ul data-slot="transfer-section-issues" className="text-meta text-danger">
          {section.issues.map((issue) => <li key={issue}>{issue}</li>)}
        </ul>
      ) : null}
      {section.changes.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {section.changes.map((change) => (
            <ChangeRow
              key={change.key}
              change={change}
              value={resolution?.keys?.[change.key] ?? change.action}
              onChange={(value) => onKey(change.key, value)}
            />
          ))}
        </ul>
      ) : null}
      {section.automations?.length ? (
        <ul className="flex flex-col gap-1">
          {section.automations.map((row) => (
            <AutomationRow
              key={row.index}
              row={row}
              resolution={resolution?.automations?.[String(row.index)]}
              onChange={(next) => onRow(row.index, next)}
            />
          ))}
        </ul>
      ) : null}
      {section.changes.length === 0 && !section.automations?.length ? (
        <p className="text-meta text-soft-foreground">Nothing to change.</p>
      ) : null}
    </div>
  )
}

/** One line of JSON, cut short — a diff row is a glance, not an editor. */
export function formatValue(value: unknown): string {
  if (value === undefined) return '(not set)'
  const text = typeof value === 'string' ? JSON.stringify(value) : (JSON.stringify(value) ?? String(value))
  return text.length > 120 ? `${text.slice(0, 119)}…` : text
}

function ChangeRow({
  change,
  value,
  onChange,
}: {
  change: BundleChange
  value: 'keep' | 'take'
  onChange: (value: 'keep' | 'take') => void
}) {
  return (
    <li data-slot="transfer-change" data-key={change.key} className="flex flex-wrap items-center gap-2 text-meta">
      <code className="font-mono text-foreground">{change.key}</code>
      <span data-slot="transfer-change-from" className="font-mono text-soft-foreground">{formatValue(change.from)}</span>
      <span aria-hidden>→</span>
      <span data-slot="transfer-change-to" className="font-mono text-foreground">{formatValue(change.to)}</span>
      {change.conflict ? (
        <Select value={value} onValueChange={(next) => onChange(next as 'keep' | 'take')}>
          <SelectTrigger size="sm" aria-label={`${change.key}: keep or take`} data-slot="transfer-change-action" data-value={value}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectItem value="keep">Keep this machine’s</SelectItem>
            <SelectItem value="take">Take imported</SelectItem>
          </SelectContent>
        </Select>
      ) : (
        <span className="text-soft-foreground">({change.action === 'take' ? 'new' : 'unchanged'})</span>
      )}
    </li>
  )
}

const ROW_ACTION_LABELS: Record<AutomationImportRow['action'], string> = {
  create: 'create',
  skip: 'skip',
  rename: 'rename',
  replace: 'replace',
}

function AutomationRow({
  row,
  resolution,
  onChange,
}: {
  row: AutomationImportRow
  resolution: AutomationImportResolution | undefined
  onChange: (resolution: AutomationImportResolution | undefined) => void
}) {
  // Consent rides a resolution: an explicit `create` for a free name, a rename for a taken one.
  const setAccept = (accept: boolean) => {
    if (!accept) {
      onChange(row.collision ? (resolution ? { ...resolution, acceptCommands: undefined } : undefined) : undefined)
      return
    }
    onChange(resolution ? { ...resolution, acceptCommands: true } : { action: row.collision ? 'rename' : 'create', acceptCommands: true })
  }
  return (
    <li data-slot="transfer-automation" data-index={row.index} className="flex flex-col gap-1 text-meta">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-foreground">{row.name}</span>
        <span className="text-soft-foreground">{row.kind}</span>
        <Badge variant="secondary">{ROW_ACTION_LABELS[row.action]}{row.newName && row.action === 'rename' ? ` → ${row.newName}` : ''}</Badge>
        {row.collision ? (
          <Select
            value={resolution?.action ?? 'skip'}
            onValueChange={(next) =>
              onChange({ ...resolution, action: next as AutomationImportResolution['action'], newName: undefined })
            }
          >
            <SelectTrigger size="sm" aria-label={`${row.name}: on a name collision`} data-slot="transfer-automation-action" data-value={resolution?.action ?? 'skip'}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value="skip">Skip</SelectItem>
              <SelectItem value="rename">Rename</SelectItem>
              {row.collision.id ? <SelectItem value="replace">Replace (and pause)</SelectItem> : null}
            </SelectContent>
          </Select>
        ) : null}
        {row.runsCommands ? (
          <label className="flex items-center gap-1 text-warning">
            <input
              type="checkbox"
              data-slot="transfer-automation-accept"
              checked={resolution?.acceptCommands === true}
              onChange={(event) => setAccept(event.target.checked)}
            />
            <TriangleAlertIcon aria-hidden className="size-3" /> runs shell commands — allow
          </label>
        ) : null}
      </div>
      {[...row.issues, ...row.warnings].map((note) => (
        <span key={note} className={row.issues.includes(note) ? 'text-danger' : 'text-soft-foreground'}>{note}</span>
      ))}
    </li>
  )
}

function Reminders({ plan }: { plan: ConfigBundlePreview }) {
  const perProject = plan.projects.filter((p) => p.reminders.secretNames.length > 0 || p.reminders.tracker)
  if (plan.reminders.workspaceSecretNames.length === 0 && perProject.length === 0) return null
  return (
    <section data-slot="transfer-reminders" className="flex flex-col gap-2">
      <h3 className="eyebrow">Re-enter these secrets</h3>
      <p className="text-meta text-soft-foreground">
        A bundle never carries secret values or tracker credentials. Add them again on this machine after importing.
      </p>
      <ul className="flex flex-col gap-1 text-ui">
        {plan.reminders.workspaceSecretNames.length > 0 ? (
          <li data-slot="transfer-reminder" data-scope="workspace">
            <span className="font-medium">Workspace secrets:</span> {plan.reminders.workspaceSecretNames.join(', ')}
          </li>
        ) : null}
        {perProject.map((project) => (
          <li key={project.index} data-slot="transfer-reminder" data-scope={`project:${project.index}`}>
            <span className="font-medium">{project.name}:</span>{' '}
            {project.reminders.secretNames.length > 0 ? `secrets ${project.reminders.secretNames.join(', ')}` : null}
            {project.reminders.secretNames.length > 0 && project.reminders.tracker ? '; ' : null}
            {project.reminders.tracker ? `reconnect the ${project.reminders.tracker} tracker` : null}
          </li>
        ))}
      </ul>
    </section>
  )
}
