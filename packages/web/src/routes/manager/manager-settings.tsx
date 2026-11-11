import { BellIcon, ClockIcon, MessageSquareTextIcon, PlusIcon, RefreshCwIcon, SettingsIcon, Trash2Icon, UserRoundIcon } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'

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
import { enterInsertsNewline } from '@/lib/enter-key'
import { cn } from '@/lib/utils'
import { toast } from '@/components/ui/toaster'
import { ManagerAvatar, PERSONA_CHOICES } from './manager-avatar'
import { MANAGER_QUICK_PROMPTS_MAX, type ManagerMascot, type ManagerQuickPrompt, type ManagerSummary, type UpdateManagerInput } from '@open-mercato/cezar-api-client'

import { MascotPicker } from './mascot-picker'

import { SheetContent } from './manager-approval'
import { AccountPicker, ModelPicker, PICKER_TRIGGER, RefreshPicker, ProjectsPicker, type ManagerPatch } from './manager-pickers'

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

type JobDraft = NonNullable<UpdateManagerInput['jobs']>[number]

/** Header and footer stay put while the body scrolls: on a phone Save must not sit below a long form. */
const SCROLLING_DIALOG = 'grid max-h-[85dvh] grid-rows-[auto_minmax(0,1fr)_auto]'

const newJob = (): JobDraft => ({ name: '', prompt: '', everyMinutes: 60, enabled: true })

/** A saved prompt must name itself and say something; `everyMinutes` is the contract's range. */
export function jobIsValid(job: JobDraft): boolean {
  return job.name.trim() !== '' && job.prompt.trim() !== '' && Number.isInteger(job.everyMinutes) && job.everyMinutes >= 5 && job.everyMinutes <= 10_080
}

