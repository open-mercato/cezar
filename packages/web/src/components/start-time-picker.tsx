import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Clock3Icon } from 'lucide-react'
import type { CreateRunInput, DeferredOptions, DeferredPreview, StartCondition } from '@open-mercato/cezar-api-client'
import { getDeferredStartOptions, previewDeferredStart } from '@/api/client'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export type StartChoice = { start: StartCondition; preview?: Extract<DeferredPreview, { available: true }>; taskJson?: string; invalidated?: string }
type AtStart = Extract<StartCondition, { kind: 'at' }>

/** Debounce before a complete date/time previews itself (#1340). */
export const AUTO_PREVIEW_MS = 600
const pad = (n: number) => String(n).padStart(2, '0')

/** The trigger's text: the chosen start in the server zone, authoritative once previewed. */
export function startLabel(value: StartChoice | null, ready?: StartChoice['preview']): string {
  if (!value) return 'Now'
  const instant = ready && new Date(ready.notBefore).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: ready.timeZone }).replace(',', '')
  if (value.start.kind === 'usage-reset') return instant ? `After reset · ${instant} · ${ready!.timeZone}` : 'After reset'
  if (ready) return `Starts ${instant} · ${ready.timeZone}`
  if (!validDate(value.start.date)) return 'Pick a date'
  if (!validTime(value.start)) return 'Pick a time'
  // The fields are a server-zone wall time already; format the date alone so no zone shifts it.
  const day = new Date(`${value.start.date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).replace(',', '')
  return `Starts ${day} ${pad(value.start.hour)}:${pad(value.start.minute)}`
}

function validDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  const parsed = new Date(`${date}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date
}
// Incomplete time fields use -1 in the draft; validation keeps them off the wire.
function validTime(start: AtStart): boolean {
  return Number.isInteger(start.hour) && start.hour >= 0 && start.hour < 24
    && Number.isInteger(start.minute) && start.minute >= 0 && start.minute < 60
}
function dateErrors(start: AtStart): { date?: string; time?: string } {
  if (!validDate(start.date)) return { date: start.date ? 'Enter a complete, valid date.' : 'Pick a date to schedule this task.' }
  if (!validTime(start)) return { time: 'Enter a complete time.' }
  // Reject only times already past in every zone; the server checks its own zone.
  const at = Date.parse(`${start.date}T${pad(start.hour)}:${pad(start.minute)}:00Z`)
  if (at + 12 * 3_600_000 <= Date.now()) return { date: 'Choose a future date and time.' }
  return {}
}

