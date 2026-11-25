import { SECRET_BINDING_SCHEMES, type SecretBindingScheme } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { BINDING_PRESETS, type BindingFields, type BindingPreset } from './secrets-binding'

interface BindingFieldsProps {
  fields: BindingFields
  onChange: (next: BindingFields) => void
}

/** Hosts, header, scheme and placeholder inputs, with the three real cases as one-click presets. */
export function SecretBindingFields({ fields, onChange }: BindingFieldsProps) {
  const set = <K extends keyof BindingFields>(key: K, value: BindingFields[K]) => onChange({ ...fields, [key]: value })
  const apply = (preset: BindingPreset) => onChange({ ...fields, ...preset.fields, hosts: preset.fields.hosts || fields.hosts })
  return (
    <div className="grid gap-3 sm:grid-cols-2" data-slot="secret-binding-form">
      <div className="sm:col-span-2" data-slot="secret-binding-help">
        <p className="text-meta text-soft-foreground">Common cases — pick one to fill the header and scheme:</p>
        <ul className="mt-1 flex flex-col gap-1">
          {BINDING_PRESETS.map((preset) => (
            <li key={preset.id} className="flex flex-wrap items-center gap-2 text-meta text-muted-foreground">
              <Button type="button" variant="outline" size="sm" onClick={() => apply(preset)}>{preset.label}</Button>
              <span>{preset.help}</span>
            </li>
          ))}
        </ul>
      </div>
      <label className="block text-ui sm:col-span-2">Hosts (comma or space separated, exact, https only)
        <Input aria-label="Hosts" value={fields.hosts} onChange={(event) => set('hosts', event.target.value)}
          autoComplete="off" spellCheck={false} placeholder="api.github.com, github.com" className="mt-1 h-8 font-mono text-ui" />
      </label>
      <label className="block text-ui">Header
        <Input aria-label="Header" value={fields.header} onChange={(event) => set('header', event.target.value)}
          autoComplete="off" spellCheck={false} className="mt-1 h-8 font-mono text-ui" />
      </label>
      <div className="block text-ui">Scheme
        <Select value={fields.scheme} onValueChange={(value) => set('scheme', value as SecretBindingScheme)}>
          <SelectTrigger size="sm" aria-label="Scheme" className="mt-1 w-full"><SelectValue /></SelectTrigger>
          <SelectContent position="popper">
            {SECRET_BINDING_SCHEMES.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <label className="block text-ui sm:col-span-2">Placeholder env var (optional — what the sandbox sees instead of the value)
        <Input aria-label="Placeholder env var" value={fields.sentinel} onChange={(event) => set('sentinel', event.target.value.toUpperCase())}
          autoComplete="off" spellCheck={false} placeholder="GH_TOKEN" className="mt-1 h-8 font-mono text-ui" />
      </label>
      <p className="text-meta text-soft-foreground sm:col-span-2">Changing hosts, header or scheme means re-entering the value — it is stored sealed to its destinations.</p>
    </div>
  )
}
