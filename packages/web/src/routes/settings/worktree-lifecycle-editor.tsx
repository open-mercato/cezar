import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { worktreeLifecycleConfigSchema, type ConfigResponse, type LifecyclePreviewResponse, type ScriptEntry, type WorktreeLifecycleConfig } from '@open-mercato/cezar-api-client'
import { getConfig, previewLifecycleCommand, putConfig } from '@/api/client'
import { queryKeys } from '@/api/queries'
import { useWorktreeLifecycles } from '@/api/worktree-lifecycle'
import { IntegerStepper } from '@/components/integer-stepper'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { CardNote, FormRow, SettingsCard } from './form-row'

const empty = (): WorktreeLifecycleConfig => ({ afterCreate: [], beforeRemove: [] })
const phases = ['afterCreate', 'beforeRemove'] as const
const titles = { afterCreate: 'After worktree creation', beforeRemove: 'Before worktree removal' }
const hints = {
  afterCreate: 'Run after a worktree is created and before its agent starts, including recreation after reclamation.',
  beforeRemove: 'Run while the worktree files still exist, before removal or reclamation. Failure retains the directory for recovery.',
}
const variables = [
  ['root_path', 'The selected project’s root directory'],
  ['worktree_path', 'The isolated worktree directory'],
  ['worktree_id', 'Stable cez-prefixed resource identity'],
  ['task_id', 'The original task ID'],
] as const
/** Radix Select refuses an empty item value; this stands in for "example values". */
const EXAMPLE_CONTEXT = '__example__'
const TIMEOUT_MIN = 1
const TIMEOUT_MAX = 86_400
const TIMEOUT_DEFAULT = 1_800

