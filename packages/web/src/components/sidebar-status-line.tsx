import { EllipsisIcon, MonitorIcon, MoonIcon, SearchIcon, StarIcon, SunIcon, WrenchIcon } from 'lucide-react'
import * as React from 'react'
import type { ReactNode } from 'react'

import { openCommandPalette } from '@/components/command-palette'
import { Kbd } from '@/components/kbd'
import { SelfUpdateDialog } from '@/components/self-update-dialog'
import { StatusDot } from '@/components/status-dot'
import { useTheme } from '@/components/theme-provider'
import { Button } from '@/components/ui/button'
import { IconTooltip } from '@/components/ui/icon-tooltip'
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
import { cn } from '@/lib/utils'
import { commandShortcutHint } from '@/lib/use-command-shortcut'

/** What the footer's dot says. `null`: health has not answered. */
export type SidebarHealth = 'healthy' | 'attention' | null

export interface SidebarStatusLineProps {
  /** Omitted (Settings): no dot and no status — the footer keeps search, version and the menu. */
  health?: SidebarHealth
  /** Running tasks in the active project. Null/0 says nothing. */
  runningCount?: number | null
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
  /** What's new has items the user has not opened — the ⋯ button's only dot. */
  whatsNewUnseen?: boolean
  /** Why health needs attention (`toolsTooltip`), as the status's one-line tooltip. */
  healthReason?: string | null
}

/** `Healthy · 2 running`, or what stands in for it. */
export function statusLabel(health: SidebarHealth, runningCount: number | null): string {
  const head = health === null ? 'Connecting…' : health === 'healthy' ? 'Healthy' : 'Needs attention'
  return runningCount ? `${head} · ${runningCount} running` : head
}

const THEMES: ReadonlyArray<{ value: Theme; label: string; Icon: typeof MonitorIcon }> = [
  { value: 'system', label: 'System', Icon: MonitorIcon },
  { value: 'dark', label: 'Dark', Icon: MoonIcon },
  { value: 'light', label: 'Light', Icon: SunIcon },
]

const FOCUS_RING = 'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'

/**
 * The sidebar's footer, two rows: a search launcher, then health and running count beside the
 * version chip (main's footer placement, #368) and a "⋯" panel for the machine glance, Tools,
 * What's new, the ⭐ ask and the theme.
 */
export function SidebarStatusLine({
  health,
  runningCount = null,
  brandName,
  version,
  latestVersion,
  starCount,
  hostWidget,
  toolsMenu,
  whatsNew,
  whatsNewUnseen = false,
  healthReason = null,
}: SidebarStatusLineProps) {
  const [updater, setUpdater] = React.useState(false)
  const { theme, setTheme } = useTheme()
  const status = (
    <span
      data-slot="sidebar-status"
      // Focusable only when it carries a reason, so the keyboard reaches the tooltip too.
      tabIndex={health === 'attention' && healthReason ? 0 : undefined}
      className={cn('min-w-0 truncate rounded-sm', FOCUS_RING)}
    >
      {statusLabel(health ?? null, runningCount)}
    </span>
  )
  return (
    <div data-slot="sidebar-footer" className="flex shrink-0 flex-col gap-1.5 border-t border-border px-3 py-2.5">
      <button
        type="button"
        data-slot="command-palette-hint"
        title="Search tasks, pages, commands (⌘K / Ctrl+K)"
        onClick={() => openCommandPalette()}
        className={cn(
          'flex h-8 w-full min-w-0 items-center gap-2 rounded-md border border-border bg-muted/40 px-2.5 text-ui text-soft-foreground transition-colors hover:bg-muted hover:text-muted-foreground',
          FOCUS_RING,
        )}
      >
        <SearchIcon className="size-3.5 shrink-0" aria-hidden="true" />
        {/* A visible phrase: a touch drawer has no other way into search. */}
        <span className="min-w-0 flex-1 truncate text-left">Search tasks, pages, commands…</span>
        <Kbd className="shrink-0">{commandShortcutHint('k')}</Kbd>
      </button>

      <div data-slot="sidebar-footer-controls" className="flex h-6 min-w-0 items-center gap-2 text-meta text-muted-foreground">
        {health === undefined ? null : (
          <>
            <StatusDot
              data-slot="sidebar-health-dot"
              tone={health === null ? 'neutral' : health === 'healthy' ? 'success' : 'pending'}
              pulse={health === null}
            />
            {health === 'attention' && healthReason ? <IconTooltip label={healthReason} side="top">{status}</IconTooltip> : status}
          </>
        )}
        <div className="ml-auto flex min-w-0 items-center gap-1">
          {version ? <VersionChip version={version} latestVersion={latestVersion} brandName={brandName} onOpen={() => setUpdater(true)} /> : null}
          <MoreMenu
            health={health}
            starCount={starCount}
            hostWidget={hostWidget}
            toolsMenu={toolsMenu}
            whatsNew={whatsNew}
            whatsNewUnseen={whatsNewUnseen}
            theme={theme}
            setTheme={setTheme}
          />
        </div>
      </div>
      {updater ? <SelfUpdateDialog open={updater} onOpenChange={setUpdater} brandName={brandName} /> : null}
    </div>
  )
}

