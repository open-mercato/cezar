import { EllipsisIcon, MonitorIcon, MoonIcon, SunIcon } from 'lucide-react'
import * as React from 'react'
import type { ReactNode } from 'react'

import { openCommandPalette } from '@/components/command-palette'
import { Kbd } from '@/components/kbd'
import { SelfUpdateDialog } from '@/components/self-update-dialog'
import { StatusDot } from '@/components/status-dot'
import { useTheme } from '@/components/theme-provider'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { CEZAR_REPO_URL, formatStarCount } from '@/lib/star-promo'
import type { Theme } from '@/lib/theme'
import { commandShortcutHint } from '@/lib/use-command-shortcut'

/** What the footer's dot says. `null`: health has not answered. */
export type SidebarHealth = 'healthy' | 'attention' | null

export interface SidebarStatusLineProps {
  health: SidebarHealth
  /** Running tasks in the active project. Null/0 says nothing. */
  runningCount: number | null
  brandName: string
  version: string | null
  latestVersion: string | null
  starCount: number | null
  /** The machine glance (CPU/RAM), mounted only while the menu is open. */
  hostWidget?: ReactNode
  /** `ToolsMenuItems` — the Tools submenu's body. */
  toolsMenu?: ReactNode
  /** The What's new menu item. */
  whatsNew?: ReactNode
}

/** `Healthy · 2 running`, or what stands in for it. */
export function statusLabel(health: SidebarHealth, runningCount: number | null): string {
  const head = health === null ? 'Connecting…' : health === 'healthy' ? 'Healthy' : 'Needs attention'
  return runningCount ? `${head} · ${runningCount} running` : head
}

const THEME_ICON = { system: MonitorIcon, dark: MoonIcon, light: SunIcon } as const
const THEMES: ReadonlyArray<{ value: Theme; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
]

/**
 * The sidebar's footer as ONE line (redesign, Proposal 1): health dot and running count, the ⌘K
 * launcher, and a "⋯" menu holding what the old footer stacked in rows — machine glance, Tools,
 * version and updater, the ⭐ ask, What's new and a three-way theme choice. Nothing is lost;
 * none of it costs a row.
 */
export function SidebarStatusLine({
  health,
  runningCount,
  brandName,
  version,
  latestVersion,
  starCount,
  hostWidget,
  toolsMenu,
  whatsNew,
}: SidebarStatusLineProps) {
  const [updater, setUpdater] = React.useState(false)
  const { theme, setTheme } = useTheme()
  const updateAvailable = Boolean(version && latestVersion && latestVersion !== version)
  const ThemeIcon = THEME_ICON[theme]
  return (
    <div data-slot="sidebar-footer" className="flex h-10 shrink-0 items-center gap-2 border-t border-border px-3.5 text-meta text-muted-foreground">
      <StatusDot
        data-slot="sidebar-health-dot"
        tone={health === null ? 'neutral' : health === 'healthy' ? 'success' : 'pending'}
        pulse={health === null}
      />
      <span data-slot="sidebar-status" className="min-w-0 truncate">
        {statusLabel(health, runningCount)}
      </span>
      <button
        type="button"
        data-slot="command-palette-hint"
        title="Search — command palette (⌘K / Ctrl+K)"
        onClick={() => openCommandPalette()}
        className="ml-auto flex shrink-0 items-center rounded-sm outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <span className="sr-only">Search</span>
        <Kbd>{commandShortcutHint('k')}</Kbd>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-xs" data-slot="sidebar-more" aria-label="More" title="More">
            <EllipsisIcon aria-hidden="true" />
            {updateAvailable ? <span data-slot="sidebar-more-update" aria-hidden="true" className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-pending" /> : null}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="end" data-slot="sidebar-more-content" className="w-64">
          {hostWidget ? <div data-slot="sidebar-more-host" className="px-1 pt-1">{hostWidget}</div> : null}
          {toolsMenu ? (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger data-slot="tools-menu">Tools</DropdownMenuSubTrigger>
              <DropdownMenuSubContent data-slot="tools-menu-content" className="w-[240px]">{toolsMenu}</DropdownMenuSubContent>
            </DropdownMenuSub>
          ) : null}
          {whatsNew}
          {version ? (
            <DropdownMenuItem
              data-slot="version-chip"
              data-update-available={updateAvailable ? 'true' : undefined}
              title={updateAvailable ? `v${version} — update available: v${latestVersion}` : `v${version}`}
              aria-label={updateAvailable ? `${brandName} v${version}, update to v${latestVersion} available — open updater` : `${brandName} v${version} — open updater`}
              onSelect={() => setUpdater(true)}
            >
              {updateAvailable ? <StatusDot tone="pending" pulse className="size-[5px]" /> : null}
              <span className="min-w-0 truncate font-mono text-label">v{version}</span>
              {updateAvailable ? <span className="ml-auto text-micro text-muted-foreground">v{latestVersion} available</span> : null}
            </DropdownMenuItem>
          ) : null}
          {starCount === null ? null : (
            <DropdownMenuItem asChild>
              <a
                data-slot="star-chip"
                href={CEZAR_REPO_URL}
                target="_blank"
                rel="noopener noreferrer"
                title={`Star cezar on GitHub — ${starCount.toLocaleString()} stars`}
                aria-label={`Star cezar on GitHub — ${starCount.toLocaleString()} stars`}
              >
                <span aria-hidden="true">⭐</span>
                Star cezar on GitHub
                <span className="ml-auto font-mono text-micro text-soft-foreground">{formatStarCount(starCount)}</span>
              </a>
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="flex items-center gap-2 text-xs text-soft-foreground">
            <ThemeIcon className="size-3.5" aria-hidden="true" />
            Theme
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup value={theme} onValueChange={(value) => setTheme(value as Theme)} data-slot="theme-toggle" data-theme-pref={theme}>
            {THEMES.map((option) => (
              <DropdownMenuRadioItem key={option.value} value={option.value} data-theme={option.value}>
                {option.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {updater ? <SelfUpdateDialog open={updater} onOpenChange={setUpdater} brandName={brandName} /> : null}
    </div>
  )
}
