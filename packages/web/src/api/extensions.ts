import { useEffect } from 'react'
import { hashKey, useQuery, useQueryClient } from '@tanstack/react-query'
import type { HealthResponse, ExtensionPlacementLocation, ExtensionChatSelectionInput, ExtensionChatSelectionPreview } from '@open-mercato/cezar-api-client'
import { subscribeTopic } from './ws'
import { cez, unwrap } from './client'
import { queryKeys } from './queries'

const extensions = cez.api.v1.p[':projectId'].extensions
/** How long a stream of run patches is left to settle before extension panels refetch. */
export const EXTENSION_PANEL_REFETCH_DEBOUNCE_MS = 1000
export const extensionKeys = {
  all: (projectId: string) => ['extensions', projectId] as const,
  inventory: (projectId: string) => [...extensionKeys.all(projectId), 'inventory'] as const,
  list: (projectId: string) => [...extensionKeys.all(projectId), 'list'] as const,
  /** One cockpit surface's contributions; under `all` so the WS tick refreshes it too. */
  placements: (projectId: string, location: ExtensionPlacementLocation) => [...extensionKeys.all(projectId), 'placements', location] as const,
  panel: (projectId: string, extensionId: string, panelId: string) => [...extensionKeys.all(projectId), extensionId, 'panels', panelId] as const,
  /** Every `task` panel of one run shares this prefix, so a run's SSE tick refetches them in one call. */
  taskPanels: (projectId: string, runId: string) => [...extensionKeys.all(projectId), 'task-panels', runId] as const,
  taskPanel: (projectId: string, runId: string, extensionId: string, panelId: string) => [...extensionKeys.taskPanels(projectId, runId), extensionId, panelId] as const,
}
/** How every surface shows and keys a contribution: `<extensionId>/<localId>` (spec 2026-11-07-extension-placements; collision-free). */
export const qualifiedExtensionId = (extensionId: string, localId: string) => `${extensionId}/${localId}`
export async function listExtensions(projectId: string) {
  return unwrap(await extensions.access.$get({ param: { projectId } }), '/extensions')
}
export async function listExtensionInventory(projectId: string, signal?: AbortSignal) {
  return unwrap(await extensions.inventory.$get({ param: { projectId } }, { init: { signal } }), '/extensions/inventory')
}
export async function loadUninstallImpact(extensionId: string, signal?: AbortSignal) {
  return unwrap(await cez.api.v1.extensions[':extensionId']['uninstall-impact'].$get({ param: { extensionId } }, { init: { signal } }), '/extensions/uninstall-impact')
}
export async function listExtensionPlacements(projectId: string, location: ExtensionPlacementLocation) {
  return unwrap(await extensions.placements.$get({ param: { projectId }, query: { location } }), '/extensions/placements')
}
export async function prepareExtension(source: string) {
  return unwrap(await cez.api.v1.extensions['prepare-install'].$post({ json: { source } }), '/extensions/prepare-install')
}
export async function commitExtension(preparedId: string) {
  return unwrap(await cez.api.v1.extensions['commit-install'].$post({ json: { preparedId } }), '/extensions/commit-install')
}
export async function enableExtension(projectId: string, extensionId: string, enabled: boolean, integrity?: string) {
  const route = extensions[':extensionId']
  return enabled
    ? unwrap(await route.enable.$post({ param: { projectId, extensionId }, json: { integrity: integrity ?? '' } }), '/extensions/enable')
    : unwrap(await route.disable.$post({ param: { projectId, extensionId } }), '/extensions/disable')
}
export async function uninstallExtension(projectId: string, extensionId: string, impactRevision: string, removeData = false) {
  return unwrap(await cez.api.v1.extensions[':extensionId'].$delete({ param: { extensionId }, query: { impactRevision, removeData: removeData ? 'true' : 'false' } }), '/extensions')
}
export async function loadExtensionPanel(projectId: string, extensionId: string, panelId: string, runId?: string) {
  // `query` is required by the typed client (runId); an empty one only appends a bare `?`.
  return unwrap(await extensions[':extensionId'].panels[':panelId'].$get({ param: { projectId, extensionId, panelId }, query: runId ? { runId } : {} }), '/extensions/panels')
}
export async function runExtensionCommand(projectId: string, extensionId: string, commandId: string, input?: Record<string, unknown>, runId?: string) {
  const result = await unwrap(await extensions[':extensionId'].commands[':commandId'].invoke.$post({ param: { projectId, extensionId, commandId }, json: { input, ...(runId ? { runId } : {}) } }), '/extensions/commands/invoke')
  if (!result.ok) throw new Error(result.message ?? 'Extension command failed')
  return result
}

