import { AlertTriangleIcon, CheckCircle2Icon, CopyIcon, DownloadIcon, SparklesIcon, Trash2Icon, UploadIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'

import { TONE } from './graph-node'
import { Field } from './inspector'

/**
 * The workflow's own panel — everything about the file rather than one node of it, in three tabs:
 * Details (what it is, and what the server says is wrong with it), YAML (the file as it would be
 * written: copy, export, import) and Generate (a canvas built from a description).
 */
export function WorkflowPanel({
  description,
  onDescription,
  issues,
  unwired,
  onIssue,
  yaml,
  onExport,
  importText,
  onImportText,
  onImport,
  importing,
  planText,
  onPlanText,
  onPlan,
  planning,
  onDelete,
  deleting,
}: {
  description: string
  onDescription: (value: string) => void
  issues: readonly string[]
  unwired: readonly string[]
  /** Show the node an issue names, when it names one. */
  onIssue: (issue: string) => void
  yaml: string
  onExport: () => void
  importText: string
  onImportText: (value: string) => void
  onImport: () => void
  importing: boolean
  planText: string
  onPlanText: (value: string) => void
  onPlan: () => void
  planning: boolean
  /** Only for a workflow saved as a file in this repo. */
  onDelete?: () => void
  deleting: boolean
}) {
  return (
    <Tabs defaultValue="details" className="flex h-full min-h-0 flex-col gap-0">
      <TabsList variant="line" className="h-10 w-full shrink-0 justify-start gap-4 border-b border-border/70 px-4">
        <TabsTrigger value="details" className="flex-none px-0 text-[13px]">
          Details
          {issues.length > 0 ? <span className="ml-1 text-xs tabular-nums text-danger">{issues.length}</span> : null}
        </TabsTrigger>
        <TabsTrigger value="yaml" className="flex-none px-0 text-[13px]">
          YAML
        </TabsTrigger>
        <TabsTrigger value="generate" className="flex-none px-0 text-[13px]">
          Generate
        </TabsTrigger>
      </TabsList>

      <TabsContent value="details" className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-5 p-4 text-[13px]">
          <Field label="description">
            <Textarea value={description} rows={3} onChange={(event) => onDescription(event.target.value)} />
          </Field>
          <section className="flex flex-col gap-1.5">
            <h3 className="text-xs font-medium text-foreground">Validation</h3>
            {issues.length === 0 ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <CheckCircle2Icon className="size-3.5 text-success" />
                The server validated this workflow.
              </p>
            ) : (
              <ul className="flex flex-col overflow-hidden rounded-lg border border-border/70">
                {issues.map((issue) => (
                  <li key={issue} className="border-b border-border/70 last:border-b-0">
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-auto w-full items-start justify-start gap-2 rounded-none px-2.5 py-2 text-left text-xs font-normal whitespace-normal text-foreground"
                      title="Show on the canvas"
                      onClick={() => onIssue(issue)}
                    >
                      <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" style={{ color: TONE.failure }} />
                      <span className="min-w-0 break-words">{issue}</span>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {unwired.length > 0 ? (
              <p className="text-xs text-pretty text-muted-foreground">
                Unwired ports end the run: <span className="font-mono text-[11px]">{unwired.join(', ')}</span>
              </p>
            ) : null}
          </section>
        </div>
      </TabsContent>

      <TabsContent value="yaml" className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-5 p-4 text-[13px]">
          <section className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-medium text-foreground">The file as it stands</h3>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => {
                    void navigator.clipboard?.writeText(yaml)
                    toast('Copied the YAML')
                  }}
                >
                  <CopyIcon /> Copy
                </Button>
                <Button type="button" variant="ghost" size="xs" aria-label="Export YAML" onClick={onExport}>
                  <DownloadIcon /> Export
                </Button>
              </div>
            </div>
            <pre className="max-h-72 overflow-auto rounded-lg border border-border/70 bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
              {yaml}
            </pre>
          </section>
          <section className="flex flex-col gap-2">
            <Field label="import YAML (v1 or v2) — replaces the canvas">
              <Textarea
                value={importText}
                onChange={(event) => onImportText(event.target.value)}
                rows={5}
                className="font-mono text-xs"
                placeholder="paste a workflow file…"
              />
            </Field>
            <Button size="sm" variant="outline" className="self-start" disabled={!importText.trim() || importing} onClick={onImport}>
              <UploadIcon /> Import
            </Button>
          </section>
        </div>
      </TabsContent>

      <TabsContent value="generate" className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-2 p-4 text-[13px]">
          <Field label="build from a description — replaces the canvas">
            <Textarea
              value={planText}
              onChange={(event) => onPlanText(event.target.value)}
              rows={6}
              placeholder="implement, run the tests, then review…"
            />
          </Field>
          <Button size="sm" variant="outline" className="self-start" disabled={!planText.trim() || planning} onClick={onPlan}>
            <SparklesIcon /> {planning ? 'Building…' : 'Build workflow'}
          </Button>
          <p className="text-xs text-pretty text-muted-foreground">
            The planner proposes a chain of steps and opens it here. Nothing is saved until you press Save.
          </p>
        </div>
      </TabsContent>

      {onDelete ? (
        <div className="flex shrink-0 justify-end border-t border-border/70 px-4 py-2.5">
          <Button size="sm" variant="danger-ghost" disabled={deleting} onClick={onDelete}>
            <Trash2Icon /> Delete workflow
          </Button>
        </div>
      ) : null}
    </Tabs>
  )
}
