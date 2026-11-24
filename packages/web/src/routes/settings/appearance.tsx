import { MonitorIcon, MoonIcon, SunIcon, UploadIcon } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import type { ComponentType, ReactNode, SVGProps } from 'react'

import { useProjects, useWorkspaceConfig, workspaceQueryKeys } from '@/api/queries'
import type { WorkspaceConfigResponse } from '@open-mercato/cezar-api-client'
import { deleteWorkspaceBrandingLogo, putWorkspaceConfig, uploadWorkspaceBrandingLogo } from '@/api/client'
import type { SetWorkspaceConfigInput } from '@open-mercato/cezar-api-client'
import { useAppearance } from '@/components/appearance-provider'
import { useTheme } from '@/components/theme-provider'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { Density, Width } from '@/lib/appearance'
import type { Theme } from '@/lib/theme'
import { useProjectOrder } from '@/lib/use-project-order'
import { useLiveUsageEnabled, writeLiveUsageEnabled } from '@/lib/live-usage-pref'
import { toast } from '@/components/ui/toaster'
import { FormRow, SettingsCard, isCommitKey, useSavedFlash } from './form-row'

/**
 * Settings → Appearance (R6 Step 1.3, spec §"Settings").
 *
 * Each knob is honest about where it persists:
 *  - THEME rides the existing theme system (localStorage `cez-theme`, shared with the legacy
 *    cockpit and the pre-paint script) — per-browser by design, like every OS theme choice;
 *  - DENSITY + READING WIDTH persist in `ui-state.json` through the AppearanceProvider (additive
 *    `appearance` key), mirrored to localStorage for pre-paint;
 *  - PROJECT ORDER (#952) lives in the same workspace file under `sidebar.projectOrder`, so this
 *    section only offers the reset — the order itself is set by dragging the drawer.
 *
 * Every control is a real one: density shrinks the Tailwind spacing token, reading width flips
 * `--measure` (see index.css). No dead knobs — which is why the accent picker went with "Violet
 * only" (redesign 2026-11): one accent is a fact, not a choice.
 */

const THEME_OPTIONS: Array<{ value: Theme; label: string; icon: ComponentType<SVGProps<SVGSVGElement>> }> = [
  { value: 'system', label: 'System', icon: MonitorIcon },
  { value: 'light', label: 'Light', icon: SunIcon },
  { value: 'dark', label: 'Dark', icon: MoonIcon },
]

const DENSITY_OPTIONS: Array<{ value: Density; label: string }> = [
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'compact', label: 'Compact' },
  { value: 'ultra', label: 'Compact for real' },
]

const WIDTH_OPTIONS: Array<{ value: Width; label: string }> = [
  { value: 'narrow', label: 'Narrow' },
  { value: 'wide', label: 'Full' },
]

