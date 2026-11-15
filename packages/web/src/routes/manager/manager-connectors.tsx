import { ChevronRightIcon, RefreshCwIcon } from 'lucide-react'
import { useState } from 'react'

import { useManagerConnectors, useRefreshManagerConnectors } from '@/api/managers'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { toast } from '@/components/ui/toaster'
import { managerTimeLabel } from '@/lib/managers'
import { cn } from '@/lib/utils'
import {
  managerConnectorToolMode,
  type ManagerConnectorInfo,
  type ManagerConnectorLevel,
  type ManagerConnectorToolMode,
  type ManagerConnectors,
  type ManagerSummary,
} from '@open-mercato/cezar-api-client'

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const LEVELS: ReadonlyArray<{ level: ManagerConnectorLevel; label: string }> = [
  { level: 'off', label: 'Off' },
  { level: 'read', label: 'Read' },
  { level: 'write', label: 'Read+write' },
]

const MODE_LABEL: Record<ManagerConnectorToolMode, string> = { deny: 'Denied', ask: 'Asks you first', allow: 'Allowed' }

type Override = ManagerConnectorToolMode | 'default'

export function setConnectorLevel(grants: ManagerConnectors, key: string, level: ManagerConnectorLevel): ManagerConnectors {
  return { ...grants, [key]: { ...grants[key], level } }
}

export function setConnectorToolOverride(grants: ManagerConnectors, key: string, tool: string, override: Override): ManagerConnectors {
  const grant = grants[key] ?? { level: 'off' as const }
  const { [tool]: _dropped, ...rest } = grant.tools ?? {}
  const tools = override === 'default' ? rest : { ...rest, [tool]: override }
  const { tools: _old, ...base } = grant
  return { ...grants, [key]: Object.keys(tools).length > 0 ? { ...base, tools } : base }
}

/** What Save sends: the whole map, unlisted connectors included; an off grant with no overrides is the same as none. */
export function savedConnectors(grants: ManagerConnectors): ManagerConnectors {
  return Object.fromEntries(Object.entries(grants).filter(([, grant]) => grant.level !== 'off' || Object.keys(grant.tools ?? {}).length > 0))
}

