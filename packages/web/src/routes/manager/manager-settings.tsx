import { PlusIcon, SettingsIcon, Trash2Icon } from 'lucide-react'
import { useState } from 'react'

import { checkManager, useDeleteManager, useUpdateManager } from '@/api/managers'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { toast } from '@/components/ui/toaster'
import { ManagerAvatar, PERSONA_CHOICES } from './manager-avatar'
import type { ManagerSummary, UpdateManagerInput } from '@open-mercato/cezar-api-client'

import { AccountPicker, ModelPicker, RefreshPicker, ProjectsPicker, type ManagerPatch } from './manager-pickers'

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

type JobDraft = NonNullable<UpdateManagerInput['jobs']>[number]

const newJob = (): JobDraft => ({ name: '', prompt: '', everyMinutes: 60, enabled: true })

/** A saved prompt must name itself and say something; `everyMinutes` is the contract's range. */
export function jobIsValid(job: JobDraft): boolean {
  return job.name.trim() !== '' && job.prompt.trim() !== '' && job.everyMinutes >= 5 && job.everyMinutes <= 10_080
}

export function JobsDialog({
  manager,
  open,
  onOpenChange,
  onSave,
}: {
  manager: ManagerSummary
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (jobs: JobDraft[]) => Promise<unknown>
}) {
  const [jobs, setJobs] = useState<JobDraft[]>(() =>
    manager.jobs.map(({ id, name, prompt, everyMinutes, enabled }) => ({ id, name, prompt, everyMinutes, enabled })))
  const [saving, setSaving] = useState(false)
  const patch = (index: number, next: Partial<JobDraft>) =>
    setJobs((current) => current.map((job, at) => (at === index ? { ...job, ...next } : job)))
  const save = () => {
    setSaving(true)
    void onSave(jobs).then(
      () => onOpenChange(false),
      (error: unknown) => toast(errorMessage(error), { tone: 'danger' }),
    ).finally(() => setSaving(false))
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Jobs</DialogTitle>
          <DialogDescription>Saved prompts this manager runs on their own cadence.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {jobs.length === 0 ? <p className="text-sm text-muted-foreground">No jobs yet.</p> : null}
          {jobs.map((job, index) => (
            <fieldset key={job.id ?? `new-${index}`} data-slot="manager-job" className="flex flex-col gap-2 rounded-lg border border-border p-3">
              <legend className="sr-only">Job {index + 1}</legend>
              <div className="flex items-center gap-2">
                <Input
                  aria-label="Job name"
                  placeholder="Name"
                  value={job.name}
                  maxLength={80}
                  onChange={(event) => patch(index, { name: event.target.value })}
                />
                <Switch
                  aria-label="Job enabled"
                  checked={job.enabled}
                  onCheckedChange={(enabled) => patch(index, { enabled })}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Remove job"
                  onClick={() => setJobs((current) => current.filter((_, at) => at !== index))}
                >
                  <Trash2Icon aria-hidden="true" />
                </Button>
              </div>
              <Textarea
                aria-label="Job prompt"
                placeholder="What should it do?"
                rows={2}
                value={job.prompt}
                onChange={(event) => patch(index, { prompt: event.target.value })}
              />
              <Label className="flex items-center gap-2 text-xs text-muted-foreground">
                Every
                <Input
                  type="number"
                  className="h-8 w-24"
                  min={5}
                  max={10_080}
                  value={job.everyMinutes}
                  onChange={(event) => patch(index, { everyMinutes: Number(event.target.value) })}
                />
                minutes
              </Label>
            </fieldset>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            disabled={jobs.length >= 32}
            onClick={() => setJobs((current) => [...current, newJob()])}
          >
            <PlusIcon aria-hidden="true" />
            Add job
          </Button>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={saving || !jobs.every(jobIsValid)} onClick={save}>Save jobs</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PersonaDialog({
  manager,
  open,
  onOpenChange,
  onSave,
}: {
  manager: ManagerSummary
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (patch: UpdateManagerInput) => Promise<unknown>
}) {
  const [name, setName] = useState(manager.name)
  const [instructions, setInstructions] = useState(manager.instructions)
  const [avatar, setAvatar] = useState(manager.avatar)
  const save = () => {
    void onSave({ name: name.trim(), instructions, avatar }).then(
      () => onOpenChange(false),
      (error: unknown) => toast(errorMessage(error), { tone: 'danger' }),
    )
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Persona</DialogTitle>
          <DialogDescription>How this manager looks and what it is for. The instructions become part of its system prompt.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div role="radiogroup" aria-label="Character" data-slot="manager-persona-picker" className="flex flex-wrap gap-1">
            {Array.from({ length: PERSONA_CHOICES }, (_, index) => (
              <button
                key={index}
                type="button"
                role="radio"
                aria-checked={avatar === index}
                aria-label={`Character ${index + 1}`}
                onClick={() => setAvatar(index)}
                className={cn(
                  'rounded-lg p-1 outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  avatar === index && 'bg-muted ring-1 ring-border',
                )}
              >
                <ManagerAvatar avatar={index} className="size-9" />
              </button>
            ))}
          </div>
          <Label className="flex flex-col items-start gap-1.5">
            Name
            <Input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
          </Label>
          <Label className="flex flex-col items-start gap-1.5">
            Instructions
            <Textarea rows={5} value={instructions} onChange={(event) => setInstructions(event.target.value)} />
          </Label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={name.trim() === ''} onClick={save}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The gear: the Figma's four pickers, then what a manager's lifetime needs beyond them. */
export function ManagerSettings({ manager, onPatch }: { manager: ManagerSummary; onPatch: (patch: ManagerPatch) => void }) {
  const update = useUpdateManager(manager.id)
  const remove = useDeleteManager(manager.id)
  const [dialog, setDialog] = useState<'rename' | 'jobs' | 'delete' | null>(null)
  const closeDialog = (open: boolean) => {
    if (!open) setDialog(null)
  }
  const checkNow = () => {
    void checkManager(manager.id).then(
      () => toast('Check started'),
      (error: unknown) => toast(errorMessage(error), { tone: 'danger' }),
    )
  }
  const confirmDelete = () => {
    remove.mutate(undefined, {
      onError: (error) => toast(errorMessage(error), { tone: 'danger' }),
    })
  }
  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Manager settings" data-slot="manager-settings" className="shrink-0 max-md:size-11">
            <SettingsIcon aria-hidden="true" className="size-5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="flex w-64 flex-col items-start gap-0.5 p-2" data-slot="manager-settings-menu">
          <ProjectsPicker value={manager.projects} onChange={(projects) => onPatch({ projects })} />
          <ModelPicker {...pickModel(manager)} onChange={onPatch} />
          <AccountPicker
            {...(manager.runner ? { runner: manager.runner } : {})}
            {...(manager.agentProfile ? { agentProfile: manager.agentProfile } : {})}
            onChange={onPatch}
          />
          <RefreshPicker minutes={manager.cronMinutes} onChange={onPatch} />
          <label className="flex min-h-8 w-full items-center justify-between gap-2 px-1.5 text-sm text-muted-foreground">
            Notify me when important
            <Switch
              aria-label="Notify me when important"
              checked={manager.notify !== false}
              onCheckedChange={(notify) => update.mutate({ notify })}
            />
          </label>
          <Separator className="my-1.5" />
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => setDialog('rename')}>Persona…</Button>
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => setDialog('jobs')}>
            Jobs{manager.jobs.length > 0 ? ` (${manager.jobs.length})` : ''}…
          </Button>
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={checkNow}>Check now</Button>
          <Button variant="ghost" size="sm" className="w-full justify-start text-danger hover:text-danger" onClick={() => setDialog('delete')}>
            Delete…
          </Button>
          {manager.costUsd > 0 ? (
            <p className="px-2.5 pt-1 text-meta text-soft-foreground">Spent ${manager.costUsd.toFixed(2)}</p>
          ) : null}
        </PopoverContent>
      </Popover>
      {dialog === 'rename' ? (
        <PersonaDialog manager={manager} open onOpenChange={closeDialog} onSave={(patch) => update.mutateAsync(patch)} />
      ) : null}
      {dialog === 'jobs' ? (
        <JobsDialog manager={manager} open onOpenChange={closeDialog} onSave={(jobs) => update.mutateAsync({ jobs })} />
      ) : null}
      <AlertDialog open={dialog === 'delete'} onOpenChange={closeDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {manager.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its chat history and jobs are gone for good. Tasks it started stay where they are.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/** The optional keys `exactOptionalPropertyTypes` won't take as `undefined`. */
export function pickModel(manager: Pick<ManagerSummary, 'runner' | 'model' | 'effort'>) {
  return {
    ...(manager.runner ? { runner: manager.runner } : {}),
    ...(manager.model ? { model: manager.model } : {}),
    ...(manager.effort ? { effort: manager.effort } : {}),
  }
}
