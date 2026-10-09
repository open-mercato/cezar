import { ExternalLinkIcon, FileCogIcon, FileIcon, LockIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { ApiError } from '@/api/client'
import { useAgentConfig, useAgentConfigFile, useHealth, usePutAgentConfigFile } from '@/api/queries'
import type { AgentConfigFile, AgentConfigListing, Runner } from '@open-mercato/cezar-api-client'
import { CodeEditor } from '@/components/code-editor'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { toast } from '@/components/ui/toaster'
import { availableRunners } from '@/routes/new-task-form'
import { cn } from '@/lib/utils'
import { AGENT_DESCRIPTORS, descriptorFor, type AgentDescriptor } from './agent-descriptors'
import { SettingsError, SettingsLoading } from './settings-field'

/**
 * Settings → Agent config (spec #404, regrouped per
 * 2026-07-17-agent-config-by-agent): read and edit the coding agents' OWN config
 * files — raw, per scope, highlighted — grouped BY AGENT. An agent selector
 * first; the selected agent's pane holds its Settings, MCP and Memory files
 * together, driven by the per-agent descriptor table. cezar never re-serializes;
 * it shows each scope's file and the vendor's own documented precedence, and
 * never claims a merge it does not perform. Writing is a local-machine
 * capability: in hosted mode the whole section is read-only (the server refuses
 * every write regardless).
 */

/**
 * What an absent private MCP file opens on (spec 2026-10-07-private-project-mcp): the `.mcp.json`
 * shape with placeholders that cannot run anything — the file reaches every agent launch the moment
 * it is saved, so an example `npx -y <package>` would fetch and execute whatever owns that name.
 */
const PRIVATE_MCP_STARTER = `{
  "mcpServers": {
    "example-stdio": {
      "command": "/absolute/path/to/your-mcp-server",
      "args": [],
      "env": { "API_TOKEN": "your-personal-token" }
    },
    "example-http": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer your-personal-token" }
    }
  }
}
`

/** What this file actually governs for a run — the honest label the spec insists on. */
function effectLabel(file: AgentConfigFile): string {
  if (file.private) return 'Private to this project — added to every run at launch, takes effect on the next session. Never committed.'
  if (file.seeded) return 'Copied into each run’s worktree — takes effect on your next run.'
  if (file.tracked === 'tracked') return 'Runs read the committed copy — this edit applies after you commit it.'
  if (file.tracked === 'outside-repo') return 'Applies to every session on this machine.'
  return 'Personal, git-ignored.'
}

export function AgentConfigSection() {
  const listing = useAgentConfig()
  const health = useHealth()
  const installed = useMemo<Runner[]>(
    () => (health.data ? availableRunners(health.data.checks) : AGENT_DESCRIPTORS.map((d) => d.id)),
    [health.data],
  )

  if (listing.isPending) {
    return <SettingsLoading data-slot="agent-config-loading" label="Loading agent config…" />
  }
  if (listing.isError) {
    return <SettingsError title="Agent config did not load">{listing.error.message}</SettingsError>
  }
  return <AgentConfigView listing={listing.data} installed={installed} />
}

function AgentConfigView({ listing, installed }: { listing: AgentConfigListing; installed: Runner[] }) {
  const [agentId, setAgentId] = useState<Runner>('claude')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const agent = descriptorFor(agentId)
  const selected = listing.files.find((f) => f.id === selectedId) ?? null

  const pickAgent = (id: Runner) => {
    setAgentId(id)
    setSelectedId(null) // a file selection never survives an agent switch
  }

  return (
    <div data-slot="agent-config" className="flex flex-col gap-5">
      {!listing.editable && (
        <Alert data-slot="agent-config-readonly">
          <LockIcon aria-hidden="true" />
          <AlertDescription>
            Read-only: agent config is edited from the machine that owns the checkout (this cockpit runs in hosted
            mode). You can still see every file and which one wins.
          </AlertDescription>
        </Alert>
      )}

      <Tabs value={agent.id} onValueChange={(id) => pickAgent(id as Runner)} className="gap-2">
        <div className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0">
          <TabsList data-slot="agent-config-agents">
            {AGENT_DESCRIPTORS.map((d) => (
              <TabsTrigger
                key={d.id}
                value={d.id}
                data-slot="agent-config-agent"
                data-agent={d.id}
                data-selected={d.id === agent.id}
                title={installed.includes(d.id) ? undefined : `${d.label} is not installed`}
                className={cn(!installed.includes(d.id) && 'text-soft-foreground')}
              >
                {d.label}
                {!installed.includes(d.id) && <span className="sr-only">not installed</span>}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        {!installed.includes(agent.id) && (
          <p className="text-xs text-muted-foreground">{agent.label} is not installed on this machine.</p>
        )}
        {agent.note && (
          <p data-slot="agent-config-agent-note" className="max-w-prose text-[13px] text-pretty text-muted-foreground">
            {agent.note}
          </p>
        )}
      </Tabs>

      <div className="grid items-start gap-5 lg:grid-cols-[17rem_minmax(0,1fr)]">
        <nav data-slot="agent-config-nav" className="flex flex-col gap-6">
          <AgentPane
            agent={agent}
            listing={listing}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        </nav>

        <div data-slot="agent-config-editor-pane" className="min-w-0">
          {selected ? (
            <FileEditor key={selected.id} file={selected} />
          ) : (
            <Empty className="min-h-64 rounded-xl border border-dashed border-border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FileCogIcon />
                </EmptyMedia>
                <EmptyTitle>No file selected</EmptyTitle>
                <EmptyDescription>Select a config file to view or edit it.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>
      </div>
    </div>
  )
}

function AgentPane({
  agent,
  listing,
  selectedId,
  onSelect,
}: {
  agent: AgentDescriptor
  listing: AgentConfigListing
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  return (
    <>
      {agent.groups.map((g) => {
        const files = listing.files.filter(g.files)
        const isClaudeMcp = agent.id === 'claude' && g.id === 'mcp'
        if (files.length === 0 && !(isClaudeMcp && listing.userMcp)) return null
        return (
          <section key={g.id} data-slot="agent-config-group" data-group={g.id} data-agent={agent.id}>
            <h3 className="px-2 text-[13px] font-semibold text-foreground">{g.label}</h3>
            {g.note && <p className="mt-0.5 px-2 text-xs text-pretty text-muted-foreground">{g.note}</p>}
            <ul className="mt-1.5 flex flex-col gap-0.5">
              {files.map((file) => (
                <li key={file.id}>
                  <button
                    type="button"
                    data-slot="agent-config-file"
                    data-selected={file.id === selectedId}
                    aria-current={file.id === selectedId ? 'true' : undefined}
                    onClick={() => onSelect(file.id)}
                    className={cn(
                      'flex min-h-8 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
                      file.id === selectedId ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                      !file.exists && file.id !== selectedId && 'text-soft-foreground',
                    )}
                  >
                    <FileIcon aria-hidden="true" className="size-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs" title={file.label}>{file.label}</span>
                    {file.seeded && <span className="shrink-0 text-[11px] text-muted-foreground">seeded</span>}
                    {file.private && <span className="shrink-0 text-[11px] text-muted-foreground">private</span>}
                    {!file.exists && <span className="shrink-0 text-[11px] text-soft-foreground">absent</span>}
                  </button>
                </li>
              ))}
            </ul>
            {isClaudeMcp && listing.userMcp && <UserMcpBlock userMcp={listing.userMcp} />}
          </section>
        )
      })}
    </>
  )
}

/** Claude's user/local MCP scopes live in ~/.claude.json (Claude's own state
 *  file) — listed read-only; cezar never edits it. */
function UserMcpBlock({ userMcp }: { userMcp: NonNullable<AgentConfigListing['userMcp']> }) {
  return (
    <div data-slot="agent-config-user-mcp" className="mt-4 px-2">
      <h4 className="text-[13px] font-medium">User &amp; local scopes</h4>
      <p className="mt-0.5 mb-2 text-xs text-pretty text-muted-foreground">
        Managed by <code className="font-mono">claude mcp add</code> in {userMcp.path} — cezar does not edit
        Claude’s state file.
      </p>
      {userMcp.readable ? (
        userMcp.servers.length > 0 ? (
          <ul className="flex flex-wrap gap-1">
            {userMcp.servers.map((name) => (
              <li key={name}>
                <Badge variant="secondary" className="font-mono text-[11px] font-normal">
                  {name}
                </Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">No user-scoped MCP servers.</p>
        )
      ) : (
        <p className="text-xs text-muted-foreground">Could not read the file.</p>
      )}
    </div>
  )
}

export function FileEditor({ file }: { file: AgentConfigFile }) {
  const fileQuery = useAgentConfigFile(file.id)
  const put = usePutAgentConfigFile(file.id)
  const [draft, setDraft] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [formatError, setFormatError] = useState<string | null>(null)

  // Seed the draft from the server contents; re-seed when the file's version changes underneath.
  const loadedVersion = fileQuery.data?.version ?? null
  useEffect(() => {
    if (fileQuery.data) {
      // An absent private MCP file opens on a starter in the `.mcp.json` shape rather than a blank page.
      setDraft(file.private && !fileQuery.data.exists ? PRIVATE_MCP_STARTER : fileQuery.data.content)
      setConflict(false)
      setFormatError(null)
    }
  }, [fileQuery.data?.version, fileQuery.data])

  const content = draft ?? fileQuery.data?.content ?? ''
  const dirty = fileQuery.data ? content !== fileQuery.data.content : false
  const canWrite = file.writable

  const save = () => {
    setFormatError(null)
    setConflict(false)
    put.mutate(
      { content, version: loadedVersion },
      {
        onSuccess: () => {
          setDraft(null)
          toast(`${file.exists ? 'Saved' : 'Created'} ${file.label}`)
        },
        onError: (err) => {
          if (err instanceof ApiError && err.status === 409) setConflict(true)
          else if (err instanceof ApiError && err.status === 400) setFormatError(err.message)
          else toast((err as Error).message, { tone: 'danger' })
        },
      },
    )
  }

  return (
    <Card flush>
      <div className="flex flex-col gap-1.5 border-b border-border px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[13px] font-medium break-all">{file.label}</span>
          <Badge variant="secondary" className="font-mono text-[11px] font-normal">
            {file.format}
          </Badge>
          <a
            href={file.docsUrl}
            target="_blank"
            rel="noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            docs
            <ExternalLinkIcon aria-hidden="true" className="size-3" />
          </a>
        </div>
        <p data-slot="agent-config-effect" className="text-[13px] text-pretty text-foreground">
          {effectLabel(file)}
          {file.hotReload ? ` ${file.hotReload}` : ''}
        </p>
        <p data-slot="agent-config-precedence" className="text-xs text-pretty text-muted-foreground">
          {file.precedence}
        </p>
      </div>

      {fileQuery.isPending ? (
        <div role="status" aria-label="Loading file…" className="p-5">
          <Skeleton className="h-64 w-full" />
        </div>
      ) : fileQuery.isError ? (
        <div className="p-5">
          <SettingsError title="The file did not load">{fileQuery.error.message}</SettingsError>
        </div>
      ) : (
        <CodeEditor
          value={content}
          language={file.format}
          readOnly={!canWrite}
          onChange={setDraft}
          aria-label={`${file.label} contents`}
          className="h-[26rem] rounded-none border-0 shadow-none"
        />
      )}

      {formatError || conflict || canWrite ? (
        <div className="flex flex-col gap-3 border-t border-border px-5 py-3.5">
          {formatError && (
            <p data-slot="agent-config-format-error" className="text-[13px] text-destructive">
              {formatError}
            </p>
          )}
          {conflict && (
            <SettingsError
              data-slot="agent-config-conflict"
              title="The file changed on disk since you opened it."
              action={
                <Button size="sm" variant="outline" onClick={() => void fileQuery.refetch()}>
                  Reload from disk
                </Button>
              }
            />
          )}
          {canWrite && (
            <div className="flex items-center gap-2">
              <Button size="sm" variant="default" onClick={save} disabled={!dirty || put.isPending}>
                {file.exists ? 'Save' : 'Create'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setDraft(null)}
                disabled={!dirty || put.isPending}
              >
                Revert
              </Button>
              {dirty && <span className="text-xs text-muted-foreground">Unsaved changes</span>}
            </div>
          )}
        </div>
      ) : null}
    </Card>
  )
}