/** The running version; with a newer one published it turns into the footer's update call. */
function VersionChip({
  version,
  latestVersion,
  brandName,
  onOpen,
}: {
  version: string
  latestVersion: string | null
  brandName: string
  onOpen: () => void
}) {
  const updateAvailable = Boolean(latestVersion && latestVersion !== version)
  return (
    <IconTooltip side="top" label={updateAvailable ? `Update available: v${latestVersion} (running v${version})` : `${brandName} v${version}`}>
      <button
        type="button"
        data-slot="version-chip"
        data-update-available={updateAvailable ? 'true' : undefined}
        aria-label={
          updateAvailable
            ? `${brandName} v${version}, update to v${latestVersion} available — open updater`
            : `${brandName} v${version} — open updater`
        }
        onClick={onOpen}
        className={cn(
          // The row's one elastic item (#876): a nightly version string gives way, nothing else.
          'flex h-6 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-micro transition-colors hover:bg-muted hover:text-foreground',
          updateAvailable ? 'border border-border bg-card' : 'text-soft-foreground',
          FOCUS_RING,
        )}
      >
        {updateAvailable ? <StatusDot tone="pending" pulse className="size-[5px]" /> : null}
        <span className="min-w-0 truncate font-mono">v{version}</span>
        {updateAvailable ? (
          <span data-slot="version-chip-update" className="shrink-0 font-medium text-pending-strong">
            Update
          </span>
        ) : null}
      </button>
    </IconTooltip>
  )
}

function MoreMenu({
  health,
  starCount,
  hostWidget,
  toolsMenu,
  whatsNew,
  whatsNewUnseen,
  theme,
  setTheme,
}: {
  health: SidebarHealth | undefined
  starCount: number | null
  hostWidget?: ReactNode
  toolsMenu?: ReactNode
  whatsNew?: ReactNode
  whatsNewUnseen: boolean
  theme: Theme
  setTheme: (theme: Theme) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-xs" data-slot="sidebar-more" aria-label="More" title="More" className="relative shrink-0">
          <EllipsisIcon aria-hidden="true" />
          {/* What's new only — the update is announced by the version chip. */}
          {whatsNewUnseen ? (
            <span
              data-slot="sidebar-more-update"
              data-reason="whats-new"
              aria-hidden="true"
              className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-violet"
            />
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" data-slot="sidebar-more-content" className="w-64 max-w-[calc(100vw-2rem)]">
        {hostWidget ? (
          <>
            <DropdownMenuLabel className="eyebrow px-2 pt-1.5 pb-1 text-meta font-semibold text-soft-foreground">
              This machine
            </DropdownMenuLabel>
            <div data-slot="sidebar-more-host" className="px-1 pb-1">{hostWidget}</div>
            <DropdownMenuSeparator />
          </>
        ) : null}
        {toolsMenu ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger data-slot="tools-menu" className="text-ui">
              <WrenchIcon aria-hidden="true" />
              <span className="flex-1">Tools</span>
              {health === 'attention' ? (
                <StatusDot data-slot="tools-menu-attention" tone="pending" className="size-1.5" aria-hidden="true" />
              ) : null}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent data-slot="tools-menu-content" className="w-[240px]">{toolsMenu}</DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        {whatsNew}
        {starCount === null ? null : (
          <DropdownMenuItem asChild className="text-ui">
            <a
              data-slot="star-chip"
              href={CEZAR_REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              title={`Star cezar on GitHub — ${starCount.toLocaleString()} stars`}
              aria-label={`Star cezar on GitHub — ${starCount.toLocaleString()} stars`}
            >
              <StarIcon aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">Star cezar on GitHub</span>
              <span className="shrink-0 text-label text-soft-foreground tabular-nums">{formatStarCount(starCount)}</span>
            </a>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="eyebrow px-2 pt-1.5 pb-1 text-meta font-semibold text-soft-foreground">
          Theme
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={theme}
          onValueChange={(value) => setTheme(value as Theme)}
          data-slot="theme-toggle"
          data-theme-pref={theme}
          className="grid grid-cols-3 gap-1 px-1 pb-1"
        >
          {THEMES.map(({ value, label, Icon }) => (
            <DropdownMenuRadioItem
              key={value}
              value={value}
              data-theme={value}
              // A segmented cell, not a list row: no radio bullet, the checked one lifted (spec: Segmented).
              className={cn(
                'flex-col justify-center gap-1 rounded-md px-1 py-2 text-micro text-muted-foreground [&>span:first-child]:hidden',
                'data-[state=checked]:bg-muted data-[state=checked]:text-foreground data-[state=checked]:ring-1 data-[state=checked]:ring-border',
              )}
            >
              <Icon className="size-4" aria-hidden="true" />
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
