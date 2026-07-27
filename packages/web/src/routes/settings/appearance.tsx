import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react'
import type { ComponentType, ReactNode, SVGProps } from 'react'

import { useAppearance } from '@/components/appearance-provider'
import { useTheme } from '@/components/theme-provider'
import { cn } from '@/lib/utils'
import type { Accent, Density } from '@/lib/appearance'
import type { Theme } from '@/lib/theme'

/**
 * Settings → Appearance (R6 Step 1.3, spec §"Settings").
 *
 * Three knobs, each honest about where it persists:
 *  - THEME rides the existing theme system (localStorage `cez-theme`, shared with the legacy
 *    cockpit and the pre-paint script) — per-browser by design, like every OS theme choice;
 *  - ACCENT + DENSITY persist in `ui-state.json` through the AppearanceProvider (additive
 *    `appearance` key), mirrored to localStorage for pre-paint.
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

export function AppearanceSection() {
  const { theme, setTheme } = useTheme()
  const { accent, density, setAccent, setDensity } = useAppearance()

  return (
    <div
      data-slot="appearance-section"
      className="mx-auto flex w-full max-w-2xl flex-col gap-7 p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-6 md:pb-6"
    >
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
    </div>
  )
}
