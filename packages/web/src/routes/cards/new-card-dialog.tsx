import type { CreateCardBody, FrameworkFile, FrameworkSummary, RunRecord } from '@open-mercato/cezar-api-client'
import * as React from 'react'

import { useCreateCard, useFramework } from '@/api/frameworks'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'
import { slugify } from '@/lib/cards'
import { cn } from '@/lib/utils'

import { InstallFrameworkDialog } from '../settings/framework-section'
import { IssuePicker, type PickedIssue } from './issue-picker'

/**
 * New card (spec 2026-11-15-framework-board, mockup 4). The form adapts to the framework: its
 * stage preview and its own `cardFields`. Save to Backlog holds the card (D2); Create · Ready
 * queues it for the next free slot.
 */

export interface NewCardForm {
  title: string
  brief: string
  framework: string
  /** Picked from the issue list, or a typed ref (the picker's fallback). */
  issue: PickedIssue | null
  fields: Record<string, string | boolean>
  /** Field names the user typed into — a `from: title` field stops following the title then. */
  touched: ReadonlySet<string>
  startAt: string
  skipFirst: boolean
  models: Record<string, string>
  autonomous: boolean
  ready: boolean
  budget: string
}

export function emptyNewCardForm(framework: string): NewCardForm {
  return {
    title: '',
    brief: '',
    framework,
    issue: null,
    fields: {},
    touched: new Set(),
    startAt: '',
    skipFirst: false,
    models: {},
    autonomous: false,
    ready: false,
    budget: '',
  }
}

/** A field's value as shown: typed, else its default (`from: title` slugifies the title). */
export function fieldValue(form: NewCardForm, field: NonNullable<FrameworkFile['cardFields']>[number]): string | boolean {
  const typed = form.fields[field.name]
  if (typed !== undefined && (form.touched.has(field.name) || field.from !== 'title')) return typed
  if (field.from === 'title') return form.title.trim() ? slugify(form.title) : ''
  if (field.default !== undefined) return field.default
  return field.type === 'boolean' ? false : ''
}

/** Field name → message; empty when the card can be created. */
export function validateNewCard(form: NewCardForm, framework: FrameworkFile | undefined): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!form.title.trim()) errors.title = 'A card needs a title.'
  else if (form.title.trim().length > 200) errors.title = 'Keep the title under 200 characters.'
  for (const field of framework?.cardFields ?? []) {
    if (field.type === 'boolean') continue
    const value = String(fieldValue(form, field))
    if (field.pattern) {
      let re: RegExp | undefined
      try {
        re = new RegExp(field.pattern)
      } catch {
        re = undefined
      }
      if (re && !re.test(value)) errors[`field:${field.name}`] = `${field.label} must match ${field.pattern}`
    }
  }
  if (form.budget.trim()) {
    const n = Number(form.budget)
    if (!Number.isFinite(n) || n <= 0) errors.budget = 'Budget is a positive dollar amount.'
  }
  return errors
}

/** Which stages the card runs: Start at, Skip first, and `skipUnless` false (compile.ts rules). */
export function previewStages(form: NewCardForm, framework: FrameworkFile): { id: string; name: string; skipped: boolean; stage: FrameworkFile['stages'][number] }[] {
  const startIndex = form.startAt ? Math.max(0, framework.stages.findIndex((s) => s.id === form.startAt)) : 0
  const fields = Object.fromEntries((framework.cardFields ?? []).map((f) => [f.name, fieldValue(form, f)]))
  return framework.stages.map((stage, i) => ({
    id: stage.id,
    name: stage.name ?? stage.id,
    stage,
    skipped:
      i < startIndex ||
      (form.skipFirst && i === startIndex) ||
      (stage.skipUnless !== undefined && fields[stage.skipUnless] !== true),
  }))
}

