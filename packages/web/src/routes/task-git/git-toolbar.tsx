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
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { GitAction, GitActionBar, GitActionId } from '@/lib/git-actions'
import { isHttpUrl } from '@/lib/utils'

import { BranchChip, DiffViewToggles } from './diff-controls'

/**
 * The Changes tab's toolbar (spec #390). Deliberately DUMB about git: it renders whatever
 * `gitActionPolicy` returned — primary CTA, secondary buttons, overflow menu — plus the
 * branch chip, the animated aggregate ± stat, and the local view toggles (unified/split,
 * wrap; hidden below `md`, where unified+wrap is forced). Every disabled action shows the
 * policy's own reason as its tooltip. No git conditionals live here — that is the policy
 * module's contract.
 */
export function GitToolbar({
  bar,
  branch,
  stat,
  mode,
  wrap,
  onModeChange,
  onWrapChange,
  onAction,
}: {
  bar: GitActionBar
  branch?: string
  stat?: DiffStat
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
      {branch ? <BranchChip branch={branch} /> : null}
      {stat ? <AnimatedDiffStat stat={stat} /> : null}

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
  'view-pr': <ExternalLinkIcon aria-hidden="true" />,
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
  // href protocol guard (#431): treat the PR link as a link only for http(s) URLs. A refused
  // href must NOT fall through to the generic button below — the policy hardcodes view-pr as
  // enabled and the parent's `view-pr` case is a deliberate no-op, so it would render a
  // clickable button that silently does nothing. Disabled + a reason, like every other
  // unavailable action.
  if (action.id === 'view-pr') {
    if (!isHttpUrl(action.href)) {
      return (
        <Button
          variant={variant}
          size="sm"
          data-action={action.id}
          disabled
          title="View PR unavailable — the recorded PR link is not an http(s) URL"
        >
          {ACTION_ICONS[action.id]}
          {action.label}
        </Button>
      )
    }
    return (
      <Button asChild variant={variant} size="sm" data-action={action.id}>
        <a href={action.href} target="_blank" rel="noopener noreferrer">
          {ACTION_ICONS[action.id]}
          {action.label}
        </a>
      </Button>
    )
  }
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
