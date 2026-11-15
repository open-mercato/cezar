import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react'

import { Segmented, type SegmentedOption } from '@/components/segmented'
import { useTheme } from '@/components/theme-provider'
import type { Theme } from '@/lib/theme'

/* The theme choice as a `Segmented` System / Dark / Light (UI strategy: `Segmented` for 2–4
 * options; the cycling icon-only button it replaces hid two of the three states). One component
 * for every caller — Settings → Appearance and the sidebar's ⋯ menu say the same three words in
 * the same order. The pressed option shows the *choice*, not the resolved palette — otherwise
 * `system` would be invisible. */

/** Exported because the ⌘K palette's "Toggle theme" action still cycles — one order, defined once. */
export const NEXT_THEME: Record<Theme, Theme> = { light: 'dark', dark: 'system', system: 'light' }
const LABEL: Record<Theme, string> = { light: 'Light', dark: 'Dark', system: 'System' }

/** The three options, in the order every theme control renders them. */
export const THEME_OPTIONS: readonly SegmentedOption<Theme>[] = [
  { value: 'system', label: <ThemeOptionLabel theme="system" /> },
  { value: 'dark', label: <ThemeOptionLabel theme="dark" /> },
  { value: 'light', label: <ThemeOptionLabel theme="light" /> },
]

const ICON = { light: SunIcon, dark: MoonIcon, system: MonitorIcon } as const

function ThemeOptionLabel({ theme }: { theme: Theme }) {
  const Icon = ICON[theme]
  return (
    <>
      <Icon aria-hidden="true" className="size-3.5" />
      {LABEL[theme]}
    </>
  )
}

export function ThemeToggle({ className, full = false }: { className?: string; full?: boolean }) {
  const { theme, setTheme } = useTheme()

  return (
    <div data-slot="theme-toggle" data-theme-pref={theme} className={full ? 'w-full' : 'inline-flex'}>
      <Segmented
        slot="theme-toggle-options"
        label="Theme"
        value={theme}
        options={THEME_OPTIONS}
        onChange={setTheme}
        full={full}
        className={className}
      />
    </div>
  )
}
