import { GitBranchIcon, WrapTextIcon } from 'lucide-react'

import type { DiffMode } from '@/components/diff'
import { Toggle } from '@/components/ui/toggle'

/**
 * The diff view's local controls, extracted from the Changes toolbar (R5 1.7) so the repo
 * view renders the SAME unified/split + wrap toggles and branch chip rather than a fork.
 * Layout preferences, not git actions — no policy involvement. Callers own the "hidden
 * below md" wrapper, because phones force unified+wrap and hide these entirely.
 */
export function DiffViewToggles({
  mode,
  wrap,
  onModeChange,
  onWrapChange,
}: {
  mode: DiffMode
  wrap: boolean
  onModeChange: (mode: DiffMode) => void
  onWrapChange: (wrap: boolean) => void
}) {
  return (
    <>
      <span
        data-slot="diff-mode-toggle"
        role="group"
        aria-label="Diff layout"
        className="flex items-center rounded-md border border-border p-0.5"
      >
        <ModeButton current={mode} value="unified" onModeChange={onModeChange} />
        <ModeButton current={mode} value="split" onModeChange={onModeChange} />
      </span>
      <Toggle
        size="sm"
        data-slot="wrap-toggle"
        pressed={wrap}
        onPressedChange={onWrapChange}
        aria-label="Wrap long lines"
        title="Wrap long lines"
        className="size-8 min-w-8 shrink-0 px-0 text-muted-foreground hover:text-foreground active:translate-y-px data-[state=on]:bg-muted data-[state=on]:text-foreground"
      >
        <WrapTextIcon aria-hidden="true" />
      </Toggle>
    </>
  )
}

function ModeButton({
  current,
  value,
  onModeChange,
}: {
  current: DiffMode
  value: DiffMode
  onModeChange: (mode: DiffMode) => void
}) {
  const active = current === value
  return (
    <Toggle
      type="button"
      data-mode={value}
      pressed={active}
      onPressedChange={() => onModeChange(value)}
      className="h-auto min-w-0 rounded-[5px] px-2 py-0.5 text-[11px] capitalize text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-muted data-[state=on]:text-foreground"
    >
      {value}
    </Toggle>
  )
}

/** The mono branch chip both git toolbars lead with. */
export function BranchChip({ branch }: { branch: string }) {
  return (
    <span
      data-slot="branch-chip"
      className="flex min-w-0 items-center gap-1 rounded-sm border border-border bg-card px-1.5 py-px font-mono text-[11px] font-medium"
    >
      <GitBranchIcon aria-hidden="true" className="size-3 shrink-0" />
      <span className="truncate">{branch}</span>
    </span>
  )
}