/** Local drafts survive validation/conflict failures. Saving config never resumes a parked task. */
export function WorktreeLifecycleEditor({ config }: { config: ConfigResponse }) {
  const client = useQueryClient()
  const configKey = queryKeys.config
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const lifecycle = useWorktreeLifecycles()
  const [draft, setDraft] = useState<WorktreeLifecycleConfig>(config.worktreeLifecycle ?? empty())
  const [baseline, setBaseline] = useState(config.worktreeLifecycle ?? empty())
  const [revision, setRevision] = useState<string | null>(config.worktreeLifecycleRevision ?? null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [message, setMessage] = useState('')
  const [previewWorktree, setPreviewWorktree] = useState('')
  const [previews, setPreviews] = useState<Record<string, LifecyclePreviewResponse>>({})
  const [previewing, setPreviewing] = useState<string | null>(null)
  const editors = useRef(new Map<string, HTMLTextAreaElement>())
  const currentPreview = useRef({ draft, previewWorktree })
  currentPreview.current = { draft, previewWorktree }
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline)
  useEffect(() => {
    if (dirty) return
    const next = config.worktreeLifecycle ?? empty()
    setDraft(next); setBaseline(next); setRevision(config.worktreeLifecycleRevision ?? null)
  }, [config.worktreeLifecycle, config.worktreeLifecycleRevision, dirty])

  const update = (phase: typeof phases[number], id: string, patch: Partial<ScriptEntry>) => {
    setDraft(current => ({ ...current, [phase]: current[phase].map(entry => entry.id === id ? { ...entry, ...patch } : entry) }))
    setErrors(current => ({ ...current, [id]: '' })); setMessage('')
    setPreviews(current => { const next = { ...current }; delete next[id]; return next })
  }
  const insert = (phase: typeof phases[number], entry: ScriptEntry, name: typeof variables[number][0]) => {
    const editor = editors.current.get(entry.id)
    const start = editor?.selectionStart ?? entry.command.length
    const end = editor?.selectionEnd ?? start
    const token = `{{ ${name} }}`
    update(phase, entry.id, { command: entry.command.slice(0, start) + token + entry.command.slice(end) })
    requestAnimationFrame(() => { editor?.focus(); editor?.setSelectionRange(start + token.length, start + token.length) })
  }
  const move = (phase: typeof phases[number], index: number, direction: number) => {
    setDraft(current => {
      const entries = [...current[phase]]
      const entry = entries.splice(index, 1)[0]!
      entries.splice(index + direction, 0, entry)
      return { ...current, [phase]: entries }
    }); setMessage('')
  }
  const preview = async (entry: ScriptEntry) => {
    setPreviewing(entry.id)
    try {
      const value = await previewLifecycleCommand({ command: entry.command, ...(previewWorktree ? { worktreeId: previewWorktree } : {}) })
      const latest = phases.flatMap(phase => currentPreview.current.draft[phase]).find(item => item.id === entry.id)
      if (!mounted.current || latest?.command !== entry.command || currentPreview.current.previewWorktree !== previewWorktree) return
      setPreviews(current => ({ ...current, [entry.id]: value })); setErrors(current => ({ ...current, [entry.id]: '' }))
    } catch (error) { setErrors(current => ({ ...current, [entry.id]: error instanceof Error ? error.message : 'Preview failed' })) }
    finally { setPreviewing(null) }
  }
  const save = useMutation({
    mutationFn: async () => {
      setErrors({}); setMessage('')
      const parsed = worktreeLifecycleConfigSchema.safeParse(draft)
      if (!parsed.success) {
        const errors: Record<string, string> = {}
        for (const issue of parsed.error.issues) {
          const phase = issue.path[0] as typeof phases[number]
          const id = typeof issue.path[1] === 'number' ? draft[phase]?.[issue.path[1]]?.id : undefined
          errors[id ?? 'form'] = issue.message
        }
        setErrors(errors); throw new Error('Check the highlighted commands before saving.')
      }
      // Server validation owns shell grammar; preview neither executes nor expands a shell.
      for (const phase of phases) for (const entry of parsed.data[phase]) {
        if (!mounted.current) throw new Error('Settings closed; saving cancelled.')
        try { await previewLifecycleCommand({ command: entry.command }) }
        catch (error) { setErrors({ [entry.id]: error instanceof Error ? error.message : 'Invalid template' }); throw new Error('Check the highlighted command before saving.') }
      }
      if (!mounted.current) throw new Error('Settings closed; saving cancelled.')
      return putConfig({ worktreeLifecycle: parsed.data, worktreeLifecycleRevision: revision })
    },
    onSuccess: result => {
      const value = result.worktreeLifecycle ?? empty()
      setBaseline(value); setDraft(value); setRevision(result.worktreeLifecycleRevision ?? null)
      client.setQueryData(configKey, result)
      setMessage('Saved. Retry uses these commands. Saving does not restart paused scripts.')
    },
  })
  const reload = async () => {
    try {
      const latest = await getConfig()
      client.setQueryData(configKey, latest)
      const value = latest.worktreeLifecycle ?? empty()
      setDraft(value); setBaseline(value); setRevision(latest.worktreeLifecycleRevision ?? null)
      setErrors({}); setPreviews({}); setMessage('Loaded saved scripts.'); save.reset()
    } catch (error) { setErrors({ form: error instanceof Error ? error.message : 'Settings could not be loaded' }) }
  }
  const pending = lifecycle.data?.worktrees.filter(worktree => worktree.operation && worktree.needsAttention) ?? []
  const onDisk = lifecycle.data?.worktrees.filter(worktree => worktree.onDisk) ?? []

  return <SettingsCard
    id="worktree-lifecycle-scripts"
    slot="worktree-lifecycle-editor"
    title="Lifecycle scripts"
    description="Scripts apply only to this project. Saving commands opts in to running them as the Cezar host user, with that user’s local privileges. Runtime: noninteractive Bash, in the isolated worktree directory — Bash must be installed on the host; commands run in order and the default timeout is 30 minutes."
  >
    <CardNote>
      <span id="lifecycle-variable-help">Values are shell-escaped; do not wrap variable tokens in quotes. Use <code>{'\\{{'}</code> for literal double braces, for example <code>{"docker inspect --format '\\{{.State.Status}}' container"}</code>.</span>
    </CardNote>
    <FormRow label="Preview context" description="Which worktree’s values a Preview renders with. Preview never executes commands.">
      <Select value={previewWorktree || EXAMPLE_CONTEXT} onValueChange={value => { setPreviewWorktree(value === EXAMPLE_CONTEXT ? '' : value); setPreviews({}) }}>
        <SelectTrigger size="sm" aria-label="Preview context" data-slot="lifecycle-preview-context" data-value={previewWorktree} className="max-w-64">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value={EXAMPLE_CONTEXT}>Example values (illustrative)</SelectItem>
          {onDisk.map(worktree => <SelectItem key={worktree.worktreeId} value={worktree.worktreeId}>{worktree.task?.title ?? `Orphan ${worktree.runId.slice(0, 8)}`}</SelectItem>)}
        </SelectContent>
      </Select>
    </FormRow>
    {phases.map(phase => <FormRow key={phase} stacked label={titles[phase]} description={hints[phase]}>
      {draft[phase].length === 0 && <p className="text-label text-muted-foreground">No commands. This phase completes without running a script.</p>}
      {draft[phase].map((entry, index) => <fieldset key={entry.id} className="flex min-w-0 flex-col gap-2 rounded-md border border-border p-3" disabled={save.isPending}>
        <legend className="px-1 text-label font-medium">Command {index + 1}</legend>
        <label className="text-label text-muted-foreground" htmlFor={`lifecycle-name-${entry.id}`}>Display name (optional)</label>
        <Input id={`lifecycle-name-${entry.id}`} value={entry.name ?? ''} maxLength={120} onChange={event => update(phase, entry.id, { name: event.target.value })} />
        <label className="text-label text-muted-foreground" htmlFor={`lifecycle-command-${entry.id}`}>{titles[phase]} — command {index + 1}</label>
        <Textarea id={`lifecycle-command-${entry.id}`} ref={element => { if (element) editors.current.set(entry.id, element); else editors.current.delete(entry.id) }} className="min-h-24 resize-y font-mono text-ui" value={entry.command} maxLength={32 * 1024} spellCheck={false} aria-describedby={`lifecycle-variable-help${errors[entry.id] ? ` lifecycle-error-${entry.id}` : ''}`} aria-invalid={!!errors[entry.id]} onChange={event => update(phase, entry.id, { command: event.target.value })} />
        {errors[entry.id] && <p id={`lifecycle-error-${entry.id}`} className="text-label text-danger" role="alert">{errors[entry.id]}</p>}
        <details className="text-label"><summary className="cursor-pointer py-1">Variables</summary>
          <ul className="mt-1 space-y-2">{variables.map(([name, description]) => <li key={name} className="flex flex-wrap items-center gap-2"><Button type="button" variant="outline" size="sm" aria-label={`Insert ${name} into ${titles[phase].toLowerCase()} command ${index + 1}`} onClick={() => insert(phase, entry, name)}><code>{`{{ ${name} }}`}</code></Button><span className="text-muted-foreground">{description}</span></li>)}</ul>
        </details>
        <details className="text-label"><summary className="cursor-pointer py-1">Advanced timeout</summary>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span id={`lifecycle-timeout-label-${entry.id}`} className="text-muted-foreground">Timeout in seconds (1–86,400)</span>
            <IntegerStepper
              aria-label={`Timeout in seconds for ${titles[phase].toLowerCase()} command ${index + 1}`}
              data-slot="lifecycle-timeout"
              value={entry.timeoutSeconds ?? null}
              min={TIMEOUT_MIN}
              max={TIMEOUT_MAX}
              allowEmpty
              emptyStepFrom={TIMEOUT_DEFAULT}
              placeholder={`Default (${TIMEOUT_DEFAULT})`}
              onCommit={next => update(phase, entry.id, { timeoutSeconds: next ?? undefined })}
            />
          </div>
        </details>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" disabled={index === 0} aria-label={`Move ${titles[phase].toLowerCase()} command ${index + 1} up`} onClick={() => move(phase, index, -1)}>Move up</Button>
          <Button type="button" variant="outline" size="sm" disabled={index === draft[phase].length - 1} aria-label={`Move ${titles[phase].toLowerCase()} command ${index + 1} down`} onClick={() => move(phase, index, 1)}>Move down</Button>
          <Button type="button" variant="outline" size="sm" disabled={!entry.command.trim() || previewing !== null} aria-label={`Preview ${titles[phase].toLowerCase()} command ${index + 1}`} onClick={() => void preview(entry)}>{previewing === entry.id ? 'Previewing…' : 'Preview'}</Button>
          <Button type="button" variant="danger-ghost" size="sm" aria-label={`Remove ${titles[phase].toLowerCase()} command ${index + 1}`} onClick={() => { setDraft(current => ({ ...current, [phase]: current[phase].filter(item => item.id !== entry.id) })); setMessage('') }}>Remove</Button>
        </div>
        {previews[entry.id] && <div className="min-w-0 rounded-md bg-muted p-2 text-label"><p className="font-medium">{previews[entry.id]!.illustrative ? 'Example preview — illustrative values' : 'Selected worktree preview'}</p><p className="break-all text-muted-foreground">Working directory: {previews[entry.id]!.cwd}</p><pre className="mt-1 whitespace-pre-wrap break-all font-mono text-ui">{previews[entry.id]!.renderedCommand}</pre><p className="mt-1 text-muted-foreground">Preview does not execute commands or expand shell expressions.</p></div>}
      </fieldset>)}
      <Button type="button" variant="outline" size="sm" className="self-start" disabled={draft[phase].length >= 32 || save.isPending} onClick={() => { setDraft(current => ({ ...current, [phase]: [...current[phase], { id: crypto.randomUUID(), command: '' }] })); setMessage('') }}>Add {phase === 'afterCreate' ? 'setup' : 'cleanup'} command</Button>
    </FormRow>)}
    <div className="flex flex-col gap-2 px-4 py-3">
      {(errors.form || save.error) && <p role="alert" className="text-ui text-danger">{errors.form ?? save.error?.message}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save scripts'}</Button>
        {save.isError && <Button type="button" variant="outline" size="sm" onClick={() => void reload()}>Reload saved scripts</Button>}
        {message && <p role="status" className="text-label text-muted-foreground">{message}</p>}
      </div>
      {pending.length > 0 && <div className="text-label text-muted-foreground"><p>Paused scripts wait for an explicit recovery choice.</p>{pending.map(worktree => <a key={worktree.worktreeId} className="mt-1 block text-violet underline underline-offset-2" href={`#lifecycle-operation-${worktree.operation!.id}`}>Return to {worktree.task?.title ?? 'orphan worktree'} and Retry</a>)}</div>}
    </div>
  </SettingsCard>
}
