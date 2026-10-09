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
import type { Accent, Density, Width } from '@/lib/appearance'
import type { Theme } from '@/lib/theme'
import { useProjectOrder } from '@/lib/use-project-order'
import { toast } from '@/components/ui/toaster'

/**
 * Settings → Appearance (R6 Step 1.3, spec §"Settings").
 *
 * Each knob is honest about where it persists:
 *  - THEME rides the existing theme system (localStorage `cez-theme`, shared with the legacy
 *    cockpit and the pre-paint script) — per-browser by design, like every OS theme choice;
 *  - ACCENT + DENSITY persist in `ui-state.json` through the AppearanceProvider (additive
 *    `appearance` key), mirrored to localStorage for pre-paint;
 *  - PROJECT ORDER (#952) lives in the same workspace file under `sidebar.projectOrder`, so this
 *    section only offers the reset — the order itself is set by dragging the drawer.
 *
 * Every control is a real one: accent swaps the `--primary` token family, density shrinks
 * the Tailwind spacing token (see index.css). No dead knobs.
 */

const THEME_OPTIONS: Array<{ value: Theme; label: string; icon: ComponentType<SVGProps<SVGSVGElement>> }> = [
  { value: 'system', label: 'System', icon: MonitorIcon },
  { value: 'light', label: 'Light', icon: SunIcon },
  { value: 'dark', label: 'Dark', icon: MoonIcon },
]

/** Swatches point at the STABLE family tokens (`--accent-lime`, `--violet`), not `--primary` —
 *  the whole point of the control is that `--primary` changes under it. */
const ACCENT_OPTIONS: Array<{ value: Accent; label: string; swatch: string }> = [
  { value: 'lime', label: 'Lime', swatch: 'var(--accent-lime)' },
  { value: 'violet', label: 'Violet', swatch: 'var(--violet)' },
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

/** One segmented radio group — the shared chassis of all three controls. */
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
  options: Array<{ value: V; label: string; icon?: ComponentType<SVGProps<SVGSVGElement>>; swatch?: string }>
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
              'flex items-center gap-2 rounded-sm px-3 py-1.5 text-[13px] font-medium transition-colors',
              checked
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {option.icon ? <option.icon aria-hidden="true" className="size-3.5" /> : null}
            {option.swatch ? (
              <span
                aria-hidden="true"
                className="size-3 rounded-full border border-border"
                style={{ background: option.swatch }}
              />
            ) : null}
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

function Field({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div>
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <p className="text-[13px] text-muted-foreground">{hint}</p>
      </div>
      {children}
    </section>
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
  )
}

function BrandingFields() {
  const config = useWorkspaceConfig()
  const queryClient = useQueryClient()
  const logoInput = useRef<HTMLInputElement>(null)
  const [logoDraft, setLogoDraft] = useState<{ file: File; url: string } | null>(null)
  useEffect(() => () => { if (logoDraft) URL.revokeObjectURL(logoDraft.url) }, [logoDraft])
  const save = useMutation({
    mutationFn: (patch: SetWorkspaceConfigInput) => putWorkspaceConfig(patch),
    onSuccess: (result) => queryClient.setQueryData(workspaceQueryKeys.config, result),
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
  return <>
    <Field title="Instance name" hint="Shown in the sidebar and browser tab across this workspace.">
      <div className="flex flex-wrap items-center gap-2">
        <input data-slot="branding-name" aria-label="Instance name" maxLength={80} value={name} onChange={(event) => setName(event.currentTarget.value)}
          onBlur={() => {
            const value = name.trim()
            if (!value) { setName(branding?.name ?? 'cezar'); return }
            if (value !== branding?.name) save.mutate({ branding: { name: value } })
            setLastName(value)
          }}
          className="h-9 w-64 rounded-md border border-border bg-background px-3 text-sm" />
        <Button type="button" variant="outline" size="sm" disabled={!branding || branding.name === 'cezar' || save.isPending}
          onClick={() => save.mutate({ branding: { name: null } })}>Reset name</Button>
      </div>
    </Field>
    <Field title="Logo" hint="PNG, JPEG, WebP, GIF, AVIF, or safe SVG up to 2 MB. Stored on this machine and shared by its browsers.">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-3">
        {logoDraft ? <img src={logoDraft.url} alt="Logo preview" className="size-10 rounded-md border border-border bg-background object-contain p-1" /> : branding?.logoUrl ? <img src={branding.logoUrl} alt="Current instance logo" className="size-10 rounded-md border border-border bg-background object-contain p-1" /> : <span aria-hidden="true" className="size-10 rounded-md border border-dashed border-border bg-background" />}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{logoDraft?.file.name ?? (branding?.logoUrl ? 'Current logo' : 'No logo selected')}</p>
          <p className="text-xs text-muted-foreground">Choose an image to preview it before saving.</p>
        </div>
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
          <Button type="button" variant="outline" size="sm" disabled={upload.isPending} onClick={() => setLogoDraft(null)}>Cancel</Button>
        </> : branding?.logoUrl ? <Button type="button" variant="outline" size="sm" disabled={upload.isPending} onClick={() => upload.mutate(null)}>Remove logo</Button> : null}
      </div>
    </Field>
  </>
}

export function AppearanceSection() {
  const { theme, setTheme } = useTheme()
  const { accent, density, width, setAccent, setDensity, setWidth } = useAppearance()

  return (
    <div
      data-slot="appearance-section"
      className="mx-auto flex w-full max-w-2xl flex-col gap-7 p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-6 md:pb-6"
    >
      <BrandingFields />
      <Field title="Theme" hint="System follows your OS preference. Applies to this browser.">
        <Segmented slot="appearance-theme" label="Theme" value={theme} options={THEME_OPTIONS} onChange={setTheme} />
      </Field>

      <Field title="Accent" hint="The primary action color. Saved with this repo's cockpit state.">
        <Segmented slot="appearance-accent" label="Accent" value={accent} options={ACCENT_OPTIONS} onChange={setAccent} />
      </Field>

      <Field
        title="Density"
        hint="Compact tightens spacing across the cockpit — text stays the same size."
      >
        <Segmented slot="appearance-density" label="Density" value={density} options={DENSITY_OPTIONS} onChange={setDensity} />
      </Field>

      <Field
        title="Reading width"
        hint="Full uses the available task area. Narrow keeps a comfortable reading column. The Changes tab is always full-width."
      >
        <Segmented slot="appearance-width" label="Reading width" value={width} options={WIDTH_OPTIONS} onChange={setWidth} />
      </Field>

      <ProjectOrderField />
    </div>
  )
}
