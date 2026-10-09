import { CheckIcon, ImageIcon, UploadIcon } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { useProjects, useWorkspaceConfig, workspaceQueryKeys } from '@/api/queries'
import type { WorkspaceConfigResponse } from '@open-mercato/cezar-api-client'
import { deleteWorkspaceBrandingLogo, putWorkspaceConfig, uploadWorkspaceBrandingLogo } from '@/api/client'
import type { SetWorkspaceConfigInput } from '@open-mercato/cezar-api-client'
import { useAppearance } from '@/components/appearance-provider'
import { useTheme } from '@/components/theme-provider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'
import type { Accent, Density, Width } from '@/lib/appearance'
import type { Theme } from '@/lib/theme'
import { useProjectOrder } from '@/lib/use-project-order'
import { toast } from '@/components/ui/toaster'
import { SettingsField, SettingsGroup, SettingsPane } from './settings-field'

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

/** A miniature cockpit: sidebar, a title line, two rows and the accent CTA. Fixed neutral
 *  palette on purpose — a preview of "dark" must stay dark while the app is light. */
function WindowPreview({ tone, className }: { tone: 'light' | 'dark'; className?: string }) {
  const dark = tone === 'dark'
  return (
    <span
      aria-hidden="true"
      className={cn('flex h-full w-full gap-1 p-1.5', dark ? 'bg-zinc-950' : 'bg-zinc-100', className)}
    >
      <span className="flex w-1/4 flex-col gap-1 pt-0.5">
        <span className={cn('h-1 w-3/4 rounded-full', dark ? 'bg-zinc-700' : 'bg-zinc-300')} />
        <span className={cn('h-1 w-full rounded-full', dark ? 'bg-zinc-800' : 'bg-zinc-200')} />
        <span className={cn('h-1 w-2/3 rounded-full', dark ? 'bg-zinc-800' : 'bg-zinc-200')} />
      </span>
      <span className={cn('flex flex-1 flex-col gap-1 rounded-sm p-1.5', dark ? 'bg-zinc-900' : 'bg-white')}>
        <span className={cn('h-1.5 w-1/2 rounded-full', dark ? 'bg-zinc-200' : 'bg-zinc-800')} />
        <span className={cn('h-1 w-full rounded-full', dark ? 'bg-zinc-700' : 'bg-zinc-200')} />
        <span className={cn('h-1 w-4/5 rounded-full', dark ? 'bg-zinc-700' : 'bg-zinc-200')} />
        <span className="mt-auto h-2 w-6 self-end rounded-full" style={{ background: 'var(--accent-lime)' }} />
      </span>
    </span>
  )
}

const THEME_OPTIONS: Array<ChoiceOption<Theme>> = [
  {
    value: 'system',
    label: 'System',
    preview: (
      <span aria-hidden="true" className="flex h-full w-full">
        <WindowPreview tone="light" className="w-1/2 overflow-hidden" />
        <WindowPreview tone="dark" className="w-1/2 overflow-hidden" />
      </span>
    ),
  },
  { value: 'light', label: 'Light', preview: <WindowPreview tone="light" /> },
  { value: 'dark', label: 'Dark', preview: <WindowPreview tone="dark" /> },
]

/** Swatches point at the STABLE family tokens (`--accent-lime`, `--violet`), not `--primary` —
 *  the whole point of the control is that `--primary` changes under it. */
function AccentPreview({ swatch }: { swatch: string }) {
  return (
    <span aria-hidden="true" className="flex h-full w-full items-center justify-center gap-2 bg-muted">
      <span className="size-6 rounded-full shadow-xs" style={{ background: swatch }} />
      <span className="h-5 w-12 rounded-md shadow-xs" style={{ background: swatch }} />
    </span>
  )
}

const ACCENT_OPTIONS: Array<ChoiceOption<Accent>> = [
  { value: 'lime', label: 'Lime', preview: <AccentPreview swatch="var(--accent-lime)" /> },
  { value: 'violet', label: 'Violet', preview: <AccentPreview swatch="var(--violet)" /> },
]

/** Three list rows at the spacing the option stands for. */
function DensityPreview({ gap, rows }: { gap: string; rows: number }) {
  return (
    <span aria-hidden="true" className={cn('flex h-full w-full flex-col justify-center bg-muted px-3', gap)}>
      {Array.from({ length: rows }, (_, index) => (
        <span key={index} className="flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-soft-foreground" />
          <span className="h-1 flex-1 rounded-full bg-soft-foreground/40" style={{ maxWidth: `${90 - index * 12}%` }} />
        </span>
      ))}
    </span>
  )
}

