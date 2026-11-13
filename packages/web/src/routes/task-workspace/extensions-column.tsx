import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PuzzleIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import type { ApiRun, ExtensionPlacement } from '@open-mercato/cezar-api-client'

import { EXTENSION_PANEL_REFETCH_DEBOUNCE_MS, extensionKeys, extensionSettingsHref, loadExtensionPanel, qualifiedExtensionId, runExtensionCommand, useExtensionPlacements } from '@/api/extensions'
import { useHealth } from '@/api/queries'
import { CenteredState } from '@/components/centered-state'
import { ExtensionCommandOutcome, useExtensionCommandResult, type ExtensionCommandOutcomeValue } from '@/components/extensions/command-outcome'
import { ExtensionPanelView } from '@/components/extensions/panel'
import { Button } from '@/components/ui/button'
import { LoadingState, RowsSkeleton } from '@/components/loading-state'

const NO_EXTENSIONS: ExtensionPlacement[] = []

/** The `extensions` view's contributors and shared outcome slot (spec 2026-11-07-extension-placements). */
export function useExtensionTaskView(projectId: string | null, run: ApiRun) {
  const queryClient = useQueryClient()
  const scope = projectId ?? 'default'
  const allowed = useHealth().data?.capabilities?.extensions === true
  const placements = useExtensionPlacements(scope, 'task', allowed)
  const extensions = allowed && placements.data?.available ? placements.data.extensions : NO_EXTENSIONS
  const available = extensions.length > 0
  const { result, show, dismiss } = useExtensionCommandResult()
  // Only a status or step change is a reason to re-read task panels — not every SSE patch (token
  // counters, diff stats) and not the first render.
  const progress = `${run.status}|${run.finishedAt ?? ''}|${run.steps.map((step) => step.status).join(',')}`
  const seen = useRef(progress)
  useEffect(() => {
    if (!available || seen.current === progress) return
    seen.current = progress
    const timer = setTimeout(() => {
      void queryClient.invalidateQueries({ queryKey: extensionKeys.taskPanels(scope, run.id) })
    }, EXTENSION_PANEL_REFETCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [available, queryClient, progress, run.id, scope])
  return useMemo(() => ({ projectId: scope, extensions, available, result, show, dismiss }), [scope, extensions, available, result, show, dismiss])
}

export type ExtensionTaskView = ReturnType<typeof useExtensionTaskView>

/** The `task` commands as the column header's buttons, each run with this task's id. */
export function ExtensionTaskCommands({ view, runId }: { view: ExtensionTaskView; runId: string }) {
  const queryClient = useQueryClient()
  const command = useMutation({
    mutationFn: ({ extension, commandId }: { extension: ExtensionPlacement; commandId: string }) =>
      runExtensionCommand(view.projectId, extension.extensionId, commandId, undefined, runId),
    onSuccess: async (outcome, { extension, commandId }) => {
      view.show(qualifiedExtensionId(extension.extensionId, commandId), outcome)
      await queryClient.invalidateQueries({ queryKey: extensionKeys.taskPanels(view.projectId, runId) })
    },
  })
  const buttons = view.extensions.flatMap((extension) =>
    // A failed worker's commands cannot run; its card in the column says so.
    extension.status === 'failed' ? [] : extension.commands.map((entry) => ({ extension, entry })),
  )
  if (buttons.length === 0) return null
  return (
    <div data-slot="extension-task-commands" className="flex min-w-0 items-center gap-1">
      {buttons.map(({ extension, entry }) => {
        const qualified = qualifiedExtensionId(extension.extensionId, entry.id)
        const running = command.isPending && command.variables?.extension.extensionId === extension.extensionId && command.variables.commandId === entry.id
        return (
          <Button
            key={qualified}
            type="button"
            size="xs"
            variant="outline"
            data-slot="extension-task-command"
            data-extension-command={qualified}
            disabled={command.isPending}
            title={`${extension.name}: ${entry.title}`}
            onClick={() => command.mutate({ extension, commandId: entry.id })}
            className="max-w-40 truncate"
          >
            {running ? 'Running…' : entry.title}
          </Button>
        )
      })}
      <HeaderError error={command.error} />
    </div>
  )
}

/** The header's command failure, visible: the column body may be scrolled away from the top. */
function HeaderError({ error }: { error: Error | null }) {
  const [dismissed, setDismissed] = useState<Error | null>(null)
  if (!error || dismissed === error) return null
  return (
    <p role="alert" className="min-w-0">
      <button type="button" onClick={() => setDismissed(error)} title={`${error.message} — click to dismiss`} className="max-w-48 truncate text-xs text-danger">
        {error.message}
      </button>
    </p>
  )
}

/** One card per `task` panel, each with its own loading and error state so one broken extension stays contained. */
export function ExtensionsColumn({ view, run }: { view: ExtensionTaskView; run: ApiRun }) {
  if (!view.available) {
    return (
      <CenteredState
        icon={<PuzzleIcon />}
        tone="neutral"
        heading="h2"
        title="No extension panels for this task"
        subtitle="An enabled extension that contributes a task panel or command shows it here."
        actions={
          <Button asChild variant="outline">
            <Link to={extensionSettingsHref(view.projectId)}>Open Settings → Extensions</Link>
          </Button>
        }
      />
    )
  }
  return (
    <div data-slot="extensions-column" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
      <ExtensionCommandOutcome projectId={view.projectId} result={view.result} onDismiss={view.dismiss} />
      {view.extensions.map((extension) =>
        extension.status === 'failed' ? (
          <FailedCard key={extension.extensionId} projectId={view.projectId} extension={extension} />
        ) : (
          extension.panels.map((panel) => (
            <TaskPanelCard
              key={qualifiedExtensionId(extension.extensionId, panel.id)}
              projectId={view.projectId}
              runId={run.id}
              extension={extension}
              panelId={panel.id}
              onOutcome={(outcome) => view.show(qualifiedExtensionId(extension.extensionId, panel.id), outcome)}
            />
          ))
        ),
      )}
    </div>
  )
}

function FailedCard({ projectId, extension }: { projectId: string; extension: ExtensionPlacement }) {
  return (
    <section data-slot="extension-task-failed" data-extension-id={extension.extensionId} aria-label={extension.name} className="flex flex-col gap-1 rounded-lg border border-danger/40 bg-danger/5 p-3 text-sm">
      <p role="alert" className="text-danger">
        <span className="font-medium">{extension.name}</span>: {extension.error ?? 'the extension stopped'}
      </p>
      <Link to={extensionSettingsHref(projectId, extension.extensionId)} className="text-xs text-muted-foreground underline-offset-2 hover:underline">Open Settings → Extensions</Link>
    </section>
  )
}

function TaskPanelCard({ projectId, runId, extension, panelId, onOutcome }: { projectId: string; runId: string; extension: ExtensionPlacement; panelId: string; onOutcome: (outcome: ExtensionCommandOutcomeValue) => void }) {
  const queryClient = useQueryClient()
  const qualified = qualifiedExtensionId(extension.extensionId, panelId)
  const panel = useQuery({
    queryKey: extensionKeys.taskPanel(projectId, runId, extension.extensionId, panelId),
    queryFn: () => loadExtensionPanel(projectId, extension.extensionId, panelId, runId),
  })
  return (
    <div data-slot="extension-task-panel" data-extension-panel={qualified} title={`${extension.name} · ${qualified}`}>
      {panel.isPending ? (
        <LoadingState label={`Loading ${extension.name}…`} className="rounded-lg border border-dashed border-border p-4"><RowsSkeleton rows={2} /></LoadingState>
      ) : panel.isError ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-4">
          <p role="alert" className="text-sm text-danger">{extension.name}: {panel.error.message}</p>
          <Button size="sm" variant="outline" className="self-start" onClick={() => void panel.refetch()}>Retry panel</Button>
        </div>
      ) : (
        <ExtensionPanelView
          panel={panel.data}
          onAction={async (actionId) => {
            onOutcome(await runExtensionCommand(projectId, extension.extensionId, actionId, undefined, runId))
            await queryClient.invalidateQueries({ queryKey: extensionKeys.taskPanels(projectId, runId) })
          }}
        />
      )}
    </div>
  )
}