export function StartTimePicker({ task, value, onChange, disabledReason, onBlockedChange }: {
  task: CreateRunInput; value: StartChoice | null; onChange: (value: StartChoice | null) => void; disabledReason?: string
  /** Why Schedule task cannot submit yet, for the line beside the button; undefined when it can. */
  onBlockedChange?: (reason: string | undefined) => void
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [retry, setRetry] = useState(false)
  const [touched, setTouched] = useState(false)
  const [options, setOptions] = useState<{ key: string; data: DeferredOptions }>()
  const [optionsError, setOptionsError] = useState('')
  const [optionsAttempt, setOptionsAttempt] = useState(0)
  const [timeError, setTimeError] = useState(false)
  const errors = value?.start.kind === 'at' ? dateErrors(value.start) : {}
  const fieldMessage = errors.date ?? errors.time
  const generation = useRef(0)
  const autoTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const lastAt = useRef<AtStart | null>(null)
  if (value?.start.kind === 'at') lastAt.current = value.start
  const groupName = useId()
  const errorId = useId()
  const eligibilityId = useId()
  const taskJson = JSON.stringify(task)
  // Eligibility depends on execution settings, never the wording of the prompt.
  const optionsKey = JSON.stringify({ ...task, task: 'Check scheduling options' })
  const currentOptions = options?.key === optionsKey ? options.data : undefined
  const resetReason = disabledReason ?? (optionsError || (currentOptions
    ? currentOptions.usageReset.available ? undefined : currentOptions.usageReset.message
    : 'Checking scheduling options…'))
  const needsResetOptions = value?.start.kind === 'usage-reset'
  useEffect(() => {
    if (!open && !needsResetOptions) return
    let cancelled = false
    setOptionsError('')
    getDeferredStartOptions({ task: JSON.parse(optionsKey) }).then(data => {
      if (!cancelled) setOptions({ key: optionsKey, data })
    }).catch(() => {
      if (!cancelled) setOptionsError('Could not load scheduling options. Try again.')
    })
    return () => { cancelled = true }
  }, [open, optionsKey, optionsAttempt, needsResetOptions])
  const choiceJson = JSON.stringify(value?.start)
  useLayoutEffect(() => {
    generation.current++
    setBusy(false)
    setMessage(value?.invalidated ?? '')
    setRetry(!!value?.invalidated)
    setTimeError(false)
    // Invalidate permanently: changing settings back must not resurrect an old check.
    if (value?.preview && (value.taskJson !== taskJson || disabledReason)) {
      onChange({ start: value.start })
    }
    return () => { generation.current++ }
  }, [taskJson, choiceJson, disabledReason, value?.invalidated])

  useLayoutEffect(() => {
    if (value?.start.kind !== 'usage-reset' || !resetReason) return
    generation.current++
    setBusy(false)
    if (value.preview) onChange({ start: value.start })
  }, [resetReason, value?.start.kind])

  const check = async () => {
    clearTimeout(autoTimer.current)
    if (!value || disabledReason || (value.start.kind === 'usage-reset' && resetReason) || fieldMessage || !task.task.trim()) return
    const version = ++generation.current
    onChange({ start: value.start, invalidated: value.invalidated })
    setBusy(true); setMessage(''); setRetry(false); setTimeError(false)
    try {
      const preview = await previewDeferredStart({ task, start: value.start })
      if (version !== generation.current) return
      if (preview.available) onChange({ start: value.start, preview, taskJson })
      else { setMessage(preview.message); setTimeError(preview.reason === 'window-over'); setRetry(preview.reason === 'account-unverifiable') }
    } catch (error) {
      if (version === generation.current) {
        setMessage(value.start.kind === 'at' ? 'Could not check the start time. Try again.' : error instanceof Error ? error.message : String(error))
        setRetry(true)
      }
    }
    finally { if (version === generation.current) setBusy(false) }
  }
  // A complete date/time checks itself; usage resets stay explicit (they read provider state).
  useEffect(() => {
    if (value?.start.kind !== 'at' || disabledReason || !task.task.trim() || fieldMessage) return
    if (value.preview && value.taskJson === taskJson) return
    autoTimer.current = setTimeout(() => void check(), AUTO_PREVIEW_MS)
    return () => clearTimeout(autoTimer.current)
  }, [taskJson, choiceJson, disabledReason])

  // Timers are capped for distant dates; closing the popover must not stop expiry.
  useEffect(() => {
    if (!value?.preview) return
    let timer: ReturnType<typeof setTimeout>
    const expire = () => {
      const remaining = Date.parse(value.preview!.notBefore) - Date.now()
      if (remaining > 0) timer = setTimeout(expire, Math.min(remaining, 2_147_483_647))
      else onChange({ start: value.start, invalidated: 'The previewed start time has passed. Check the start time again.' })
    }
    expire()
    return () => clearTimeout(timer)
  }, [value?.preview])

  const ready = !(value?.start.kind === 'usage-reset' && resetReason) && !busy && !fieldMessage && !disabledReason && value?.taskJson === taskJson && value.preview && Date.parse(value.preview.notBefore) > Date.now() ? value.preview : undefined
  const blocked = !value || ready ? undefined
    : disabledReason ?? (value.start.kind === 'usage-reset' && resetReason ? resetReason : busy ? 'Checking the start time…'
      : message ? message
        : fieldMessage ? fieldMessage
          : !task.task.trim() ? 'Describe the task to schedule it.'
            : value.start.kind === 'at' ? 'Checking the start time…' : 'Check the start time to schedule this task.')
  useEffect(() => { onBlockedChange?.(blocked) }, [blocked])
  const visibleFieldMessage = touched ? fieldMessage : undefined
  const describedBy = message || fieldMessage ? errorId : undefined
  const label = startLabel(value, ready)
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild><Button type="button" variant="ghost" size="sm" className="h-auto min-h-[30px] min-w-0 max-w-full whitespace-normal py-1 text-left" aria-label="Choose task start time" title={ready ? label : undefined}><Clock3Icon className="size-4" /><span className="min-w-0 break-words">{label}</span></Button></PopoverTrigger>
    <PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)] max-h-(--radix-popover-content-available-height) overflow-y-auto overscroll-contain space-y-3">
      <fieldset className="space-y-3">
      <legend className="font-medium">Start task</legend>
      <label className="flex items-center gap-2"><input type="radio" name={groupName} aria-describedby={describedBy} checked={!value} onChange={() => onChange(null)} />Now</label>
      <label className="flex items-center gap-2"><input type="radio" name={groupName} aria-describedby={describedBy} disabled={!!disabledReason} checked={value?.start.kind === 'at'} onChange={() => onChange({ start: lastAt.current ?? { kind: 'at', date: '', hour: 9, minute: 0 } })} />Pick date &amp; time</label>
      <label className="flex items-center gap-2"><input type="radio" name={groupName} aria-describedby={resetReason ? eligibilityId : describedBy} disabled={!!resetReason} checked={value?.start.kind === 'usage-reset'} onChange={() => onChange({ start: { kind: 'usage-reset' } })} />After usage limit resets</label>
      </fieldset>
      {resetReason && !disabledReason && <p id={eligibilityId} className="text-sm text-muted-foreground">{resetReason}</p>}
      {optionsError && <Button type="button" variant="outline" onClick={() => setOptionsAttempt(n => n + 1)}>Retry options</Button>}
      {disabledReason && <p id={eligibilityId} role="status" className="text-sm text-muted-foreground">{disabledReason}</p>}
      {value?.start.kind === 'at' && <div className="space-y-2">
        <p className="text-sm text-muted-foreground">{currentOptions ? `Server time zone: ${currentOptions.timeZone}` : 'Loading server time zone…'}</p>
        <label className="block text-sm">Date<Input aria-describedby={describedBy} onBlur={() => setTouched(true)} aria-invalid={(touched && errors.date) || timeError ? true : undefined} type="date" max="9999-12-31" value={value.start.date} onChange={e => onChange({ start: { ...value.start as AtStart, date: e.target.value } })} /></label>
        <label className="block text-sm">Time (server time zone)<Input aria-describedby={describedBy} onBlur={() => setTouched(true)} aria-invalid={(touched && errors.time) || timeError ? true : undefined} type="time" value={validTime(value.start) ? `${pad(value.start.hour)}:${pad(value.start.minute)}` : ''} onChange={e => { const [hour, minute] = e.target.value ? e.target.value.split(':').map(Number) : [-1, -1]; onChange({ start: { ...value.start as AtStart, hour: hour ?? -1, minute: minute ?? -1 } }) }} /></label>
      </div>}
      {value && !disabledReason && <>
        {value.start.kind === 'usage-reset' && currentOptions?.usageReset.available && <p className="text-sm text-muted-foreground">{currentOptions.usageReset.provider === 'claude'
          ? 'Claude reset times come from tasks run in Cezar. Checking reloads saved observations; it never starts a model.'
          : 'Checking reads usage data from Codex without starting a model.'}</p>}
        {value.start.kind === 'usage-reset' && !resetReason && <Button type="button" variant="outline" disabled={busy || !task.task.trim()} onClick={() => void check()}>{busy ? 'Checking…' : ready ? 'Refresh preview' : 'Check start time'}</Button>}
        {value.start.kind === 'at' && retry && <Button type="button" variant="outline" disabled={busy || !!fieldMessage || !task.task.trim()} onClick={() => void check()}>Retry</Button>}
        {value.start.kind === 'at' && !ready && !message && !fieldMessage && <p role="status" className="text-sm text-muted-foreground">{blocked}</p>}
        {ready && <div role="status" className="space-y-1 text-sm"><p>Earliest start: {new Date(ready.notBefore).toLocaleString('en-GB', { timeZone: ready.timeZone })} · {ready.timeZone}</p>{ready.observation && <p>{ready.observation}</p>}<p className="text-muted-foreground">The server must be running. Scheduling does not reserve allowance; account holds and queue limits still apply.</p></div>}
      </>}
      {!touched && fieldMessage && !message && <p id={errorId} className="text-sm text-muted-foreground">{fieldMessage}</p>}
      {(message || visibleFieldMessage) && <p id={errorId} role="alert" className="text-sm text-destructive">{message || visibleFieldMessage}</p>}
    </PopoverContent>
  </Popover>
}