const DENSITY_OPTIONS: Array<ChoiceOption<Density>> = [
  { value: 'comfortable', label: 'Comfortable', preview: <DensityPreview gap="gap-2.5" rows={3} /> },
  { value: 'compact', label: 'Compact', preview: <DensityPreview gap="gap-1.5" rows={4} /> },
  { value: 'ultra', label: 'Compact for real', preview: <DensityPreview gap="gap-1" rows={5} /> },
]

/** A page with a reading column of the option's measure. */
function WidthPreview({ measure }: { measure: string }) {
  return (
    <span aria-hidden="true" className="flex h-full w-full justify-center bg-muted py-2">
      <span className={cn('flex flex-col gap-1 rounded-sm bg-card p-1.5 shadow-xs', measure)}>
        <span className="h-1 w-2/3 rounded-full bg-soft-foreground" />
        <span className="h-1 w-full rounded-full bg-soft-foreground/40" />
        <span className="h-1 w-full rounded-full bg-soft-foreground/40" />
        <span className="h-1 w-3/4 rounded-full bg-soft-foreground/40" />
      </span>
    </span>
  )
}

const WIDTH_OPTIONS: Array<ChoiceOption<Width>> = [
  { value: 'narrow', label: 'Narrow', preview: <WidthPreview measure="w-1/2" /> },
  { value: 'wide', label: 'Wide', preview: <WidthPreview measure="w-5/6" /> },
]

interface ChoiceOption<V extends string> {
  value: V
  label: string
  preview: ReactNode
}

