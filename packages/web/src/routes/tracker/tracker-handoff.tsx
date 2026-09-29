import { AgentProviderGate } from '@/components/agent-provider-gate'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckIcon, PlayIcon, XIcon, ZapIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import type { Skill, TrackerItem, WorkflowDef } from '@open-mercato/cezar-api-client'
import { createRun } from '@/api/client'
import { queryKeys } from '@/api/queries'
import { EnginePills, engineRunBody, useResolvedEngine, type EnginePick } from '@/components/engine-pills'
import { WorkflowPicker, SkillsPicker } from '@/components/agent-task-pickers'
import { isSubmitShortcut, submitShortcutHint } from '@/lib/use-submit-shortcut'
import { Button } from '@/components/ui/button'
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

export function TrackerHandoff({ item, workflows, skills, selection, onSelectionChange, drafts, scopePending = false, detailUnavailable = false }: {
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
    <section className="mt-7 rounded-lg border border-border bg-card p-4" data-slot="tracker-handoff">
      <h2 className="flex items-center gap-1.5 text-[11px] font-semibold tracking-[.04em] text-soft-foreground uppercase">
        <ZapIcon className="size-3.5 text-violet" /> Hand this to the agent
      </h2>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <WorkflowPicker workflows={workflows} value={workflow} onChange={setWorkflow} slotPrefix="tracker" />
        <SkillsPicker skills={skills} skillUsage={undefined} selected={validSkills} onToggle={toggleSkill} maxSelections={workflow === null ? MAX_CHAIN_STEPS : undefined} slotPrefix="tracker" />
        <EnginePills pick={engine} onChange={setEngine} accounts disabled={start.isPending || !resolved.canRun} />
        <AgentProviderGate resolved={resolved} dataSlot="tracker-provider-gate" />
      </div>
      {validSkills.length ? <div className="mt-2.5 flex flex-wrap gap-1.5">{validSkills.map(name => <button type="button" key={name} aria-label={`Remove skill ${name}`} onClick={() => toggleSkill(name)} className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-px font-mono text-[11px] font-medium text-foreground transition-colors hover:bg-danger/10 hover:text-danger">{name}<XIcon aria-hidden="true" className="size-3" /></button>)}</div> : null}
      {workflow === null && validSkills.length >= MAX_CHAIN_STEPS ? (
        <p className={`mt-2 text-xs ${skillChainOverLimit ? 'text-danger' : 'text-muted-foreground'}`}>
          Skill chains support at most {MAX_CHAIN_STEPS} skills. Remove one before selecting another.
        </p>
      ) : null}
      {losses.length || emptyDescription ? (
        <div className="mt-3 rounded-md border border-warning/50 bg-warning/10 p-3 text-sm">
          <p className="font-medium">{losses.length ? 'This provider snapshot lost some issue content.' : 'This issue has no description.'}</p>
          {losses.length ? <ul className="mt-1 list-disc pl-5 text-xs">{losses.map((loss) => <li key={loss}>{loss}</li>)}</ul> : <p className="mt-1 text-xs">Add any context the agent needs before starting.</p>}
          {losses.length ? <a className="mt-2 inline-block text-xs text-violet underline underline-offset-4" href={item.url} target="_blank" rel="noreferrer">Review the source issue</a> : null}
          <label className="mt-3 block text-xs font-medium" htmlFor="tracker-supplemental">Supplemental context</label>
          <Textarea id="tracker-supplemental" value={supplemental} onChange={(event) => setSupplemental(event.target.value)} placeholder="Paste any missing context here…" className="mt-1 min-h-20 bg-background" />
          {losses.length ? <label className="mt-2 flex items-start gap-2 text-xs">
            <input type="checkbox" checked={acknowledgeLoss} onChange={(event) => setAcknowledgedSnapshot(event.target.checked ? snapshotIdentity : null)} />
            I understand the agent receives this snapshot and the supplemental context above.
          </label> : null}
        </div>
      ) : null}
      <label className="mt-3 block text-xs font-medium" htmlFor="tracker-instruction">Custom instruction</label>
      <Textarea id="tracker-instruction" aria-keyshortcuts="Control+Enter Meta+Enter" onKeyDown={event => { if (isSubmitShortcut(event.nativeEvent)) { event.preventDefault(); if (canSubmit) start.mutate() } }} value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="Optional instructions; these are placed last in the task." className="mt-1 min-h-20 text-[13px]" />
      <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
        <span>{composition.error ?? 'Full tracker detail and source link are included. Comments, attachments, and custom fields are outside the snapshot.'}</span>
        <span>{composition.task.length.toLocaleString()} / {TRACKER_TASK_LIMIT.toLocaleString()}</span>
      </div>
      {scopePending ? <p role="status" className="mt-3 text-xs text-muted-foreground">Verifying tracker connection…</p> : null}
      {detailUnavailable ? <p role="status" className="mt-3 text-xs text-danger">Issue detail could not be verified. Retry successfully before starting the agent; your draft is preserved.</p> : null}
      <div className="mt-4 flex flex-wrap items-center gap-2.5">
        <Button variant="contrast" onClick={() => start.mutate()} disabled={!canSubmit}>
          <PlayIcon className="size-3.5" /> Run agent on this issue
        </Button>
        <kbd aria-hidden="true" className="rounded-[5px] border border-b-2 border-border bg-card px-[5px] py-px font-mono text-[10.5px] font-medium text-muted-foreground">{submitShortcutHint()}</kbd>
        {queued ? <span className="flex items-center gap-1 text-xs text-success"><CheckIcon className="size-3" /> queued · <Link className="text-violet hover:underline" to={`/tasks/${queued}`}>View task →</Link></span> : null}
      </div>
    </section>
  )
}
