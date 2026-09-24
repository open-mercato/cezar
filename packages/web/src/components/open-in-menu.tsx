import {
  BotIcon,
  BoxesIcon,
  BracesIcon,
  CodeIcon,
  CpuIcon,
  DiamondIcon,
  ExternalLinkIcon,
  FeatherIcon,
  FolderIcon,
  GemIcon,
  GlobeIcon,
  HammerIcon,
  HexagonIcon,
  MousePointer2Icon,
  RocketIcon,
  ShapesIcon,
  SmartphoneIcon,
  SparklesIcon,
  SquareTerminalIcon,
  WavesIcon,
  ZapIcon,
  type LucideIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'

import type { OpenTarget, Runner } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

/**
 * The shared "Open in…" menu: hand a local path to whichever app the machine actually has.
 *
 * Extracted from the task thread's run header when Settings → Agent accounts needed the same
 * choice for a config file (a user asked for "system tools or for example vscode" — the same
 * question the thread already answered for a worktree). One menu, one icon table, one place where
 * an unknown target degrades to a generic glyph.
 *
 * What stays with the CALLER is anything about what is being opened: the run header keeps its
 * "Terminal (resume session)" item, its agent-availability filtering and its copy-path row; the
 * accounts pane keeps its per-file filtering. This component knows only how to render a target
 * list and report the pick.
 */

/** Icon key (`OpenTarget.icon`, #361) → the Lucide icon that renders it in the menu. Distinct per
 *  target so the "Open in…" list reads at a glance instead of as a wall of text — a few picks
 *  lean on the target's own branding (RubyMine → gem, Android Studio → phone, CLion → cpu),
 *  the rest just aim for visual variety. An icon key the client doesn't recognize (older server,
 *  newer server) falls back to the menu's own ExternalLinkIcon rather than rendering nothing. */
const OPEN_IN_ICONS: Record<string, LucideIcon> = {
  folder: FolderIcon,
  terminal: SquareTerminalIcon,
  vscode: CodeIcon,
  cursor: MousePointer2Icon,
  zed: ZapIcon,
  windsurf: WavesIcon,
  sublime: FeatherIcon,
  idea: DiamondIcon,
  pycharm: HexagonIcon,
  webstorm: GlobeIcon,
  goland: ShapesIcon,
  rubymine: GemIcon,
  phpstorm: BracesIcon,
  clion: CpuIcon,
  rider: BoxesIcon,
  'android-studio': SmartphoneIcon,
  xcode: HammerIcon,
  warp: RocketIcon,
  claude: BotIcon,
  codex: SparklesIcon,
  opencode: BotIcon,
  pi: BotIcon,
}

/** The icon component for a target — `target.icon` when it's one the UI knows, else the
 *  same generic glyph the trigger button itself uses. */
export function openInIcon(target: OpenTarget): LucideIcon {
  return (target.icon && OPEN_IN_ICONS[target.icon]) || ExternalLinkIcon
}

/** The runner a `cli:<runner>` Open-in target hands off to, or undefined for every other
 *  target (editors, Finder, terminal) — mirrors the server's `agentCliRunner` (open-in-app.ts)
 *  without importing server code into the bundle. */
export function cliTargetRunner(targetId: string): Runner | undefined {
  const match = /^cli:(claude|codex|opencode|pi)$/.exec(targetId)
  return match ? (match[1] as Runner) : undefined
}

/** A target the caller has decided is applicable, plus how it should read in the menu. */
export interface OpenInChoice {
  target: OpenTarget
  /** Appended to the label — the run header's `(resume)`, for instance. */
  suffix?: string
  title?: string
}

export function OpenInMenu({
  choices,
  onPick,
  label = 'Open in…',
  title,
  triggerVariant = 'ghost',
  disabled = false,
  /** Rendered ABOVE the target list, separated — the run header's resume item. */
  leading,
  /** Rendered BELOW it, separated — the run header's "Copy worktree path". */
  trailing,
  slot,
}: {
  choices: OpenInChoice[]
  onPick: (targetId: string) => void
  label?: string
  title?: string
  triggerVariant?: 'ghost' | 'outline'
  disabled?: boolean
  leading?: ReactNode
  trailing?: ReactNode
  slot?: string
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={triggerVariant} size="sm" title={title} disabled={disabled} data-slot={slot}>
          <ExternalLinkIcon aria-hidden="true" />
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {leading}
        {leading && choices.length > 0 ? <DropdownMenuSeparator /> : null}
        {choices.map(({ target, suffix, title: itemTitle }) => {
          const Icon = openInIcon(target)
          return (
            <DropdownMenuItem
              key={target.id}
              data-target={target.id}
              title={itemTitle}
              onSelect={() => onPick(target.id)}
            >
              <Icon aria-hidden="true" />
              {target.label}
              {suffix ?? ''}
            </DropdownMenuItem>
          )
        })}
        {trailing}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