/** Visual radio cards — a ToggleGroup in single mode, which is a real radiogroup. */
function ChoiceCards<V extends string>({
  slot,
  label,
  value,
  options,
  onChange,
}: {
  slot: string
  label: string
  value: V
  options: Array<ChoiceOption<V>>
  onChange: (value: V) => void
}) {
  return (
    <ToggleGroup
      type="single"
      aria-label={label}
      data-slot={slot}
      value={value}
      // Radix reports '' when the pressed item is clicked again; a radio card cannot be released.
      onValueChange={(next) => {
        if (next) onChange(next as V)
      }}
      spacing={3}
      className="grid w-full grid-cols-2 gap-3 sm:grid-cols-3"
    >
      {options.map((option) => {
        const checked = option.value === value
        return (
          <ToggleGroupItem
            key={option.value}
            value={option.value}
            data-value={option.value}
            className={cn(
              'group/choice flex h-auto w-full min-w-0 flex-col items-stretch gap-0 overflow-hidden rounded-lg border bg-card p-0 text-left shadow-xs transition-colors',
              'hover:bg-card hover:text-foreground data-[state=on]:bg-card data-[state=on]:text-foreground',
              checked ? 'border-foreground ring-1 ring-foreground' : 'border-border hover:border-soft-foreground',
            )}
          >
            <span className="block h-16 w-full overflow-hidden border-b border-border">{option.preview}</span>
            <span className="flex items-center justify-between gap-2 px-3 py-2 text-[13px] font-medium">
              <span className="truncate">{option.label}</span>
              <span
                aria-hidden="true"
                className={cn(
                  'flex size-4 shrink-0 items-center justify-center rounded-full border',
                  checked ? 'border-foreground bg-foreground text-background' : 'border-input',
                )}
              >
                {checked ? <CheckIcon className="size-3" /> : null}
              </span>
            </span>
          </ToggleGroupItem>
        )
      })}
    </ToggleGroup>
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
    <SettingsGroup title="Sidebar">
      <SettingsField
        title="Project order"
        hint="The sidebar is in the order you dragged it into. Reset puts it back to most-recently-opened first. Shared with every browser signed in to this cezar."
        control={
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-slot="appearance-project-order-reset"
            disabled={!canReorder}
            onClick={reset}
          >
            Reset order
          </Button>
        }
      />
    </SettingsGroup>
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
  const logoSrc = logoDraft?.url ?? branding?.logoUrl ?? null
  return (
    <SettingsGroup title="Branding" description="How this cezar instance introduces itself.">
      <SettingsField
        title="Instance name"
        htmlFor="branding-name"
        hint="Shown in the sidebar and browser tab across this workspace."
      >
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="branding-name"
            data-slot="branding-name"
            aria-label="Instance name"
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            onBlur={() => {
              const value = name.trim()
              if (!value) { setName(branding?.name ?? 'cezar'); return }
              if (value !== branding?.name) save.mutate({ branding: { name: value } })
              setLastName(value)
            }}
            className="w-full sm:w-72"
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!branding || branding.name === 'cezar' || save.isPending}
            onClick={() => save.mutate({ branding: { name: null } })}
          >
            Reset name
          </Button>
        </div>
      </SettingsField>
      <SettingsField
        title="Logo"
        hint="PNG, JPEG, WebP, GIF, AVIF, or safe SVG up to 2 MB. Stored on this machine and shared by its browsers."
      >
        <div className="flex flex-wrap items-center gap-3">
          {logoSrc ? (
            <img
              src={logoSrc}
              alt={logoDraft ? 'Logo preview' : 'Current instance logo'}
              className="size-12 rounded-lg border border-border bg-background object-contain p-1"
            />
          ) : (
            <span
              aria-hidden="true"
              className="flex size-12 items-center justify-center rounded-lg border border-dashed border-input text-soft-foreground"
            >
              <ImageIcon className="size-4" />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13.5px] font-medium text-foreground">
              {logoDraft?.file.name ?? (branding?.logoUrl ? 'Current logo' : 'No logo selected')}
            </p>
            <p className="text-xs text-muted-foreground">Choose an image to preview it before saving.</p>
          </div>
          {/* Still a file input, and still hidden: the browser's file picker can only be opened
              by one. "Choose logo" below is the visible control that clicks it. */}
          <Input
            ref={logoInput}
            data-slot="branding-logo"
            aria-label="Upload logo"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/svg+xml"
            disabled={upload.isPending}
            hidden
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              if (file) setLogoDraft({ file, url: URL.createObjectURL(file) })
              event.currentTarget.value = ''
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" disabled={!branding || upload.isPending} onClick={() => logoInput.current?.click()}>
              <UploadIcon aria-hidden="true" className="size-3.5" />
              Choose logo
            </Button>
            {logoDraft ? (
              <>
                <Button type="button" variant="default" size="sm" disabled={upload.isPending} onClick={() => upload.mutate(logoDraft.file)}>Save logo</Button>
                <Button type="button" variant="ghost" size="sm" disabled={upload.isPending} onClick={() => setLogoDraft(null)}>Cancel</Button>
              </>
            ) : branding?.logoUrl ? (
              <Button type="button" variant="ghost" size="sm" disabled={upload.isPending} onClick={() => upload.mutate(null)}>Remove logo</Button>
            ) : null}
          </div>
        </div>
      </SettingsField>
    </SettingsGroup>
  )
}

export function AppearanceSection() {
  const { theme, setTheme } = useTheme()
  const { accent, density, width, setAccent, setDensity, setWidth } = useAppearance()

  return (
    <SettingsPane data-slot="appearance-section">
      <SettingsGroup title="Look" description="Theme applies to this browser; accent, density and width follow you.">
        <SettingsField title="Theme" hint="System follows your OS preference. Applies to this browser.">
          <ChoiceCards slot="appearance-theme" label="Theme" value={theme} options={THEME_OPTIONS} onChange={setTheme} />
        </SettingsField>

        <SettingsField title="Accent" hint="The primary action color. Saved with this repo's cockpit state.">
          <ChoiceCards slot="appearance-accent" label="Accent" value={accent} options={ACCENT_OPTIONS} onChange={setAccent} />
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Layout">
        <SettingsField
          title="Density"
          hint="Compact tightens spacing across the cockpit — text stays the same size."
        >
          <ChoiceCards slot="appearance-density" label="Density" value={density} options={DENSITY_OPTIONS} onChange={setDensity} />
        </SettingsField>

        <SettingsField
          title="Reading width"
          hint="Wide lets a task's session and commits use more of the screen. Narrow keeps a comfortable reading column. The Changes tab is always full-width."
        >
          <ChoiceCards slot="appearance-width" label="Reading width" value={width} options={WIDTH_OPTIONS} onChange={setWidth} />
        </SettingsField>
      </SettingsGroup>

      <BrandingFields />
      <ProjectOrderField />
    </SettingsPane>
  )
}
