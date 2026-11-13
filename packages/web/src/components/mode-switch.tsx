import { BotIcon, FoldersIcon } from 'lucide-react'
import { Link } from 'react-router'

import { noteManagerEntry } from '@/lib/manager-telemetry'
import { MANAGER_ATTENTION_DOT, type ManagerAttention } from '@/lib/managers'
import { IconTooltip } from '@/components/ui/icon-tooltip'
import { cn } from '@/lib/utils'

export interface ModeSwitchProps {
  /** On a manager URL: the mode IS the URL, never stored state. */
  managerMode: boolean
  /** Where Projects leads: the page this tab left for Manager (`tasksHref`), else the project's Now. */
  projectsTo: string
  /** Where Manager leads: the chat or list this tab left (`managerHref`). */
  managerTo: string
  /** Tasks need you in the active project — the Now badge's count, dotted on the Projects half. */
  projectsAttention: boolean
  managerAttention: ManagerAttention | null
  onNavigate?: (() => void) | undefined
}

/** Screen-reader words for each half's dot, read as part of its name. */
const PROJECTS_DOT_TEXT = ', tasks need you'
const MANAGER_DOT_TEXT: Record<ManagerAttention, string> = { 'needs-you': ', a manager needs you', unread: ', a manager has news' }

const SEGMENT =
  'relative flex h-7 min-w-0 items-center justify-center gap-1.5 rounded-[7px] px-2 text-ui font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 max-md:h-9'
const SEGMENT_ACTIVE = 'bg-card font-semibold text-foreground shadow-xs'

/** What each half shows: the dot only ever sits on the half you are NOT on. */
function halves({ managerMode, projectsTo, managerTo, projectsAttention, managerAttention }: ModeSwitchProps) {
  return {
    projects: { to: projectsTo, active: !managerMode, dot: managerMode && projectsAttention ? 'bg-info' : null, dotText: PROJECTS_DOT_TEXT },
    manager: {
      to: managerTo,
      active: managerMode,
      dot: !managerMode && managerAttention ? MANAGER_ATTENTION_DOT[managerAttention] : null,
      dotText: managerAttention ? MANAGER_DOT_TEXT[managerAttention] : '',
    },
  }
}

/**
 * The sidebar's Projects | Manager switch (design 2026-11 "Manager mode", § 1). Two links, not
 * toggles: each half lands where this tab last was in that mode, so Back and a pasted link agree.
 * Looks like `Segmented`, which is buttons-only.
 */
export function ModeSwitch(props: ModeSwitchProps) {
  const { projects, manager } = halves(props)
  const { managerMode, onNavigate } = props
  return (
    <nav aria-label="Mode" data-slot="mode-switch" className="mx-3 mb-2 grid grid-cols-2 gap-0.5 rounded-md bg-muted p-[3px]">
      <Link
        to={projects.to}
        data-mode="projects"
        aria-current={projects.active ? 'page' : undefined}
        onClick={onNavigate}
        className={cn(SEGMENT, projects.active && SEGMENT_ACTIVE)}
      >
        <FoldersIcon className="size-3.5 shrink-0" aria-hidden="true" />
        Projects
        {projects.dot ? <Dot tone={projects.dot} text={projects.dotText} /> : null}
      </Link>
      <Link
        to={manager.to}
        data-mode="manager"
        aria-current={manager.active ? 'page' : undefined}
        onClick={() => {
          if (!managerMode) noteManagerEntry('sidebar')
          onNavigate?.()
        }}
        className={cn(SEGMENT, manager.active && SEGMENT_ACTIVE)}
      >
        <BotIcon className="size-3.5 shrink-0" aria-hidden="true" />
        Manager
        {manager.dot ? <Dot tone={manager.dot} text={manager.dotText} /> : null}
      </Link>
    </nav>
  )
}

function Dot({ tone, text }: { tone: string; text: string }) {
  return (
    <span data-slot="mode-switch-dot" className="flex shrink-0">
      <span className={cn('size-1.5 rounded-full', tone)} aria-hidden="true" />
      <span className="sr-only">{text}</span>
    </span>
  )
}

const RAIL_ITEM =
  'relative flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50'

/** The folded rail's switch: the two halves stacked as icons, each carrying its dot. */
export function ModeRailSwitch(props: ModeSwitchProps) {
  const { projects, manager } = halves(props)
  const { managerMode } = props
  return (
    <nav aria-label="Mode" data-slot="rail-mode-switch" className="flex flex-col items-center gap-1 border-b border-border pb-1.5">
      <IconTooltip label="Projects" side="right">
        <Link
          to={projects.to}
          data-mode="projects"
          aria-label={`Projects${projects.dot ? projects.dotText : ''}`}
          aria-current={projects.active ? 'page' : undefined}
          className={cn(RAIL_ITEM, projects.active && 'bg-muted text-foreground')}
        >
          <FoldersIcon className="size-4" aria-hidden="true" />
          {projects.dot ? <span data-slot="mode-switch-dot" aria-hidden="true" className={cn('absolute top-1 right-1 size-1.5 rounded-full', projects.dot)} /> : null}
        </Link>
      </IconTooltip>
      <IconTooltip label="Manager" side="right">
        <Link
          to={manager.to}
          data-mode="manager"
          aria-label={`Manager${manager.dot ? manager.dotText : ''}`}
          aria-current={manager.active ? 'page' : undefined}
          onClick={() => { if (!managerMode) noteManagerEntry('sidebar') }}
          className={cn(RAIL_ITEM, manager.active && 'bg-muted text-foreground')}
        >
          <BotIcon className="size-4" aria-hidden="true" />
          {manager.dot ? <span data-slot="mode-switch-dot" aria-hidden="true" className={cn('absolute top-1 right-1 size-1.5 rounded-full', manager.dot)} /> : null}
        </Link>
      </IconTooltip>
    </nav>
  )
}
