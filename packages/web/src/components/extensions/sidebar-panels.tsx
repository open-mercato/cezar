import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRightIcon } from 'lucide-react'
import { useCallback, useEffect, useRef } from 'react'
import { Link } from 'react-router'
import type { ApiRun, ExtensionPlacement, WorkspaceUiState } from '@open-mercato/cezar-api-client'

import { putWorkspaceUiState } from '@/api/client'
import { EXTENSION_PANEL_REFETCH_DEBOUNCE_MS, extensionKeys, extensionSettingsHref, loadExtensionPanel, qualifiedExtensionId, runExtensionCommand, useExtensionPlacements } from '@/api/extensions'
import { useHealth, useRuns, useWorkspaceUiState, workspaceQueryKeys } from '@/api/queries'
import { ExtensionCommandOutcome, useExtensionCommandResult, type ExtensionCommandOutcomeValue } from '@/components/extensions/command-outcome'
import { ExtensionPanelView } from '@/components/extensions/panel'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { cn } from '@/lib/utils'
import { LoadingState, RowsSkeleton } from '@/components/loading-state'

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}
/** Only boolean entries: a hand-edited value never becomes a truthy collapse. */
function asCollapsedMap(value: unknown): Record<string, boolean> {
  return Object.fromEntries(Object.entries(asRecord(value)).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'))
}

/** A section is shut unless the user opened it: a new panel never widens the sidebar on its own. */
export function isSidebarPanelCollapsed(state: WorkspaceUiState | undefined, key: string): boolean {
  return state?.sidebarExtensionPanels?.collapsed?.[key] ?? true
}

/** Open sections are workspace ui-state; the PUT carries the whole object so a newer cockpit's keys survive. */
function useSidebarPanelCollapse() {
  const queryClient = useQueryClient()
  const uiState = useWorkspaceUiState()
  const toggle = useCallback(
    (key: string) => {
      const current = queryClient.getQueryData<WorkspaceUiState>(workspaceQueryKeys.uiState)
      // Until the authoritative GET lands a write could not preserve its siblings; the toggle waits.
      if (current === undefined) return
      const siblings = asRecord(current.sidebarExtensionPanels)
      const collapsed = { ...asCollapsedMap(siblings.collapsed), [key]: !isSidebarPanelCollapsed(current, key) }
      const sidebarExtensionPanels = { ...siblings, collapsed }
      queryClient.setQueryData<WorkspaceUiState>(workspaceQueryKeys.uiState, { ...current, sidebarExtensionPanels })
      putWorkspaceUiState({ sidebarExtensionPanels }).then(
        (merged) => queryClient.setQueryData<WorkspaceUiState>(workspaceQueryKeys.uiState, merged),
        (error: unknown) => {
          toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
          void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.uiState })
        },
      )
    },
    [queryClient],
  )
  return { state: uiState.data, toggle }
}

const runProgress = (runs: ApiRun[]) => runs.map((run) => `${run.id}:${run.status}`).join(',')

