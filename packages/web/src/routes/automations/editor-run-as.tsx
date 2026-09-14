import { WorkflowIcon } from 'lucide-react'

import { EnginePills, type EnginePick } from '@/components/engine-pills'
import { PickerPill } from '@/components/picker-pill'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

/**
 * The "runs as" row of What to run (spec 2026-09-14-automations-redesign § UI/UX 4.4): the
 * composer's own pills — workflow, runner + model (`EnginePills`, so the automation cannot pick
 * a backend the Inbox could not), the read-only base branch — and the Autonomous switch on the
 * right.
 */
export function EditorRunAs({
  workflow,
  workflows,
  onWorkflow,
  pick,
  onPick,
  baseBranch,
  autonomous,
  onAutonomous,
}: {
  workflow: string
  /** The catalog's names; the current value is kept even when the catalog lacks it. */
  workflows: readonly string[]
  onWorkflow: (workflow: string) => void
  pick: EnginePick
  onPick: (pick: EnginePick) => void
  baseBranch: string | undefined
  autonomous: boolean
  onAutonomous: (autonomous: boolean) => void
}) {
  const names = workflows.includes(workflow) ? workflows : [workflow, ...workflows]
  return (
    <div data-slot="editor-run-as" className="flex flex-wrap items-center gap-2">
      <PickerPill
        slot="editor-workflow-pill"
        ariaLabel="Workflow"
        label={<><WorkflowIcon aria-hidden="true" className="size-3" />{workflow}</>}
        value={workflow}
        options={names.map((name) => ({ value: name, label: name }))}
        onPick={onWorkflow}
      />
      <EnginePills pick={pick} onChange={onPick} />
      <PickerPill
        slot="editor-base-pill"
        ariaLabel="Base branch"
        readOnly
        hint="Every run branches off the project's base branch."
        label={<span className="font-mono text-[11.5px]">base: {baseBranch ?? '…'}</span>}
        value={baseBranch ?? ''}
        options={[]}
        onPick={() => undefined}
      />
      <span className="flex-1" />
      <Label className="text-[13px] font-medium">
        Autonomous
        <Switch aria-label="Autonomous" checked={autonomous} onCheckedChange={onAutonomous} />
      </Label>
    </div>
  )
}