function LevelControl({ name, value, onChange }: { name: string; value: ManagerConnectorLevel; onChange: (level: ManagerConnectorLevel) => void }) {
  return (
    <div role="radiogroup" aria-label={`${name} access`} className="inline-flex shrink-0 rounded-md border border-border p-0.5">
      {LEVELS.map(({ level, label }) => (
        <button
          key={level}
          type="button"
          role="radio"
          aria-checked={value === level}
          onClick={() => onChange(level)}
          className={cn(
            'rounded-sm px-2 py-0.5 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-9',
            value === level && 'bg-muted font-medium text-foreground',
          )}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

function ConnectorRow({
  server,
  grants,
  onChange,
}: {
  server: ManagerConnectorInfo
  grants: ManagerConnectors
  onChange: (grants: ManagerConnectors) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const grant = grants[server.key]
  const level = grant?.level ?? 'off'
  const connected = server.status === 'connected'
  return (
    <li data-slot="manager-connector" data-key={server.key} className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">{server.name}</span>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground" title={server.status}>
            <StatusDot tone={connected ? 'success' : 'neutral'} />
            {connected ? 'connected' : 'unavailable'}
          </span>
        </div>
        <LevelControl name={server.name} value={level} onChange={(next) => onChange(setConnectorLevel(grants, server.key, next))} />
      </div>
      {server.tools.length > 0 ? (
        <button
          type="button"
          aria-expanded={expanded}
          className="flex items-center gap-1 self-start rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          onClick={() => setExpanded((open) => !open)}
        >
          <ChevronRightIcon aria-hidden="true" className={cn('size-3.5 transition-transform', expanded && 'rotate-90')} />
          {server.tools.length} {server.tools.length === 1 ? 'tool' : 'tools'}
        </button>
      ) : null}
      {expanded ? (
        <ul className="flex flex-col gap-1">
          {server.tools.map((tool) => {
            const override = grant?.tools?.[tool.name] ?? 'default'
            // From the draft, not the response: the row answers what Save would make of it.
            const mode = managerConnectorToolMode(grant, tool.name)
            return (
              <li key={tool.name} data-slot="manager-connector-tool" className="flex flex-wrap items-center gap-2 text-xs">
                <code className="min-w-0 flex-1 truncate font-mono">{tool.name}</code>
                <span className="text-muted-foreground">{tool.kind}</span>
                <span data-slot="manager-connector-tool-mode" className="w-24 text-muted-foreground">{MODE_LABEL[mode]}</span>
                <Select
                  value={override}
                  disabled={level === 'off'}
                  onValueChange={(value) => onChange(setConnectorToolOverride(grants, server.key, tool.name, value as Override))}
                >
                  <SelectTrigger size="sm" aria-label={`${tool.name} permission`} className="h-7 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">default</SelectItem>
                    <SelectItem value="deny">deny</SelectItem>
                    <SelectItem value="ask">ask</SelectItem>
                    <SelectItem value="allow">{tool.kind === 'write' ? 'allow without asking' : 'allow'}</SelectItem>
                  </SelectContent>
                </Select>
              </li>
            )
          })}
        </ul>
      ) : null}
    </li>
  )
}

/** Spec 2026-11-12-manager-connectors: which MCP servers a manager may use, and how. */
export function ConnectorsDialog({
  manager,
  open,
  onOpenChange,
  onSave,
  onCloseAutoFocus,
}: {
  manager: ManagerSummary
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (connectors: ManagerConnectors) => Promise<unknown>
  onCloseAutoFocus?: (event: Event) => void
}) {
  const query = useManagerConnectors(manager.id, open)
  const refresh = useRefreshManagerConnectors(manager.id)
  const [grants, setGrants] = useState<ManagerConnectors>(() => manager.connectors ?? {})
  const [saving, setSaving] = useState(false)
  const data = query.data
  const save = () => {
    setSaving(true)
    void onSave(savedConnectors(grants)).then(
      () => onOpenChange(false),
      (error: unknown) => toast(errorMessage(error), { tone: 'danger' }),
    ).finally(() => setSaving(false))
  }
  const runRefresh = () => refresh.mutate(undefined, { onError: (error) => toast(errorMessage(error), { tone: 'danger' }) })
  const unavailable = data?.available === false
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-slot="manager-connectors"
        className="grid max-h-[85dvh] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-xl"
        {...(onCloseAutoFocus ? { onCloseAutoFocus } : {})}
      >
        <DialogHeader>
          <DialogTitle>Connectors</DialogTitle>
          <DialogDescription>
            claude.ai connectors and MCP servers this manager may use. Read tools run on their own; write tools ask you first.
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-1 flex min-h-0 flex-col gap-3 overflow-y-auto overscroll-contain px-1 py-1">
          <div className="flex items-center gap-2">
            <p className="flex-1 text-xs text-muted-foreground">
              {data?.observedAt ? `Seen ${managerTimeLabel(data.observedAt)}` : null}
            </p>
            <Button type="button" variant="outline" size="sm" disabled={refresh.isPending || unavailable} onClick={runRefresh}>
              <RefreshCwIcon aria-hidden="true" className={cn(refresh.isPending && 'animate-spin motion-reduce:animate-none')} />
              Refresh
            </Button>
          </div>
          {query.isPending ? <p className="text-sm text-muted-foreground">Loading connectors…</p> : null}
          {query.isError ? <p role="alert" className="text-sm text-danger">{errorMessage(query.error)}</p> : null}
          {unavailable ? (
            <p data-slot="manager-connectors-unavailable" className="text-sm text-muted-foreground">
              Only Claude Code managers can use connectors.{data.reason ? ` ${data.reason}` : ''}
            </p>
          ) : null}
          {data && !unavailable && data.servers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No connectors seen yet — Refresh to discover</p>
          ) : null}
          {data && !unavailable && data.servers.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {data.servers.map((server) => <ConnectorRow key={server.key} server={server} grants={grants} onChange={setGrants} />)}
            </ul>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={saving} onClick={save}>Save connectors</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
