import { FileCogIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { ApiError } from '@/api/client'
import { useAgentConfig, useAgentConfigFile, useHealth, usePutAgentConfigFile } from '@/api/queries'
import type { AgentConfigFile, AgentConfigListing, Runner } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { CodeEditor } from '@/components/code-editor'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { availableRunners } from '@/routes/new-task-form'
import { cn } from '@/lib/utils'
import { AGENT_DESCRIPTORS, descriptorFor, type AgentDescriptor } from './agent-descriptors'

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

/** What this file actually governs for a run — the honest label the spec insists on. */
function effectLabel(file: AgentConfigFile): string {
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
    return (
      <p data-slot="agent-config-loading" className="p-4 text-[13px] text-soft-foreground md:p-6">
        Loading agent config…
      </p>
    )
  }
  if (listing.isError) {
    return (
      <CenteredState
        icon={<FileCogIcon />}
        tone="danger"
        title="Agent config did not load"
        subtitle={listing.error.message}
        heading="h2"
      />
    )
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
    <div data-slot="agent-config" className="flex flex-col gap-4 p-4 md:p-6">
      {!listing.editable && (
        <div
          data-slot="agent-config-readonly"
          className="rounded-md border border-border bg-muted/40 px-3 py-2 text-[13px] text-soft-foreground"
        >
          Read-only: agent config is edited from the machine that owns the checkout (this cockpit runs in hosted
          mode). You can still see every file and which one wins.
        </div>
      )}

      <div data-slot="agent-config-agents" role="tablist" className="flex flex-wrap gap-1 rounded-md bg-muted/40 p-1">
        {AGENT_DESCRIPTORS.map((d) => (
          <button
            key={d.id}
            type="button"
            role="tab"
            aria-selected={d.id === agent.id}
            data-slot="agent-config-agent"
            data-agent={d.id}
            data-selected={d.id === agent.id}
            onClick={() => pickAgent(d.id)}
            className={cn(
              'flex items-center gap-2 rounded-md px-3 py-1.5 text-[13px] transition-colors',
              d.id === agent.id ? 'bg-background font-semibold shadow-sm' : 'hover:bg-muted/60',
            )}
          >
            {d.label}
            {!installed.includes(d.id) && (
              <Badge variant="outline" className="text-[10px] text-soft-foreground">
                not installed
              </Badge>
            )}
          </button>
        ))}
      </div>

      {agent.note && (
        <p data-slot="agent-config-agent-note" className="text-[12px] text-soft-foreground">
          {agent.note}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <nav data-slot="agent-config-nav" className="flex flex-col gap-5">
          <AgentPane
            agent={agent}
            listing={listing}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        </nav>

        <div data-slot="agent-config-editor-pane">
          {selected ? (
            <FileEditor key={selected.id} file={selected} />
          ) : (
            <div className="flex h-full min-h-40 items-center justify-center rounded-md border border-dashed border-border text-[13px] text-soft-foreground">
              Select a config file to view or edit it.
            </div>
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
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-soft-foreground">
              {g.label}
            </p>
            {g.note && <p className="mb-2 text-[12px] text-soft-foreground">{g.note}</p>}
            <ul className="flex flex-col gap-1">
              {files.map((file) => (
                <li key={file.id}>
                  <button
                    type="button"
                    data-slot="agent-config-file"
                    data-selected={file.id === selectedId}
                    onClick={() => onSelect(file.id)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors',
                      file.id === selectedId ? 'bg-primary/15 text-foreground' : 'hover:bg-muted/60',
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{file.label}</span>
                    {file.seeded && (
                      <Badge variant="outline" className="shrink-0 text-[10px]">
                        seeded
                      </Badge>
                    )}
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
    <div data-slot="agent-config-user-mcp" className="mt-3">
      <h4 className="mb-1 text-[12px] font-semibold">User &amp; local scopes</h4>
      <p className="mb-2 text-[12px] text-soft-foreground">
        Managed by <code className="font-mono">claude mcp add</code> in {userMcp.path} — cezar does not edit
        Claude’s state file.
      </p>
      {userMcp.readable ? (
        userMcp.servers.length > 0 ? (
          <ul className="flex flex-wrap gap-1">
            {userMcp.servers.map((name) => (
              <li key={name}>
                <Badge variant="outline" className="font-mono text-[11px]">
                  {name}
                </Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12px] text-soft-foreground">No user-scoped MCP servers.</p>
        )
      ) : (
        <p className="text-[12px] text-soft-foreground">Could not read the file.</p>
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
      setDraft(fileQuery.data.content)
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
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[13px]">{file.label}</span>
        <Badge variant="outline" className="text-[10px] uppercase">
          {file.format}
        </Badge>
        <a
          href={file.docsUrl}
          target="_blank"
          rel="noreferrer"
          className="text-[12px] text-soft-foreground underline hover:text-foreground"
        >
          docs
        </a>
      </div>

      <p data-slot="agent-config-precedence" className="text-[12px] text-soft-foreground">
        {file.precedence}
      </p>
      <p data-slot="agent-config-effect" className="text-[12px] text-foreground/80">
        {effectLabel(file)}
        {file.hotReload ? ` ${file.hotReload}` : ''}
      </p>

      {fileQuery.isPending ? (
        <p className="text-[13px] text-soft-foreground">Loading file…</p>
      ) : fileQuery.isError ? (
        <p className="text-[13px] text-destructive">{fileQuery.error.message}</p>
      ) : (
        <CodeEditor
          value={content}
          language={file.format}
          readOnly={!canWrite}
          onChange={setDraft}
          aria-label={`${file.label} contents`}
          className="h-[26rem]"
        />
      )}

      {formatError && (
        <p data-slot="agent-config-format-error" className="text-[12px] text-destructive">
          {formatError}
        </p>
      )}
      {conflict && (
        <div
          data-slot="agent-config-conflict"
          className="flex items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px]"
        >
          <span>The file changed on disk since you opened it.</span>
          <Button size="sm" variant="outline" onClick={() => void fileQuery.refetch()}>
            Reload from disk
          </Button>
        </div>
      )}

      {canWrite && (
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={save} disabled={!dirty || put.isPending}>
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
          {dirty && <span className="text-[12px] text-soft-foreground">Unsaved changes</span>}
        </div>
      )}
    </div>
  )
}