/** Panels are pulled, never pushed: re-read (debounced) when a task's status changes. */
export function useSidebarPanelRefresh(projectId: string, enabled: boolean) {
  const queryClient = useQueryClient()
  const progress = useRuns(runProgress, enabled).data
  const seen = useRef(progress)
  useEffect(() => {
    if (!enabled || progress === undefined || seen.current === progress) return
    const first = seen.current === undefined
    seen.current = progress
    if (first) return
    const timer = setTimeout(() => {
      // Sidebar panels key as [..all, extensionId, 'panels', panelId]; task panels stay with their run.
      void queryClient.invalidateQueries({ queryKey: extensionKeys.all(projectId), predicate: (query) => query.queryKey[3] === 'panels' })
    }, EXTENSION_PANEL_REFETCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [enabled, progress, projectId, queryClient])
}

/** Enabled extensions' `sidebar` panels (spec 2026-11-07-extension-placements); renders nothing without any. */
export function SidebarExtensionPanels({ projectId }: { projectId: string }) {
  const allowed = useHealth().data?.capabilities?.extensions === true
  const placements = useExtensionPlacements(projectId, 'sidebar', allowed)
  const { state, toggle } = useSidebarPanelCollapse()
  const { result, show, dismiss } = useExtensionCommandResult()
  const extensions = allowed && placements.data?.available ? placements.data.extensions : []
  useSidebarPanelRefresh(projectId, extensions.length > 0)
  if (extensions.length === 0) return null
  return (
    <div data-slot="sidebar-extension-panels" className="flex flex-col gap-0.5 px-2.5 pb-2">
      {extensions.map((extension) =>
        extension.status === 'failed' ? (
          <FailedExtension key={extension.extensionId} projectId={projectId} extension={extension} />
        ) : (
          extension.panels.map((panel) => {
            const key = qualifiedExtensionId(extension.extensionId, panel.id)
            const collapsed = isSidebarPanelCollapsed(state, key)
            const bodyId = `sidebar-extension-panel-${key.replace(/[^A-Za-z0-9_-]/g, '-')}`
            return (
              <section key={key} data-slot="sidebar-extension-panel" data-extension-panel={key} data-collapsed={collapsed ? '' : undefined} aria-label={panel.title}>
                <button
                  type="button"
                  onClick={() => toggle(key)}
                  aria-expanded={!collapsed}
                  aria-controls={collapsed ? undefined : bodyId}
                  // Disabled until the ui-state cache exists: a write without it could drop siblings.
                  disabled={state === undefined}
                  title={`${extension.name} · ${key}`}
                  className="flex h-11 w-full items-center gap-2 rounded-md px-2.5 text-ui font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-60 md:h-[30px]"
                >
                  <ChevronRightIcon aria-hidden="true" className={cn('size-3.5 shrink-0 transition-transform', !collapsed && 'rotate-90')} />
                  <span className="min-w-0 flex-1 truncate text-left">{panel.title}</span>
                </button>
                {collapsed ? null : (
                  <div id={bodyId} className="mb-1 ml-[14px] border-l border-border pl-2 pr-1 text-sm">
                    <SidebarPanelBody projectId={projectId} extensionId={extension.extensionId} panelId={panel.id} onOutcome={(outcome) => show(key, outcome)} />
                    <ExtensionCommandOutcome projectId={projectId} result={result?.extensionId === key ? result : undefined} onDismiss={dismiss} />
                  </div>
                )}
              </section>
            )
          })
        ),
      )}
    </div>
  )
}

/** A stopped worker keeps its place: one line saying so, and the way to fix it (spec 2026-11-07-extension-placements). */
function FailedExtension({ projectId, extension }: { projectId: string; extension: ExtensionPlacement }) {
  return (
    <section data-slot="sidebar-extension-failed" data-extension-id={extension.extensionId} aria-label={extension.name} className="flex flex-col gap-1 rounded-md border border-danger/40 bg-danger/5 px-2.5 py-2 text-xs">
      {/* Always mounted: an alert would re-announce on every navigation while the worker stays down. */}
      <p role="status" className="text-danger [overflow-wrap:anywhere]">
        <span className="font-medium">{extension.name}</span>: {extension.error ?? 'the extension stopped'}
      </p>
      <Link to={extensionSettingsHref(projectId, extension.extensionId)} className="text-muted-foreground underline-offset-2 hover:underline">Open Settings → Extensions</Link>
    </section>
  )
}

function SidebarPanelBody({ projectId, extensionId, panelId, onOutcome }: { projectId: string; extensionId: string; panelId: string; onOutcome: (outcome: ExtensionCommandOutcomeValue) => void }) {
  const queryClient = useQueryClient()
  const panel = useQuery({ queryKey: extensionKeys.panel(projectId, extensionId, panelId), queryFn: () => loadExtensionPanel(projectId, extensionId, panelId) })
  if (panel.isPending) return <LoadingState label="Loading panel…" className="py-1"><RowsSkeleton rows={1} /></LoadingState>
  if (panel.isError) {
    return (
      <div className="flex flex-col gap-1 py-1">
        <p role="alert" className="text-xs text-danger">{panel.error.message}</p>
        <Button size="sm" variant="outline" className="self-start" onClick={() => void panel.refetch()}>Retry panel</Button>
      </div>
    )
  }
  return (
    <ExtensionPanelView
      panel={panel.data}
      compact
      onAction={async (actionId) => {
        onOutcome(await runExtensionCommand(projectId, extensionId, actionId))
        await queryClient.invalidateQueries({ queryKey: extensionKeys.all(projectId) })
      }}
    />
  )
}