export async function loadExtensionForms(projectId: string, extensionId: string) {
  return unwrap(await extensions[':extensionId'].forms.$get({ param: { projectId, extensionId } }), '/extensions/forms')
}

export async function prepareExtensionUpdate(extensionId: string) { return unwrap(await cez.api.v1.extensions[':extensionId']['prepare-update'].$post({ param: { extensionId } }), '/extensions/prepare-update') }

/** Settings → Extensions is a GLOBAL section (`routes/settings/registry.tsx`). */
const EXTENSIONS_SETTINGS_PATH = '/settings/global/extensions'
/** Selects the project (and focuses the extension's row): the global page cannot infer it. */
export function extensionSettingsHref(projectId: string, extensionId?: string) {
  return `${EXTENSIONS_SETTINGS_PATH}?${new URLSearchParams({ project: projectId, ...(extensionId ? { extension: extensionId } : {}) })}`
}

/** The ONE `extensions` subscription, mounted at the root like health (AGENTS.md § Real-time events);
 *  a change frame names no project, so it re-reads every project's extension queries. Local-only:
 *  extensions on implies a local cockpit, and a hosted one must open no browser WebSocket. */
export function useExtensionSubscription() {
  const client = useQueryClient()
  // Reads the health cache like useHealthSubscription: a root hook must not start its own health fetch.
  useEffect(() => {
    let release: (() => void) | undefined
    const sync = () => {
      const live = client.getQueryData<HealthResponse>(queryKeys.health)?.capabilities?.extensions === true
      if (live && !release) release = subscribeTopic('extensions', () => { void client.invalidateQueries({ queryKey: ['extensions'] }) })
      else if (!live && release) { release(); release = undefined }
    }
    sync()
    // Only health decides the topic; every run patch and dashboard tick also notifies this cache.
    const releaseCache = client.getQueryCache().subscribe(event => { if (event.query.queryHash === hashKey(queryKeys.health)) sync() })
    return () => { releaseCache(); release?.() }
  }, [client])
}

/** The enabled extensions contributing to one surface. `enabled: false` (capability off, hosted)
 *  issues no request — the surfaces hide instead of asking a server that would answer `[]`. */
export function useExtensionPlacements(projectId: string, location: ExtensionPlacementLocation, enabled = true) {
  return useQuery({
    queryKey: extensionKeys.placements(projectId, location),
    queryFn: () => listExtensionPlacements(projectId, location),
    enabled,
  })
}

/** A preview is read-only and abortable; a commit always carries its reviewed revision. */
export async function previewChatSelection(projectId: string, provider: ExtensionChatSelectionPreview['provider'], input: ExtensionChatSelectionInput, signal?: AbortSignal) {
  return unwrap(await extensions['chat-selections'][':provider'].preview.$post({ param: { projectId, provider }, json: input }, { init: { signal } }), '/extensions/chat-selections/preview')
}
export async function selectChatImplementation(projectId: string, provider: ExtensionChatSelectionPreview['provider'], input: Parameters<typeof extensions['chat-selections'][':provider']['select']['$post']>[0]['json']) {
  return unwrap(await extensions['chat-selections'][':provider'].select.$post({ param: { projectId, provider }, json: input }), '/extensions/chat-selections/select')
}
