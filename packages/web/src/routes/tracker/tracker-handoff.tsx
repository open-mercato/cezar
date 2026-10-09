import { AgentProviderGate } from '@/components/agent-provider-gate'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckIcon, PlayIcon, XIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import type { Skill, TrackerItem, WorkflowDef } from '@open-mercato/cezar-api-client'
import { createRun } from '@/api/client'
import { queryKeys } from '@/api/queries'
import { EnginePills, engineRunBody, useResolvedEngine, type EnginePick } from '@/components/engine-pills'
import { WorkflowPicker, SkillsPicker } from '@/components/agent-task-pickers'
import { isSubmitShortcut, submitShortcutHint } from '@/lib/use-submit-shortcut'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Kbd } from '@/components/ui/kbd'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'
import { MAX_CHAIN_STEPS } from '@/lib/github-task'
import { Link } from '@/lib/project-router'
import { TRACKER_TASK_LIMIT, trackerLosses, trackerRunBody, trackerTaskPrompt } from '@/lib/tracker-task'

export type TrackerDraftCache = Map<string, { instruction: string; supplemental: string; acknowledgedSnapshot: string | null }>

export type TrackerHandoffSelection = {
  workflow: string | null
  selectedSkills: readonly string[]
  engine: EnginePick
}

export function TrackerHandoff({ item, workflows, skills, selection, onSelectionChange, drafts, scopePending = false, detailUnavailable = false, onQueued }: {
  /** Fires with the queued run's id, so the host can confirm it outside this panel. */
  onQueued?: (runId: string | null) => void
  item: TrackerItem
  scopePending?: boolean
  detailUnavailable?: boolean
  drafts?: TrackerDraftCache
  selection?: TrackerHandoffSelection
  onSelectionChange?: React.Dispatch<React.SetStateAction<TrackerHandoffSelection>>
  workflows: readonly WorkflowDef[]
  skills: readonly Skill[]
}) {
  const queryClient = useQueryClient()
  const [localSelection, setLocalSelection] = useState<TrackerHandoffSelection>({ workflow: null, selectedSkills: [], engine: { runner: null, model: null, account: null } })
  const { workflow, selectedSkills, engine } = selection ?? localSelection
  const updateSelection = onSelectionChange ?? setLocalSelection
  const setWorkflow = (workflow: string | null) => updateSelection(current => ({ ...current, workflow }))
  const setEngine = (engine: EnginePick) => updateSelection(current => ({ ...current, engine }))
  const setSelectedSkills = (update: (current: readonly string[]) => readonly string[]) => updateSelection(current => ({ ...current, selectedSkills: update(current.selectedSkills) }))
  const [instruction, setInstruction] = useState(drafts?.get(item.url)?.instruction ?? '')
  const [supplemental, setSupplemental] = useState(drafts?.get(item.url)?.supplemental ?? '')
  const [acknowledgedSnapshot, setAcknowledgedSnapshot] = useState<string | null>(drafts?.get(item.url)?.acknowledgedSnapshot ?? null)
  useEffect(() => { drafts?.set(item.url, { instruction, supplemental, acknowledgedSnapshot }) }, [drafts, item.url, instruction, supplemental, acknowledgedSnapshot])
  const snapshotIdentity = JSON.stringify([item.id, item.body, item.bodyTruncated, item.unsupportedContent])
  const acknowledgeLoss = acknowledgedSnapshot === snapshotIdentity
  const [queued, setQueued] = useState<string | null>(null)
  const resolved = useResolvedEngine(engine)
  const losses = trackerLosses(item)
  const emptyDescription = item.body.trim() === ''
  const validSkills = selectedSkills.filter((name) => skills.some((skill) => skill.name === name))
  const skillChainOverLimit = workflow === null && validSkills.length > MAX_CHAIN_STEPS
  const composition = useMemo(() => {
    try {
      const task = trackerTaskPrompt(item, { skills: workflow ? validSkills : [], instruction, supplemental })
      return { task, error: null }
    } catch (error) {
      return { task: '', error: (error as Error).message }
    }
  }, [item, workflow, validSkills.join('\0'), instruction, supplemental])
  const start = useMutation({
    mutationFn: () => createRun(trackerRunBody(
      item,
      workflow,
      validSkills,
      engineRunBody(resolved),
      { instruction, supplemental, acknowledgeLoss },
    )),
    onSuccess: (created) => {
      const run = 'runs' in created ? created.runs[0] : created
      setQueued(run?.id ?? null)
      onQueued?.(run?.id ?? null)
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
      toast(`Added ${item.id} to the queue`)
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  const toggleSkill = (name: string) => setSelectedSkills((current) => {
    if (current.includes(name)) return current.filter((entry) => entry !== name)
    if (workflow === null && validSkills.length >= MAX_CHAIN_STEPS) return current
    return [...current, name]
  })

  const canSubmit = !scopePending && !detailUnavailable && !start.isPending && resolved.canRun && composition.error === null && !skillChainOverLimit && (losses.length === 0 || acknowledgeLoss)

  return (
    <section className="flex min-w-0 flex-col gap-3" data-slot="tracker-handoff">
      {losses.length || emptyDescription ? (
        <div className="flex flex-col gap-3 rounded-lg bg-pending/10 p-4 text-[13px]">
          <div>
            <p className="font-medium">{losses.length ? 'This provider snapshot lost some issue content.' : 'This issue has no description.'}</p>
            {losses.length ? <ul className="mt-1 list-disc pl-5 text-muted-foreground">{losses.map((loss) => <li key={loss}>{loss}</li>)}</ul> : <p className="mt-1 text-muted-foreground">Add any context the agent needs before starting.</p>}
            {losses.length ? <a className="mt-2 inline-block font-medium underline underline-offset-4" href={item.url} target="_blank" rel="noreferrer">Review the source issue</a> : null}
          </div>
          <Field>
            <FieldLabel htmlFor="tracker-supplemental">Supplemental context</FieldLabel>
            <Textarea id="tracker-supplemental" value={supplemental} onChange={(event) => setSupplemental(event.target.value)} placeholder="Paste any missing context here…" className="min-h-20 bg-card" />
          </Field>
          {losses.length ? <label className="flex items-start gap-2.5">
            <Checkbox className="mt-0.5" checked={acknowledgeLoss} onCheckedChange={(checked) => setAcknowledgedSnapshot(checked === true ? snapshotIdentity : null)} />
            I understand the agent receives this snapshot and the supplemental context above.
          </label> : null}
        </div>
      ) : null}
      <Field>
        <FieldLabel htmlFor="tracker-instruction">Custom instruction</FieldLabel>
        <Textarea id="tracker-instruction" aria-keyshortcuts="Control+Enter Meta+Enter" onKeyDown={event => { if (isSubmitShortcut(event.nativeEvent)) { event.preventDefault(); if (canSubmit) start.mutate() } }} value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="Optional instructions; these are placed last in the task." className="min-h-28 text-[13.5px]" />
        <FieldDescription className="flex justify-between gap-4 text-xs">
          <span className={composition.error ? 'text-danger' : undefined}>{composition.error ?? 'Full tracker detail and source link are included. Comments, attachments, and custom fields are outside the snapshot.'}</span>
          <span className="shrink-0 tabular-nums">{composition.task.length.toLocaleString()} / {TRACKER_TASK_LIMIT.toLocaleString()}</span>
        </FieldDescription>
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <WorkflowPicker workflows={workflows} value={workflow} onChange={setWorkflow} slotPrefix="tracker" />
        <SkillsPicker skills={skills} skillUsage={undefined} selected={validSkills} onToggle={toggleSkill} maxSelections={workflow === null ? MAX_CHAIN_STEPS : undefined} slotPrefix="tracker" />
        <EnginePills pick={engine} onChange={setEngine} accounts disabled={start.isPending || !resolved.canRun} />
        <AgentProviderGate resolved={resolved} dataSlot="tracker-provider-gate" />
      </div>
      {validSkills.length ? <div className="flex flex-wrap gap-1.5">{validSkills.map(name => <button type="button" key={name} aria-label={`Remove skill ${name}`} onClick={() => toggleSkill(name)} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 font-mono text-[11px] font-medium text-foreground transition-colors hover:bg-danger/10 hover:text-danger">{name}<XIcon aria-hidden="true" className="size-3" /></button>)}</div> : null}
      {workflow === null && validSkills.length >= MAX_CHAIN_STEPS ? (
        <p className={`text-xs ${skillChainOverLimit ? 'text-danger' : 'text-muted-foreground'}`}>
          Skill chains support at most {MAX_CHAIN_STEPS} skills. Remove one before selecting another.
        </p>
      ) : null}
      {scopePending ? <p role="status" className="text-[13px] text-muted-foreground">Verifying tracker connection…</p> : null}
      {detailUnavailable ? <p role="status" className="text-[13px] text-danger">Issue detail could not be verified. Retry successfully before starting the agent; your draft is preserved.</p> : null}
      <div className="mt-2 flex flex-wrap items-center justify-end gap-2.5">
        {queued ? <span className="mr-auto flex items-center gap-1.5 text-[13px] text-success"><CheckIcon className="size-3.5" /> Queued · <Link className="font-medium text-foreground underline-offset-4 hover:underline" to={`/tasks/${queued}`}>View task</Link></span> : null}
        <Kbd aria-hidden="true">{submitShortcutHint()}</Kbd>
        <Button variant="primary" onClick={() => start.mutate()} disabled={!canSubmit}>
          <PlayIcon aria-hidden="true" /> Run agent on this issue
        </Button>
      </div>
    </section>
  )
}