/** One segmented radio group — the shared chassis of every control below. */
function Segmented<V extends string>({
  slot,
  label,
  value,
  options,
  onChange,
}: {
  slot: string
  label: string
  value: V
  options: Array<{ value: V; label: string; icon?: ComponentType<SVGProps<SVGSVGElement>> }>
  onChange: (value: V) => void
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      data-slot={slot}
      className="inline-flex w-fit gap-0.5 rounded-md border border-border bg-card p-0.5"
    >
      {options.map((option) => {
        const checked = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            data-value={option.value}
            onClick={() => onChange(option.value)}
            className={cn(
              'flex items-center gap-2 rounded-sm px-3 py-1.5 text-ui font-medium transition-colors',
              checked
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {option.icon ? <option.icon aria-hidden="true" className="size-3.5" /> : null}
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

/** One row of the shared form grammar — label + hint left, control right (form-row.tsx). */
function Field({ title, hint, saved = false, children }: { title: string; hint: string; saved?: boolean; children: ReactNode }) {
  return (
    <FormRow label={title} description={hint} saved={saved}>
      {children}
    </FormRow>
  )
}

/**
 * The undo for a drawer reordered by hand (#952) — the drag itself lives in the sidebar, where
 * it belongs, but "put it back" needs a home that is not a gesture.
 *
 * Absent entirely until there is both more than one project and an order to forget: a reset
 * button for state the user has never created is a control that can only do nothing.
 */
function ProjectOrderField() {
  const projects = useProjects()
  const { order, canReorder, reset } = useProjectOrder()
  const multiProject = (projects.data?.projects.length ?? 0) > 1
  if (!multiProject || order.length === 0) return null

  return (
    <SettingsCard id="sidebar" title="Sidebar">
      <Field
        title="Project order"
        hint="The sidebar is in the order you dragged it into. Reset puts it back to most-recently-opened first. Shared with every browser signed in to this cezar."
      >
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-slot="appearance-project-order-reset"
          disabled={!canReorder}
          onClick={reset}
          className="w-fit"
        >
          Reset order
        </Button>
      </Field>
    </SettingsCard>
  )
}

function BrandingFields() {
  const config = useWorkspaceConfig()
  const queryClient = useQueryClient()
  const logoInput = useRef<HTMLInputElement>(null)
  const [logoDraft, setLogoDraft] = useState<{ file: File; url: string } | null>(null)
  const [nameSaved, flashName] = useSavedFlash()
  const [logoSaved, flashLogo] = useSavedFlash()
  useEffect(() => () => { if (logoDraft) URL.revokeObjectURL(logoDraft.url) }, [logoDraft])
  const save = useMutation({
    mutationFn: (patch: SetWorkspaceConfigInput) => putWorkspaceConfig(patch),
    onSuccess: (result) => {
      queryClient.setQueryData(workspaceQueryKeys.config, result)
      flashName()
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  const upload = useMutation({
    mutationFn: async (file: File | null) => {
      return file ? uploadWorkspaceBrandingLogo(file) : deleteWorkspaceBrandingLogo()
    },
    onSuccess: (logoUrl) => {
      const current = queryClient.getQueryData<WorkspaceConfigResponse>(workspaceQueryKeys.config)
      if (current) queryClient.setQueryData(workspaceQueryKeys.config, { ...current, branding: { ...current.branding, logoUrl } })
      setLogoDraft(null)
      flashLogo()
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  const branding = config.data?.branding
  const [name, setName] = useState(branding?.name ?? 'cezar')
  const [lastName, setLastName] = useState(branding?.name ?? 'cezar')
  useEffect(() => {
    if (branding && name === lastName) {
      setName(branding.name)
      setLastName(branding.name)
    }
  }, [branding?.name])
  const commitName = () => {
    const value = name.trim()
    if (!value) { setName(branding?.name ?? 'cezar'); return }
    if (value !== branding?.name) save.mutate({ branding: { name: value } })
    setLastName(value)
  }
  return <SettingsCard id="instance" title="Instance">
    <Field title="Instance name" hint="Shown in the sidebar and browser tab across this workspace." saved={nameSaved}>
      <div className="flex flex-col items-end gap-1">
        <input data-slot="branding-name" aria-label="Instance name" maxLength={80} value={name} onChange={(event) => setName(event.currentTarget.value)}
          onBlur={commitName}
          onKeyDown={(event) => { if (isCommitKey(event)) { event.preventDefault(); commitName() } }}
          className="h-8 w-56 rounded-md border border-input bg-card px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50" />
        {branding && branding.name !== 'cezar' ? (
          <button type="button" data-action="branding-name-reset" disabled={save.isPending}
            onClick={() => save.mutate({ branding: { name: null } })}
            className="text-meta text-muted-foreground underline-offset-4 hover:text-foreground hover:underline disabled:opacity-50">
            Use the default name
          </button>
        ) : null}
      </div>
    </Field>
    <Field title="Logo" hint="PNG, JPEG, WebP, GIF, AVIF, or safe SVG up to 2 MB. Stored on this machine and shared by its browsers. Choose an image to preview it before saving." saved={logoSaved}>
      <div className="flex flex-wrap items-center gap-2">
        {logoDraft ? <img src={logoDraft.url} alt="Logo preview" className="size-9 rounded-md border border-border bg-background object-contain p-1" /> : branding?.logoUrl ? <img src={branding.logoUrl} alt="Current instance logo" className="size-9 rounded-md border border-border bg-background object-contain p-1" /> : <span aria-hidden="true" className="size-9 rounded-md border border-dashed border-border bg-background" />}
        <span className="max-w-40 truncate text-meta text-muted-foreground">{logoDraft?.file.name ?? (branding?.logoUrl ? 'Current logo' : 'No logo')}</span>
        <input ref={logoInput} data-slot="branding-logo" aria-label="Upload logo" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/svg+xml" disabled={upload.isPending} hidden
          onChange={(event) => {
            const file = event.currentTarget.files?.[0]
            if (file) setLogoDraft({ file, url: URL.createObjectURL(file) })
            event.currentTarget.value = ''
          }} />
        <Button type="button" variant="outline" size="sm" disabled={!branding || upload.isPending} onClick={() => logoInput.current?.click()}>
          <UploadIcon aria-hidden="true" className="size-3.5" />
          Choose logo
        </Button>
        {logoDraft ? <>
          <Button type="button" size="sm" disabled={upload.isPending} onClick={() => upload.mutate(logoDraft.file)}>Save logo</Button>
          <Button type="button" variant="ghost" size="sm" disabled={upload.isPending} onClick={() => setLogoDraft(null)}>Cancel</Button>
        </> : branding?.logoUrl ? <Button type="button" variant="ghost" size="sm" disabled={upload.isPending} onClick={() => upload.mutate(null)}>Remove logo</Button> : null}
      </div>
    </Field>
  </SettingsCard>
}

export function AppearanceSection() {
  const { theme, setTheme } = useTheme()
  const { density, width, setDensity, setWidth } = useAppearance()
  const liveUsage = useLiveUsageEnabled()

  return (
    <div
      data-slot="appearance-section"
      className="flex w-full flex-col gap-5"
    >
      <BrandingFields />
      <SettingsCard id="display" title="Display">
      <Field title="Theme" hint="System follows your OS preference. Applies to this browser.">
        <Segmented slot="appearance-theme" label="Theme" value={theme} options={THEME_OPTIONS} onChange={setTheme} />
      </Field>

      <Field
        title="Density"
        hint="Compact tightens spacing across the cockpit — text stays the same size."
      >
        <Segmented slot="appearance-density" label="Density" value={density} options={DENSITY_OPTIONS} onChange={setDensity} />
      </Field>

      <Field
        title="Reading width"
        hint="Full gives task sessions, commits, and skill content the whole available area. Narrow keeps a comfortable reading column. The Changes tab is always full-width."
      >
        <Segmented slot="appearance-width" label="Reading width" value={width} options={WIDTH_OPTIONS} onChange={setWidth} />
      </Field>

      <Field
        title="Usage gauges"
        hint="Claude account, plan limits left (5h, 7d) and context fill in the task header. Applies to this browser."
      >
        <Segmented
          slot="appearance-live-usage"
          label="Usage gauges"
          value={liveUsage ? 'on' : 'off'}
          options={[
            { value: 'on', label: 'Show' },
            { value: 'off', label: 'Hide' },
          ]}
          onChange={(value) => writeLiveUsageEnabled(value === 'on')}
        />
      </Field>
      </SettingsCard>

      <ProjectOrderField />
    </div>
  )
}