export function buildCreateCardBody(form: NewCardForm, framework: FrameworkFile | undefined, ready: boolean): CreateCardBody {
  const fields = Object.fromEntries((framework?.cardFields ?? []).map((f) => [f.name, fieldValue(form, f)]))
  const issue = form.issue ? { provider: form.issue.provider, ref: form.issue.ref, ...(form.issue.url ? { url: form.issue.url } : {}) } : undefined
  const first = framework?.stages[form.startAt ? Math.max(0, framework.stages.findIndex((s) => s.id === form.startAt)) : 0]
  const overrides = Object.fromEntries(
    Object.entries(form.models)
      .map(([stage, model]) => [stage, model.trim()] as const)
      .filter(([, model]) => model !== '')
      .map(([stage, model]) => [stage, { model }]),
  )
  return {
    title: form.title.trim(),
    ...(form.brief.trim() ? { brief: form.brief.trim() } : {}),
    framework: form.framework,
    ...(Object.keys(fields).length > 0 ? { fields } : {}),
    ...(issue ? { issue } : {}),
    ready,
    ...(form.autonomous ? { autonomous: true } : {}),
    ...(form.startAt && form.startAt !== framework?.stages[0]?.id ? { startAt: form.startAt } : {}),
    ...(form.skipFirst && first ? { skip: [first.id] } : {}),
    ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
    ...(form.budget.trim() ? { budgetUsd: Number(form.budget) } : {}),
  }
}

/** Cards fork from the base ref, so a framework missing there would start without its files. */
export function notOnBaseMessage(fw: FrameworkSummary | undefined): string | null {
  if (!fw || fw.installedOnBase !== false || !fw.baseRef) return null
  const missing = fw.missingOnBase?.length ? ` (missing: ${fw.missingOnBase.join(', ')})` : ''
  return `${fw.name} is not installed on ${fw.baseRef} — cards fork from ${fw.baseRef}, so install and commit it there first${missing}.`
}

