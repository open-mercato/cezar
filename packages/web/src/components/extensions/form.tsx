import { useEffect, useId, useRef, useState } from 'react'
import type { ExtensionForm } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'

type Field = ExtensionForm['fields'][number]
/** Radix items cannot carry ''; an optional select's "None" uses this and maps back to empty. */
const NONE = '__cez_none__'

/** An empty optional field is omitted, never sent as 0, its first option or a blank secret over a saved one. */
function fieldValue(field: Field, raw: FormDataEntryValue | null, checked: boolean): string | number | boolean | undefined {
  if (field.type === 'boolean') return checked
  const text = raw === null ? '' : String(raw)
  if (text === '' && !field.required) return undefined
  return field.type === 'number' ? Number(text) : text
}

function draftValues(form: ExtensionForm): Record<string, string | boolean> {
  return Object.fromEntries(form.fields.map(field => [field.key, field.type === 'boolean'
    ? form.values?.[field.key] === true
    : field.type === 'password' ? '' : String(form.values?.[field.key] ?? '')]))
}

/** Only declared fields are rendered. Passwords are never prefilled by the host. */
export function ExtensionFormView({ form, submit }: { form: ExtensionForm; submit: (input: Record<string, unknown>) => Promise<ExtensionForm | void> }) {
  const id = useId()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState(() => draftValues(form))
  const [baseline, setBaseline] = useState(() => draftValues(form))
  const [conflict, setConflict] = useState(false)
  // Equivalent refetch objects do not constitute a change. Secrets never enter this snapshot.
  const revision = JSON.stringify([form.id, form.fields, draftValues(form)])
  const seen = useRef(revision)
  const latest = useRef(form)
  latest.current = form
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline)
  const reload = () => {
    const saved = draftValues(latest.current)
    setDraft(saved); setBaseline(saved); setConflict(false); setError('')
    seen.current = revision
  }
  useEffect(() => {
    if (busy || seen.current === revision) return
    seen.current = revision
    if (dirty) setConflict(true)
    else reload()
  }, [revision, busy, dirty])
  const change = (key: string, value: string | boolean) => setDraft(current => ({ ...current, [key]: value }))
  return <form className="space-y-3 rounded border p-3" aria-label={form.title} onSubmit={async event => {
    event.preventDefault()
    if (busy) return
    const input: Record<string, string | number | boolean> = {}
    for (const field of form.fields) {
      const value = fieldValue(field, String(draft[field.key] ?? ''), draft[field.key] === true)
      if (value !== undefined) input[field.key] = value
    }
    setBusy(true); setError('')
    const submittedRevision = revision
    try {
      const canonical = await submit(input)
      // Callers can return the refetched form. Also handle a refresh delivered through props
      // before save settles; otherwise retain the just-saved values, excluding passwords.
      const refreshed = JSON.stringify([latest.current.id, latest.current.fields, draftValues(latest.current)]) !== submittedRevision
      const saved = draftValues(canonical ?? (refreshed ? latest.current : { ...form, values: input }))
      setDraft(saved); setBaseline(saved); setConflict(false)
      seen.current = JSON.stringify([latest.current.id, latest.current.fields, draftValues(latest.current)])
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save') } finally { setBusy(false) }
  }}>
    <h3>{form.title}</h3>
    {form.fields.map(field => {
      const fieldId = `${id}-${field.key}`
      if (field.type === 'boolean') return <div key={field.key} className="flex items-center gap-2">
        <Switch id={fieldId} disabled={busy} checked={draft[field.key] === true} onCheckedChange={checked => change(field.key, checked)} />
        <label htmlFor={fieldId}>{field.label}</label>
      </div>
      return <div key={field.key} className="flex flex-col gap-1">
        <label htmlFor={fieldId}>{field.label}</label>
        {field.type === 'select'
          ? <Select name={field.key} required={field.required} disabled={busy} value={String(draft[field.key] ?? '') || (field.required ? '' : NONE)} onValueChange={value => change(field.key, value === NONE ? '' : value)}>
            <SelectTrigger id={fieldId} data-slot="extension-form-select" data-value={String(draft[field.key] ?? '')} className="w-full"><SelectValue placeholder="Choose…" /></SelectTrigger>
            <SelectContent position="popper">
              {!field.required && <SelectItem value={NONE}>None</SelectItem>}
              {field.options?.map(value => <SelectItem key={value} value={value}>{value}</SelectItem>)}
            </SelectContent>
          </Select>
          : <Input id={fieldId} name={field.key} required={field.required} type={field.type} aria-describedby={field.type === 'password' && !field.required ? `${fieldId}-hint` : undefined}
            disabled={busy} value={String(draft[field.key] ?? '')} onChange={event => change(field.key, event.target.value)} />}
        {field.type === 'password' && !field.required && <span id={`${fieldId}-hint`} className="text-ui text-muted-foreground">Leave blank to keep the saved value.</span>}
      </div>
    })}
    {conflict && <div role="alert" className="text-sm">
      Saved values changed. Your draft has been kept; saving will overwrite those values.
      <Button type="button" variant="outline" disabled={busy} onClick={reload}>Reload saved values</Button>
    </div>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    <Button type="submit" disabled={busy}>Save {form.title}</Button>
  </form>
}
