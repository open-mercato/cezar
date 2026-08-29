import {
  EllipsisVerticalIcon,
  ExternalLinkIcon,
  GitCommitHorizontalIcon,
  GitPullRequestIcon,
  SquareTerminalIcon,
  UploadIcon,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'

import type { DiffStat } from '@open-mercato/cezar-api-client'
import { DiffStatLabel } from '@/components/diff-stat'
import type { DiffMode } from '@/components/diff'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { GitAction, GitActionBar, GitActionId } from '@/lib/git-actions'

import { DiffViewToggles } from './diff-controls'

/** The one git area, two lenses (user decision): the branch's DIFF and its HISTORY, switched
 *  locally. md+ only — below md the tab row over the page already lists Changes and Commits. */
export function GitSubTabs({ runId, active }: { runId: string; active: 'changes' | 'commits' }) {
  const step = 'rounded-[5px] px-2.5 py-1 text-[12px] font-medium transition-colors'
  return (
    <span
      data-slot="git-subtabs"
      className="hidden items-center rounded-md border border-border bg-muted p-0.5 md:flex"
    >
      <Link
        to={`/tasks/${runId}/changes`}
        aria-current={active === 'changes' ? 'page' : undefined}
        className={cn(step, active === 'changes' ? 'bg-card text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground')}
      >
        Changes
      </Link>
      <Link
        to={`/tasks/${runId}/commits`}
        aria-current={active === 'commits' ? 'page' : undefined}
        className={cn(step, active === 'commits' ? 'bg-card text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground')}
      >
        Commits
      </Link>
    </span>
  )
}

/**
 * The Changes tab's toolbar (spec #390). Deliberately DUMB about git: it renders whatever
 * `gitActionPolicy` returned — primary CTA, secondary buttons, overflow menu — plus the
 * local view toggles (unified/split, wrap; hidden below `md`, where unified+wrap is forced).
 * The branch chip and the aggregate ± left for the app bar (user decision) — the bar's one
 * branch control says both. Every disabled action shows the policy's own reason as its
 * tooltip. No git conditionals live here — that is the policy module's contract.
 */
export function GitToolbar({
  bar,
  runId,
  cta,
  mode,
  wrap,
  onModeChange,
  onWrapChange,
  onAction,
}: {
  bar: GitActionBar
  runId: string
  /** The run's primary CTA, docked in the row's real middle (design review): as a flex child
   *  it can never overlap the toolbar's own controls the way the absolutely-centered float
   *  did. The parent passes `RunPrimaryCta`; the header skips its float on this tab. */
  cta?: ReactNode
  mode: DiffMode
  wrap: boolean
  onModeChange: (mode: DiffMode) => void
  onWrapChange: (wrap: boolean) => void
  onAction: (id: GitActionId) => void
}) {
  return (
    <div
      data-slot="git-toolbar"
      className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-border px-4 py-2 md:px-6"
    >
      <GitSubTabs runId={runId} active="changes" />

      <span data-slot="toolbar-cta-slot" className="hidden min-w-0 flex-1 justify-center md:flex">
        {cta}
      </span>

      <span className="ml-auto flex items-center gap-1">
        {/* View toggles — layout preferences, not git actions, so not the policy's business.
            Hidden below md: phones force unified+wrap (the parent owns that rule). */}
        <span className="hidden items-center gap-1 md:flex">
          <DiffViewToggles mode={mode} wrap={wrap} onModeChange={onModeChange} onWrapChange={onWrapChange} />
        </span>

        {bar.secondary.map((action) => (
          <ActionButton key={action.id} action={action} variant="outline" onAction={onAction} />
        ))}
        <ActionButton action={bar.primary} variant="primary" onAction={onAction} />

        {bar.menu.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="More git actions">
                <EllipsisVerticalIcon aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" data-slot="git-toolbar-menu">
              {bar.menu.map((action) => (
                <DropdownMenuItem
                  key={action.id}
                  disabled={!action.enabled}
                  title={action.reason}
                  onSelect={() => onAction(action.id)}
                >
                  {ACTION_ICONS[action.id]}
                  {action.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </span>
    </div>
  )
}

const ACTION_ICONS: Record<GitActionId, ReactNode> = {
  commit: <GitCommitHorizontalIcon aria-hidden="true" />,
  push: <UploadIcon aria-hidden="true" />,
  'create-pr': <GitPullRequestIcon aria-hidden="true" />,
  'open-terminal': <SquareTerminalIcon aria-hidden="true" />,
}

/** One policy entry → one button. `view-pr` renders as a real link when the policy's href is a
 *  safe URL, and disabled when it is not; everything else clicks through to the parent's
 *  mutation switch. */
function ActionButton({
  action,
  variant,
  onAction,
}: {
  action: GitAction
  variant: 'primary' | 'outline'
  onAction: (id: GitActionId) => void
}) {
  return (
    <Button
      variant={variant}
      size="sm"
      data-action={action.id}
      disabled={!action.enabled}
      title={action.enabled ? undefined : action.reason}
      onClick={() => onAction(action.id)}
    >
      {ACTION_ICONS[action.id]}
      {action.label}
    </Button>
  )
}

/**
 * The "animated aggregate ± stat" (spec #390): the toolbar's totals count toward new values
 * when the diff changes (a live agent turn growing the diff reads as movement, not a flicker).
 * Respects `prefers-reduced-motion` — reduced means jump, not tween. First render starts at
 * the real value, so tests and screenshots never catch a fake zero.
 */
export function AnimatedDiffStat({ stat }: { stat: DiffStat }) {
  const adds = useAnimatedNumber(stat.adds)
  const dels = useAnimatedNumber(stat.dels)
  return (
    <span data-slot="changes-stat">
      <DiffStatLabel stat={{ adds, dels, files: stat.files }} />
    </span>
  )
}

function useAnimatedNumber(target: number): number {
  const [value, setValue] = useState(target)
  const fromRef = useRef(target)

  useEffect(() => {
    const from = fromRef.current
    if (from === target) return
    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced || typeof requestAnimationFrame !== 'function') {
      fromRef.current = target
      setValue(target)
      return
    }
    const start = performance.now()
    const duration = 350
    let raf = 0
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      const eased = 1 - (1 - t) ** 3
      setValue(Math.round(from + (target - from) * eased))
      if (t < 1) {
        raf = requestAnimationFrame(tick)
      } else {
        fromRef.current = target
      }
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      fromRef.current = target
      setValue(target)
    }
  }, [target])

  return value
}