function Field({ label, htmlFor, error, children, hint }: { label: string; htmlFor: string; error?: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-label font-medium text-foreground">
        {label}
      </label>
      {children}
      {hint ? <p className="text-meta text-muted-foreground">{hint}</p> : null}
      {error ? (
        <p role="alert" data-error-for={htmlFor} className="text-meta text-danger">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export function NewCardDialog({
  open,
  onOpenChange,
  frameworks,
  activeFramework,
  slots,
  readyAhead = 0,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  frameworks: readonly FrameworkSummary[]
  activeFramework: string
  /** Agent slots busy / total, for the Ready toggle's line. */
  slots?: { busy: number; max: number }
  readyAhead?: number
  onCreated?: (run: RunRecord) => void
}) {
  const [form, setForm] = React.useState<NewCardForm>(() => emptyNewCardForm(activeFramework))
  const [submitted, setSubmitted] = React.useState(false)
  const [overridesOpen, setOverridesOpen] = React.useState(false)
  const [installing, setInstalling] = React.useState(false)
  React.useEffect(() => {
    if (open) {
      setForm(emptyNewCardForm(activeFramework))
      setSubmitted(false)
    }
  }, [open, activeFramework])
  const detail = useFramework(open ? form.framework : undefined)
  const framework = detail.data?.framework
  const create = useCreateCard()
  const errors = validateNewCard(form, framework)
  const shown = submitted ? errors : {}
  const update = (patch: Partial<NewCardForm>) => setForm((current) => ({ ...current, ...patch }))
  const stages = framework ? previewStages(form, framework) : []

  const summary = frameworks.find((f) => f.id === form.framework)
  const notOnBase = notOnBaseMessage(summary)
  const canInstall = Boolean(notOnBase && summary?.availability?.installable && summary.install)
  // A 409 the summary did not predict (the base moved, an install left uncommitted) stays in the form.
  const createError = create.isError && create.variables?.framework === form.framework ? create.error.message : null

  const submit = (ready: boolean) => {
    setSubmitted(true)
    if (Object.keys(errors).length > 0 || !framework || notOnBase) return
    create.mutate(buildCreateCardBody(form, framework, ready), {
      onSuccess: (run) => {
        toast(ready ? `“${run.card?.title ?? form.title}” is Ready — an agent picks it up when a slot frees.` : `“${run.card?.title ?? form.title}” saved to Backlog.`)
        onOpenChange(false)
        onCreated?.(run)
      },
    })
  }
  const frameworkName = summary?.name ?? form.framework

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-slot="new-card-dialog" className={cn(
          'max-h-[90dvh] overflow-y-auto sm:max-w-2xl',
          // A phone gets the whole screen (spec § Mobile board): a long form in a floating box loses its footer.
          'max-md:inset-0 max-md:h-dvh max-md:max-h-none max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-none max-md:border-0 max-md:pt-[calc(1.5rem+env(safe-area-inset-top))] max-md:pb-[calc(1.5rem+env(safe-area-inset-bottom)+var(--kb,0px))] max-md:data-[state=closed]:zoom-out-100 max-md:data-[state=open]:zoom-in-100 max-md:content-start max-md:[&>[data-slot=dialog-close]]:top-[calc(1rem+env(safe-area-inset-top))]',
        )}>
        <DialogHeader>
          <DialogTitle>
            New card <span className="ml-1 text-label font-normal text-violet">◆ {frameworkName}</span>
          </DialogTitle>
          <DialogDescription>A card moves across the board through the framework’s stages and stops at its gates for you.</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3.5"
          onSubmit={(event) => {
            event.preventDefault()
            submit(form.ready)
          }}
        >
          <Field label="Title" htmlFor="card-title" error={shown.title}>
            <Input id="card-title" autoFocus value={form.title} onChange={(e) => update({ title: e.target.value })} aria-invalid={Boolean(shown.title)} />
          </Field>
          <Field label="Brief" htmlFor="card-brief">
            <Textarea id="card-brief" rows={4} value={form.brief} onChange={(e) => update({ brief: e.target.value })} placeholder="What should change, for whom, and why." />
          </Field>
          <div className="grid gap-3.5 sm:grid-cols-2">
            <Field label="Framework" htmlFor="card-framework">
              <Select
                value={form.framework}
                onValueChange={(value) => update({ framework: value, startAt: '', skipFirst: false, models: {}, fields: {}, touched: new Set() })}
              >
                <SelectTrigger id="card-framework" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper">
                  {frameworks
                    .filter((f) => !f.error)
                    .map((f) => (
                      <SelectItem key={f.id} value={f.id}>
                        {f.name}
                        {f.id === activeFramework ? ' (project default)' : ''}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Linked issue" htmlFor="card-issue" hint="Optional — an open GitHub or tracker issue; picking one fills an empty title and brief.">
              <IssuePicker
                id="card-issue"
                value={form.issue}
                onChange={(issue) =>
                  setForm((current) => ({
                    ...current,
                    issue,
                    ...(issue?.title && !current.title.trim() ? { title: issue.title } : {}),
                    ...(issue?.body && !current.brief.trim() ? { brief: issue.body } : {}),
                  }))
                }
              />
            </Field>
          </div>

          {notOnBase ? (
            <div data-slot="framework-not-on-base" role="alert" className="flex flex-col items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5 text-label text-foreground">
              <p>{notOnBase}</p>
              {canInstall ? (
                <Button type="button" variant="outline" size="sm" data-action="framework-install" onClick={() => setInstalling(true)}>
                  Install into this repo
                </Button>
              ) : null}
            </div>
          ) : null}

          {(framework?.cardFields ?? []).map((field) => {
            const id = `card-field-${field.name}`
            const value = fieldValue(form, field)
            const setField = (next: string | boolean) =>
              setForm((current) => ({ ...current, fields: { ...current.fields, [field.name]: next }, touched: new Set([...current.touched, field.name]) }))
            return field.type === 'boolean' ? (
              <div key={field.name} className="flex items-center gap-2.5">
                <Switch id={id} checked={value === true} onCheckedChange={(checked) => setField(checked)} />
                <label htmlFor={id} className="text-label text-foreground">
                  {field.label}
                </label>
              </div>
            ) : (
              <Field key={field.name} label={field.label} htmlFor={id} error={shown[`field:${field.name}`]} hint={field.from === 'title' ? 'Follows the title until you edit it.' : undefined}>
                <Input id={id} value={String(value)} onChange={(e) => setField(e.target.value)} className="font-mono" aria-invalid={Boolean(shown[`field:${field.name}`])} />
              </Field>
            )
          })}

          {framework ? (
            <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2.5">
              <span className="eyebrow text-soft-foreground">Stages this card will go through</span>
              <p data-slot="stage-preview" className="text-label text-foreground">
                {stages.map((s, i) => (
                  <React.Fragment key={s.id}>
                    {i > 0 ? <span className="text-soft-foreground"> → </span> : null}
                    <span data-stage={s.id} data-skipped={s.skipped || undefined} className={cn(s.skipped && 'text-soft-foreground line-through')}>
                      {s.stage.mode === 'conversation' && !form.autonomous ? '💬 ' : ''}
                      {s.name}
                      {s.stage.gate ? ' ⏸' : ''}
                    </span>
                  </React.Fragment>
                ))}
                <span className="text-soft-foreground"> → </span>🧑 Ship
              </p>
              <div className="flex flex-wrap items-center gap-3 text-label">
                <label className="inline-flex items-center gap-1.5">
                  <input type="checkbox" checked={form.skipFirst} onChange={(e) => update({ skipFirst: e.target.checked })} />
                  Skip {(() => {
                    const start = framework.stages.find((s) => s.id === form.startAt) ?? framework.stages[0]
                    return start?.name ?? start?.id ?? 'first stage'
                  })()}
                </label>
                <span className="inline-flex items-center gap-1.5">
                  Start at
                  <Select value={form.startAt || framework.stages[0]?.id} onValueChange={(value) => update({ startAt: value })}>
                    <SelectTrigger size="sm" aria-label="Start at" className="w-auto">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent position="popper">
                      {framework.stages.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name ?? s.id}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </span>
                <button type="button" aria-expanded={overridesOpen} onClick={() => setOverridesOpen((v) => !v)} className="text-primary hover:underline">
                  Per-stage model overrides {overridesOpen ? '▴' : '▾'}
                </button>
              </div>
              {overridesOpen ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  {framework.stages.map((s) => (
                    <label key={s.id} className="flex items-center gap-2 text-label">
                      <span className="w-28 shrink-0 truncate text-muted-foreground">{s.name ?? s.id}</span>
                      <Input
                        aria-label={`Model for ${s.name ?? s.id}`}
                        placeholder={s.model ?? 'default'}
                        value={form.models[s.id] ?? ''}
                        onChange={(e) => update({ models: { ...form.models, [s.id]: e.target.value } })}
                        className="h-8 font-mono"
                      />
                    </label>
                  ))}
                </div>
              ) : null}
            </div>
          ) : detail.isError ? (
            <p className="text-meta text-danger">{detail.error.message}</p>
          ) : (
            <p className="text-meta text-muted-foreground">Loading the framework…</p>
          )}

          <div className="flex items-start gap-2.5">
            <Switch id="card-autonomous" checked={form.autonomous} onCheckedChange={(checked) => update({ autonomous: checked })} />
            <label htmlFor="card-autonomous" className="text-label">
              <span className="font-medium text-foreground">Autonomous</span>
              <span className="block text-meta text-muted-foreground">Conversation stages run without you; their assumptions are shown at the next gate.</span>
            </label>
          </div>
          <div className="flex items-start gap-2.5">
            <Switch id="card-ready" checked={form.ready} onCheckedChange={(checked) => update({ ready: checked })} />
            <label htmlFor="card-ready" className="text-label">
              <span className="font-medium text-foreground">Ready for an agent</span>
              <span className="block text-meta text-muted-foreground">
                Picked up in Ready order when a slot is free
                {slots ? ` (${slots.busy}/${slots.max} busy now · ${readyAhead} ${readyAhead === 1 ? 'card' : 'cards'} ahead)` : ''}.
              </span>
            </label>
          </div>

          {createError ? (
            <p data-slot="new-card-error" role="alert" className="text-meta text-danger">
              {createError}
            </p>
          ) : null}

          <DialogFooter className="flex-wrap items-center gap-2 sm:justify-between">
            <label className="inline-flex items-center gap-1.5 text-label text-muted-foreground">
              Budget $
              <Input aria-label="Budget in dollars" inputMode="decimal" placeholder="none" value={form.budget} onChange={(e) => update({ budget: e.target.value })} className="h-8 w-24" aria-invalid={Boolean(shown.budget)} />
              {shown.budget ? <span role="alert" className="text-meta text-danger">{shown.budget}</span> : null}
            </label>
            <span className="flex flex-wrap gap-2">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="button" variant={form.ready ? 'outline' : 'primary'} disabled={create.isPending || !framework || Boolean(notOnBase)} onClick={() => submit(false)}>
                Save to Backlog
              </Button>
              <Button type="button" variant={form.ready ? 'primary' : 'outline'} disabled={create.isPending || !framework || Boolean(notOnBase)} onClick={() => submit(true)}>
                Create · Ready
              </Button>
            </span>
          </DialogFooter>
        </form>
        {installing && summary && canInstall ? (
          <InstallFrameworkDialog key={summary.id} fw={summary} thenUse={false} onInstalled={() => {}} onClose={() => setInstalling(false)} />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
