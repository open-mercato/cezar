import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import type { ExtensionTaskProposal } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { newTaskPrefillHref } from '@/routes/new-task-params'

/** One extension command's result — a message, proposed tasks, or neither — shown where it was
 *  run. The ONE feedback path for every surface (Settings, palette, sidebar, task view), so a
 *  proposal reads and links the same wherever the command lived (spec 2026-11-07-extension-placements, "Cockpit surfaces"). */
type ExtensionCommandResult = {
  extensionId: string
  proposals: ExtensionTaskProposal[]
  message?: string
  /** Monotonic, so an identical outcome run twice still re-announces. */
  seq: number
}

export type ExtensionCommandOutcomeValue = { message?: string; proposals?: ExtensionTaskProposal[] }

/** The result slot's state: `show` records an outcome under the extension that produced it. */
export function useExtensionCommandResult() {
  const [result, setResult] = useState<ExtensionCommandResult>()
  const seq = useRef(0)
  const show = useCallback((extensionId: string, outcome: ExtensionCommandOutcomeValue) => {
    setResult({ extensionId, proposals: outcome.proposals ?? [], ...(outcome.message ? { message: outcome.message } : {}), seq: ++seq.current })
  }, [])
  const dismiss = useCallback(() => setResult(undefined), [])
  return { result, show, dismiss }
}

export function ExtensionCommandOutcome({ projectId, result, onDismiss }: { projectId: string; result?: ExtensionCommandResult; onDismiss: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { if (result?.proposals.length) heading.current?.focus() }, [result])
  // The live region is always mounted, so screen readers announce what lands in it.
  return <div role="status" aria-live="polite" data-slot="extension-command-outcome">
    {result && !result.proposals.length && <p className="rounded-md border border-success/50 bg-success/10 p-2 text-sm">{result.message ?? 'Done. No tasks were proposed.'}</p>}
    {result && !!result.proposals.length && <section aria-labelledby={`proposals-${result.extensionId}`} className="flex flex-col gap-2 rounded-md border border-border bg-muted/40 p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <h3 ref={heading} tabIndex={-1} id={`proposals-${result.extensionId}`} className="font-medium outline-none">{result.proposals.length === 1 ? 'Proposed task' : `${result.proposals.length} proposed tasks`}</h3>
        <Button size="sm" variant="ghost" onClick={onDismiss}>Dismiss</Button>
      </div>
      {result.message ? <p className="text-muted-foreground">{result.message}</p> : null}
      <ul className="flex flex-col gap-2">{result.proposals.map((proposal, index) => <li key={index} className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 [overflow-wrap:anywhere]">{proposal.title}</span>
        <Button asChild size="sm" variant="outline"><Link to={`/p/${encodeURIComponent(projectId)}${newTaskPrefillHref({ ref: proposal.prompt, workflow: proposal.workflow })}`}>Review task before starting</Link></Button>
      </li>)}</ul>
    </section>}
  </div>
}
