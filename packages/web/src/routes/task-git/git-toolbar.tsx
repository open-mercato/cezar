import {
  ChevronDownIcon,
  GitCommitHorizontalIcon,
  GitMergeIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  RefreshCwIcon,
  UploadIcon,
  WrenchIcon,
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
import type { GitAction, GitActionId } from '@/lib/git-actions'

import { BranchChip, DiffViewToggles } from './diff-controls'

/**
 * The Changes tab's toolbar (spec #390). Deliberately DUMB about git: it renders whatever
 * `gitActionPolicy` returned — no git step of its own (the run header carries it: its title row on
 * desktop, its action menu on phones) — plus the
 * branch chip, the animated aggregate ± stat, and the local view toggles (unified/split,
 * wrap; hidden below `md`, where unified+wrap is forced). Every disabled action shows the
 * policy's own reason as its tooltip. No git conditionals live here — that is the policy
 * module's contract.
 */
export function GitToolbar({
  branch,
  stat,
  mode,
  wrap,
  onModeChange,
  onWrapChange,
}: {
  branch?: string
  stat?: DiffStat
  mode: DiffMode
  wrap: boolean
  onModeChange: (mode: DiffMode) => void
  onWrapChange: (wrap: boolean) => void
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

      </span>
    </div>
  )
}

/**
 * The one git button: the policy's single next step, or nothing. Outline — secondary weight; the
 * page's one primary action is the chat box's send. Rendered verbatim from the policy: which step
 * is "next" is decided there, never here.
 */
export function GitActions({ action, onAction }: { action: GitAction | null; onAction: (id: GitActionId) => void }) {
  if (!action) return null
  const alternatives = action.alternatives ?? []
  return (
    <span data-slot="git-button" className="inline-flex items-center">
      <ActionButton
        action={action}
        variant="outline"
        onAction={onAction}
        className={alternatives.length > 0 ? 'rounded-r-none' : undefined}
      />
      {/* The same step said differently (Create PR → Create draft PR) — never a different step:
          the button stays one action, the chevron only changes how it is taken. */}
      {alternatives.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              aria-label={`More ways to ${action.label.toLowerCase()}`}
              className="-ml-px rounded-l-none px-1.5"
            >
              <ChevronDownIcon aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" data-slot="git-button-menu">
            {alternatives.map((alternative) => (
              <DropdownMenuItem
                key={alternative.id}
                data-action={alternative.id}
                disabled={!alternative.enabled}
                title={alternative.reason}
                onSelect={() => onAction(alternative.id)}
              >
                {GIT_ACTION_ICONS[alternative.id]}
                {alternative.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </span>
  )
}

/** One icon per git step — shared with the phone action menu, so both spell a step the same. */
export const GIT_ACTION_ICONS: Record<GitActionId, ReactNode> = {
  commit: <GitCommitHorizontalIcon aria-hidden="true" />,
  'commit-push': <UploadIcon aria-hidden="true" />,
  push: <UploadIcon aria-hidden="true" />,
  'create-pr': <GitPullRequestIcon aria-hidden="true" />,
  'create-draft-pr': <GitPullRequestDraftIcon aria-hidden="true" />,
  'update-branch': <RefreshCwIcon aria-hidden="true" />,
  'resolve-conflicts': <GitMergeIcon aria-hidden="true" />,
  'fix-checks': <WrenchIcon aria-hidden="true" />,
}

/** One policy entry → one button, clicking through to the parent's mutation switch. A disabled
 *  entry shows the policy's reason as its tooltip. */
function ActionButton({
  action,
  variant,
  onAction,
  className,
}: {
  action: GitAction
  variant: 'primary' | 'outline'
  onAction: (id: GitActionId) => void
  className?: string
}) {
  return (
    <Button
      variant={variant}
      size="sm"
      data-action={action.id}
      className={className}
      disabled={!action.enabled}
      title={action.enabled ? undefined : action.reason}
      onClick={() => onAction(action.id)}
    >
      {GIT_ACTION_ICONS[action.id]}
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