export function JobsDialog({
  manager,
  open,
  onOpenChange,
  onSave,
  onCloseAutoFocus,
}: {
  manager: ManagerSummary
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (jobs: JobDraft[]) => Promise<unknown>
  onCloseAutoFocus?: (event: Event) => void
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
      <DialogContent className={cn(SCROLLING_DIALOG, 'sm:max-w-xl')} {...(onCloseAutoFocus ? { onCloseAutoFocus } : {})}>
        <DialogHeader>
          <DialogTitle>Jobs</DialogTitle>
          <DialogDescription>Saved prompts this manager runs on their own cadence.</DialogDescription>
        </DialogHeader>
        <div className="-mx-1 flex min-h-0 flex-col gap-3 overflow-y-auto overscroll-contain px-1 py-1">
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

export const quickPromptIsValid = (entry: ManagerQuickPrompt): boolean => entry.label.trim() !== '' && entry.prompt.trim() !== ''

/** The user's own chips above the composer (spec 2026-10-31-managers). None: no chip row at all. */
export function QuickPromptsDialog({
  manager,
  open,
  onOpenChange,
  onSave,
  onCloseAutoFocus,
}: {
  manager: ManagerSummary
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (quickPrompts: ManagerQuickPrompt[]) => Promise<unknown>
  onCloseAutoFocus?: (event: Event) => void
}) {
  const [entries, setEntries] = useState<ManagerQuickPrompt[]>(() => manager.quickPrompts ?? [])
  const [saving, setSaving] = useState(false)
  const patch = (index: number, next: Partial<ManagerQuickPrompt>) =>
    setEntries((current) => current.map((entry, at) => (at === index ? { ...entry, ...next } : entry)))
  const save = () => {
    setSaving(true)
    void onSave(entries.map(({ label, prompt }) => ({ label: label.trim(), prompt: prompt.trim() }))).then(
      () => onOpenChange(false),
      (error: unknown) => toast(errorMessage(error), { tone: 'danger' }),
    ).finally(() => setSaving(false))
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn(SCROLLING_DIALOG, 'sm:max-w-xl')} {...(onCloseAutoFocus ? { onCloseAutoFocus } : {})}>
        <DialogHeader>
          <DialogTitle>Quick prompts</DialogTitle>
          <DialogDescription>Buttons above the message box that send a prompt you use often. Type / for the built-in commands.</DialogDescription>
        </DialogHeader>
        <div className="-mx-1 flex min-h-0 flex-col gap-3 overflow-y-auto overscroll-contain px-1 py-1">
          {entries.length === 0 ? <p className="text-sm text-muted-foreground">No quick prompts yet.</p> : null}
          {entries.map((entry, index) => (
            <fieldset key={index} data-slot="manager-quick-prompt" className="flex flex-col gap-2 rounded-lg border border-border p-3">
              <legend className="sr-only">Quick prompt {index + 1}</legend>
              <div className="flex items-center gap-2">
                <Input
                  aria-label="Button label"
                  placeholder="Label"
                  value={entry.label}
                  maxLength={24}
                  onChange={(event) => patch(index, { label: event.target.value })}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Remove quick prompt"
                  onClick={() => setEntries((current) => current.filter((_, at) => at !== index))}
                >
                  <Trash2Icon aria-hidden="true" />
                </Button>
              </div>
              <Textarea
                aria-label="Prompt"
                placeholder="What it sends"
                rows={2}
                maxLength={2_000}
                value={entry.prompt}
                onChange={(event) => patch(index, { prompt: event.target.value })}
              />
            </fieldset>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            disabled={entries.length >= MANAGER_QUICK_PROMPTS_MAX}
            onClick={() => setEntries((current) => [...current, { label: '', prompt: '' }])}
          >
            <PlusIcon aria-hidden="true" />
            Add quick prompt
          </Button>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={saving || !entries.every(quickPromptIsValid)} onClick={save}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** On a phone a focused field opens the keyboard over the form: focus the dialog itself instead. */
function keepKeyboardDown(event: Event) {
  if (!enterInsertsNewline()) return
  event.preventDefault()
  ;(event.currentTarget as HTMLElement | null)?.focus({ preventScroll: true })
}

export function PersonaDialog({
  manager,
  open,
  onOpenChange,
  onSave,
  onCloseAutoFocus,
}: {
  manager: ManagerSummary
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (patch: UpdateManagerInput) => Promise<unknown>
  onCloseAutoFocus?: (event: Event) => void
}) {
  const [name, setName] = useState(manager.name)
  const [instructions, setInstructions] = useState(manager.instructions)
  const [avatar, setAvatar] = useState(manager.avatar)
  const [mascot, setMascot] = useState<ManagerMascot | undefined>(manager.mascot)
  const save = () => {
    void onSave({ name: name.trim(), instructions, avatar, ...(mascot ? { mascot } : {}) }).then(
      () => onOpenChange(false),
      (error: unknown) => toast(errorMessage(error), { tone: 'danger' }),
    )
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <SheetContent data-slot="manager-persona-sheet" onOpenAutoFocus={keepKeyboardDown} {...(onCloseAutoFocus ? { onCloseAutoFocus } : {})}>
        <DialogHeader className="text-left">
          <DialogTitle>Persona</DialogTitle>
          <DialogDescription>How this manager looks and what it is for. The instructions become part of its system prompt.</DialogDescription>
        </DialogHeader>
        <div className="-mx-1 flex min-h-0 flex-col gap-3 overflow-y-auto overscroll-contain px-1 py-1">
          <Label className="flex flex-col items-start gap-1.5">
            Name
            <Input name="name" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
          </Label>
          <MascotPicker value={mascot} onChange={setMascot} compact />
          {manager.mascot === undefined && mascot === undefined ? <div role="radiogroup" aria-label="Character" data-slot="manager-persona-picker" className="flex flex-wrap gap-1">
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
          </div> : null}
          <Label className="flex flex-col items-start gap-1.5">
            Instructions
            <Textarea name="instructions" rows={5} value={instructions} onChange={(event) => setInstructions(event.target.value)} />
          </Label>
        </div>
        <DialogFooter className="flex-row">
          <Button variant="outline" className="h-11 flex-1 md:h-9 md:flex-none" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button className="h-11 flex-1 md:h-9 md:flex-none" disabled={name.trim() === ''} onClick={save}>Save</Button>
        </DialogFooter>
      </SheetContent>
    </Dialog>
  )
}

/** A menu action, drawn like the picker rows above it: one icon column, one weight. */
function MenuRow({ icon, danger, onClick, children }: { icon: ReactNode; danger?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      data-slot="manager-menu-row"
      className={cn(PICKER_TRIGGER, 'w-full [&>svg]:size-3.5 [&>svg]:shrink-0', danger && 'text-danger hover:text-danger')}
      onClick={onClick}
    >
      {icon}
      {children}
    </button>
  )
}

/** The gear: the Figma's four pickers, then what a manager's lifetime needs beyond them. */
export function ManagerSettings({ manager, onPatch }: { manager: ManagerSummary; onPatch: (patch: ManagerPatch) => void }) {
  const update = useUpdateManager(manager.id)
  const remove = useDeleteManager(manager.id)
  const [dialog, setDialog] = useState<'rename' | 'jobs' | 'prompts' | 'delete' | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const openDialog = (next: 'rename' | 'jobs' | 'prompts' | 'delete') => {
    setMenuOpen(false)
    setDialog(next)
  }
  // The menu item that opened a dialog is gone by the time it closes: Radix would drop focus on <body>.
  const returnFocus = (event: Event) => {
    event.preventDefault()
    trigger.current?.focus()
  }
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
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger asChild>
          <Button ref={trigger} variant="ghost" size="icon" aria-label="Manager settings" data-slot="manager-settings" className="shrink-0 max-md:size-11">
            <SettingsIcon aria-hidden="true" className="size-5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="flex w-64 flex-col items-stretch gap-0.5 p-2" data-slot="manager-settings-menu">
          <ProjectsPicker value={manager.projects} access={manager.access} projectAccess={manager.projectAccess} onAccess={onPatch} onChange={(projects) => onPatch({ projects })} />
          <ModelPicker {...pickModel(manager)} onChange={onPatch} />
          <AccountPicker
            {...(manager.runner ? { runner: manager.runner } : {})}
            {...(manager.agentProfile ? { agentProfile: manager.agentProfile } : {})}
            onChange={onPatch}
          />
          <RefreshPicker minutes={manager.cronMinutes} onChange={onPatch} />
          <label className="flex min-h-8 w-full items-center gap-1.5 px-1.5 text-sm text-muted-foreground pointer-coarse:min-h-11">
            <BellIcon aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="flex-1">Notify me when important</span>
            <Switch
              aria-label="Notify me when important"
              checked={manager.notify !== false}
              onCheckedChange={(notify) => update.mutate({ notify })}
            />
          </label>
          <Separator className="my-1.5" />
          <MenuRow icon={<UserRoundIcon aria-hidden="true" />} onClick={() => openDialog('rename')}>Persona…</MenuRow>
          <MenuRow icon={<ClockIcon aria-hidden="true" />} onClick={() => openDialog('jobs')}>
            Jobs{manager.jobs.length > 0 ? ` (${manager.jobs.length})` : ''}…
          </MenuRow>
          <MenuRow icon={<MessageSquareTextIcon aria-hidden="true" />} onClick={() => openDialog('prompts')}>
            Quick prompts{manager.quickPrompts?.length ? ` (${manager.quickPrompts.length})` : ''}…
          </MenuRow>
          <MenuRow icon={<RefreshCwIcon aria-hidden="true" />} onClick={checkNow}>Check now</MenuRow>
          <MenuRow icon={<Trash2Icon aria-hidden="true" />} danger onClick={() => openDialog('delete')}>Delete…</MenuRow>
          {manager.costUsd > 0 ? (
            <p className="px-1.5 pt-1 text-meta text-muted-foreground">Spent ${manager.costUsd.toFixed(2)}</p>
          ) : null}
        </PopoverContent>
      </Popover>
      {dialog === 'rename' ? (
        <PersonaDialog manager={manager} open onOpenChange={closeDialog} onCloseAutoFocus={returnFocus} onSave={(patch) => update.mutateAsync(patch)} />
      ) : null}
      {dialog === 'jobs' ? (
        <JobsDialog manager={manager} open onOpenChange={closeDialog} onCloseAutoFocus={returnFocus} onSave={(jobs) => update.mutateAsync({ jobs })} />
      ) : null}
      {dialog === 'prompts' ? (
        <QuickPromptsDialog manager={manager} open onOpenChange={closeDialog} onCloseAutoFocus={returnFocus} onSave={(quickPrompts) => update.mutateAsync({ quickPrompts })} />
      ) : null}
      <AlertDialog open={dialog === 'delete'} onOpenChange={closeDialog}>
        <AlertDialogContent onCloseAutoFocus={returnFocus}>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {manager.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its chat history and jobs are gone for good. Tasks it started stay where they are.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-danger text-danger-foreground hover:brightness-[0.96]" onClick={confirmDelete}>Delete</AlertDialogAction>
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
