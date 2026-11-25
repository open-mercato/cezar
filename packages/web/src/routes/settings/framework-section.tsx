import type { FrameworkFile, FrameworkStage, FrameworkSummary, StageAvailability } from '@open-mercato/cezar-api-client'
import { ArrowLeftIcon, CopyIcon, DownloadIcon, LayersIcon, WorkflowIcon } from 'lucide-react'
import * as React from 'react'
import { useSearchParams } from 'react-router'

import { useDuplicateFramework, useFramework, useFrameworks, useInstallFramework, usePutProjectFramework } from '@/api/frameworks'
import { CenteredState } from '@/components/centered-state'
import { LoadingState, SettingsSkeleton } from '@/components/loading-state'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { toast } from '@/components/ui/toaster'
import { cn } from '@/lib/utils'
import { SettingsCard } from './form-row'

const CompiledGraph = React.lazy(() => import('../cards/compiled-graph').then((m) => ({ default: m.CompiledGraph })))

/**
 * Settings → Project → Framework (spec 2026-11-15-framework-board, mockups 5–6): which framework
 * new cards use. Detection only fills the default (D6); picking writes an explicit choice, and
 * "Back to automatic" removes it. `?framework=<id>` opens the read-only detail.
 */
export function FrameworkSection() {
  const [params, setParams] = useSearchParams()
  const id = params.get('framework')
  const open = (next: string | null) =>
    setParams((current) => {
      const out = new URLSearchParams(current)
      if (next) out.set('framework', next)
      else out.delete('framework')
      return out
    })
  return id ? <FrameworkDetail id={id} onBack={() => open(null)} onOpen={open} /> : <FrameworkChooser onOpenDetail={open} />
}

const SOURCE_LABEL = { explicit: 'chosen', detected: 'detected', fallback: 'automatic' } as const

/** The stage line of a framework: `Plan → Build → Review`. */
function stageLine(stages: readonly { id: string; name: string }[]): string {
  return stages.map((s) => s.name).join(' → ')
}

function availabilityLine(fw: FrameworkSummary): { text: string; missing: boolean } {
  if (fw.error) return { text: fw.error, missing: true }
  const a = fw.availability
  const n = fw.stages.length
  const count = `${n} ${n === 1 ? 'stage' : 'stages'}`
  if (!a) return { text: count, missing: false }
  if (a.found >= a.total) return { text: `${count} · all skills and commands found`, missing: false }
  return { text: `${count} · ${a.total - a.found} of ${a.total} skills or commands not found in this repo`, missing: true }
}

/** The list of frameworks and the choice (mockup 5). Also the board's empty state. */
export function FrameworkChooser({ onOpenDetail, embedded = false }: { onOpenDetail?: (id: string) => void; embedded?: boolean }) {
  const frameworks = useFrameworks()
  const put = usePutProjectFramework()
  const [duplicating, setDuplicating] = React.useState<string | null>(null)
  const [installing, setInstalling] = React.useState<{ fw: FrameworkSummary; thenUse: boolean } | null>(null)

  if (frameworks.isPending) {
    return (
      <LoadingState label="Loading frameworks…" data-slot="frameworks-loading">
        <SettingsSkeleton />
      </LoadingState>
    )
  }
  if (frameworks.isError) {
    return <CenteredState icon={<LayersIcon />} tone="danger" heading="h2" title="Frameworks did not load" subtitle={frameworks.error.message} />
  }
  const { active } = frameworks.data
  const activeName = frameworks.data.frameworks.find((f) => f.id === active.id)?.name ?? active.id
  const choose = (framework: string | null) =>
    put.mutate(framework, {
      onError: (error: Error) => toast(error.message, { tone: 'danger' }),
    })

  return (
    <div data-slot="framework-chooser" className="flex flex-col gap-4">
      <SettingsCard
        title="Framework for this project"
        description="Applies to new cards. In-flight cards keep the framework they started with."
        action={
          active.source === 'explicit' ? (
            <Button type="button" variant="outline" size="sm" data-action="framework-automatic" disabled={put.isPending} onClick={() => choose(null)}>
              Back to automatic
            </Button>
          ) : null
        }
      >
        <p data-slot="framework-active" className="px-4 py-3 text-label text-muted-foreground">
          {active.source === 'detected' ? (
            <>
              🔎 This repo looks like <strong className="text-foreground">{activeName}</strong> — found{' '}
              <code className="font-mono text-meta [overflow-wrap:anywhere]">{active.detectedBy}</code>, so new cards use it. Pick another to override.
            </>
          ) : active.source === 'explicit' ? (
            <>
              New cards use <strong className="text-foreground">{activeName}</strong> — your choice. “Back to automatic” lets
              detection decide again.
            </>
          ) : (
            <>
              No framework detected — new cards use <strong className="text-foreground">{activeName}</strong>, so the board always
              works.
            </>
          )}
        </p>
      </SettingsCard>

      <ul className="flex flex-col gap-2.5" aria-label="Frameworks">
        {frameworks.data.frameworks.map((fw) => {
          const inUse = fw.id === active.id
          const avail = availabilityLine(fw)
          const installable = Boolean(fw.availability?.installable && fw.install && avail.missing && !fw.error)
          return (
            <li
              key={fw.id}
              data-framework-id={fw.id}
              data-in-use={inUse || undefined}
              className={cn('rounded-[10px] border bg-card px-4 py-3', inUse ? 'border-primary/60' : 'border-border')}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-ui font-semibold text-foreground">{fw.name}</span>
                {inUse ? (
                  <span data-slot="framework-in-use" className="rounded-full bg-primary/15 px-2 py-px text-micro font-medium text-primary">
                    in use · {SOURCE_LABEL[active.source]}
                  </span>
                ) : null}
                {fw.provisional ? <span className="rounded-full bg-muted px-2 py-px text-micro text-muted-foreground">provisional</span> : null}
                {fw.source === 'project' ? (
                  <span className="max-w-full rounded-full bg-muted px-2 py-px text-micro [overflow-wrap:anywhere] text-muted-foreground">project · {fw.path}</span>
                ) : null}
                <span className="ml-auto flex flex-wrap gap-1.5">
                  {onOpenDetail && !fw.error ? (
                    <Button type="button" variant="ghost" size="sm" onClick={() => onOpenDetail(fw.id)}>
                      Details
                    </Button>
                  ) : null}
                  {!embedded && !fw.error ? (
                    <Button type="button" variant="ghost" size="sm" onClick={() => setDuplicating(fw.id)}>
                      <CopyIcon className="size-3.5" aria-hidden="true" />
                      Duplicate
                    </Button>
                  ) : null}
                  {installable ? (
                    <Button type="button" variant="outline" size="sm" data-action="framework-install" onClick={() => setInstalling({ fw, thenUse: false })}>
                      <DownloadIcon className="size-3.5" aria-hidden="true" />
                      Install into this repo
                    </Button>
                  ) : null}
                  {!(inUse && active.source === 'explicit') && !fw.error ? (
                    <Button
                      type="button"
                      variant={inUse ? 'outline' : 'primary'}
                      size="sm"
                      data-action="framework-use"
                      disabled={put.isPending}
                      onClick={() => (installable ? setInstalling({ fw, thenUse: true }) : choose(fw.id))}
                    >
                      {installable ? 'Install & use' : 'Use'} {fw.name}
                    </Button>
                  ) : null}
                </span>
              </div>
              {fw.description ? <p className="mt-1 text-label text-muted-foreground">{fw.description}</p> : null}
              {fw.stages.length > 0 ? <p className="mt-1.5 font-mono text-meta [overflow-wrap:anywhere] text-foreground">{stageLine(fw.stages)}</p> : null}
              <p data-slot="framework-availability" className={cn('mt-1 text-meta', avail.missing ? 'text-danger' : 'text-muted-foreground')}>
                {avail.text}
              </p>
              {duplicating === fw.id ? <DuplicateForm id={fw.id} onDone={() => setDuplicating(null)} /> : null}
            </li>
          )
        })}
      </ul>
      {installing ? (
        <InstallFrameworkDialog
          key={installing.fw.id}
          fw={installing.fw}
          thenUse={installing.thenUse}
          onInstalled={() => {
            if (installing.thenUse) choose(installing.fw.id)
          }}
          onClose={() => setInstalling(null)}
        />
      ) : null}
      {!embedded ? (
        <p className="text-meta text-muted-foreground">
          Duplicates are saved to <code className="font-mono">.ai/cezar/frameworks/</code> — commit them to share with the team.
        </p>
      ) : null}
    </div>
  )
}

/**
 * "Install into this repo": confirm what is downloaded and written, then progress, then the
 * result. Cards fork from the base branch, so committing there is the default when it is checked out.
 */
export function InstallFrameworkDialog({
  fw,
  thenUse,
  onInstalled,
  onClose,
}: {
  fw: FrameworkSummary
  thenUse: boolean
  onInstalled: () => void
  onClose: () => void
}) {
  const install = useInstallFramework()
  const info = fw.install!
  const canCommit = info.currentBranch !== null && info.currentBranch === info.baseBranch
  const [commit, setCommit] = React.useState(canCommit)
  const result = install.data
  const run = () =>
    install.mutate(
      { id: fw.id, commit: canCommit && commit },
      { onSuccess: () => onInstalled() },
    )
  return (
    <Dialog open onOpenChange={(open) => !open && !install.isPending && onClose()}>
      <DialogContent data-slot="framework-install-dialog" className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{result ? `${fw.name} installed` : `Install ${fw.name} into this repo?`}</DialogTitle>
          <DialogDescription>
            {result ? (
              (result.note ?? (result.committed ? 'Committed.' : 'Left uncommitted.'))
            ) : (
              <>
                Downloads <strong className="text-foreground">{info.source}</strong> at{' '}
                <code className="font-mono">{info.ref}</code> from GitHub and runs its installer in this repo.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div data-slot="framework-install-result" className="flex flex-col gap-2 text-label">
            <p className="text-muted-foreground">
              {result.changedPaths.length
                ? `${result.changedPaths.length} ${result.changedPaths.length === 1 ? 'file' : 'files'} changed${result.committed ? ' and committed' : ''}:`
                : 'No files changed.'}
            </p>
            {result.changedPaths.length ? (
              <ul className="max-h-40 overflow-auto rounded-md bg-muted/40 px-3 py-2 font-mono text-meta">
                {result.changedPaths.map((p) => (
                  <li key={p} className="break-all">
                    {p}
                  </li>
                ))}
              </ul>
            ) : null}
            {result.output ? (
              <pre className="max-h-40 overflow-auto rounded-md bg-muted/40 px-3 py-2 font-mono text-meta whitespace-pre-wrap">{result.output}</pre>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-2.5 text-label">
            <p className="text-muted-foreground">It writes:</p>
            <ul data-slot="framework-install-writes" className="rounded-md bg-muted/40 px-3 py-2 font-mono text-meta">
              {info.writes.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                data-action="framework-install-commit"
                className="mt-0.5"
                checked={canCommit && commit}
                disabled={!canCommit || install.isPending}
                onChange={(event) => setCommit(event.target.checked)}
              />
              <span>
                Commit on <code className="font-mono">{info.baseBranch ?? 'the base branch'}</code>
                <span className="block text-meta text-muted-foreground">
                  {canCommit
                    ? 'Cards run in worktrees off this branch — uncommitted skills are invisible to them.'
                    : `You are on ${info.currentBranch ?? 'a detached HEAD'}, so the files are left uncommitted; commit them on ${info.baseBranch ?? 'the base branch'} before cards can use them.`}
                </span>
              </span>
            </label>
            {install.isPending ? (
              <p data-slot="framework-install-progress" className="flex items-center gap-2 text-muted-foreground">
                <Spinner className="size-3.5" /> Downloading and running the installer…
              </p>
            ) : null}
            {install.isError ? (
              <p data-slot="framework-install-error" role="alert" className="text-danger">
                {install.error.message}
              </p>
            ) : null}
          </div>
        )}

        <DialogFooter>
          {result ? (
            <Button type="button" size="sm" onClick={onClose}>
              Done
            </Button>
          ) : (
            <>
              <Button type="button" variant="ghost" size="sm" disabled={install.isPending} onClick={onClose}>
                Cancel
              </Button>
              <Button type="button" size="sm" data-action="framework-install-confirm" disabled={install.isPending} onClick={run}>
                {install.isError ? 'Try again' : thenUse ? `Install & use` : 'Install'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** "Duplicate as project framework" — an inline id field; native prompts are banned here. */
function DuplicateForm({ id, onDone, onCreated }: { id: string; onDone: () => void; onCreated?: (id: string) => void }) {
  const duplicate = useDuplicateFramework()
  const [newId, setNewId] = React.useState(`${id}-copy`)
  const valid = /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(newId)
  return (
    <form
      data-slot="framework-duplicate"
      className="mt-2.5 flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (!valid) return
        duplicate.mutate(
          { id, newId },
          {
            onSuccess: (out) => {
              toast(`Saved to ${out.path} — commit it to share with the team.`)
              onCreated?.(out.id)
              onDone()
            },
            onError: (error: Error) => toast(error.message, { tone: 'danger' }),
          },
        )
      }}
    >
      <label className="text-meta text-muted-foreground" htmlFor={`dup-${id}`}>
        New id
      </label>
      <Input id={`dup-${id}`} value={newId} onChange={(event) => setNewId(event.target.value)} className="h-8 w-56" aria-invalid={!valid} />
      <Button type="submit" size="sm" disabled={!valid || duplicate.isPending}>
        Save copy
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={onDone}>
        Cancel
      </Button>
    </form>
  )
}

function gateText(stage: FrameworkStage, names: Map<string, number>): string {
  const parts: string[] = []
  if (stage.gate?.kind === 'approve') {
    parts.push('⏸ approve')
    if (stage.gate.onReject) parts.push(`changes → ${(names.get(stage.gate.onReject) ?? 0) + 1}`)
  } else if (stage.gate?.kind === 'framework') {
    parts.push(stage.gate.approve ? `⏸ framework approve ${stage.gate.approve}` : '⏸ owner confirms')
  }
  for (const [verdict, target] of Object.entries(stage.onVerdict ?? {})) {
    parts.push(`${verdict} → ${(names.get(target) ?? 0) + 1} (max ${stage.loopMax ?? 2})`)
  }
  if (stage.checks?.length) parts.push(`checks: ${stage.checks.join(', ')}`)
  if (stage.wip) parts.push(`WIP ${stage.wip}`)
  return parts.join(' · ') || '—'
}

function modeText(stage: FrameworkStage): string {
  const mode = stage.mode === 'conversation' ? '💬 conversation' : 'autonomous'
  return stage.review ? `${mode} · reviewer` : mode
}

/** The per-stage table, YAML and compiled graph of one framework (mockup 6). */
export function FrameworkDetail({ id, onBack, onOpen }: { id: string; onBack: () => void; onOpen?: (id: string) => void }) {
  const detail = useFramework(id)
  const [graphOpen, setGraphOpen] = React.useState(false)
  const [duplicating, setDuplicating] = React.useState(false)

  const back = (
    <Button type="button" variant="ghost" size="sm" onClick={onBack} className="self-start">
      <ArrowLeftIcon className="size-3.5" aria-hidden="true" />
      All frameworks
    </Button>
  )
  if (detail.isPending) {
    return (
      <div className="flex flex-col gap-3">
        {back}
        <LoadingState label="Loading framework…">
          <SettingsSkeleton />
        </LoadingState>
      </div>
    )
  }
  if (detail.isError) {
    return (
      <div className="flex flex-col gap-3">
        {back}
        <CenteredState icon={<LayersIcon />} tone="danger" heading="h2" title="Framework did not load" subtitle={detail.error.message} />
      </div>
    )
  }
  const { framework, yaml, stages, graph, source } = detail.data
  const index = new Map(framework.stages.map((s, i) => [s.id, i]))
  const availability = new Map(stages.map((s) => [s.stage, s]))

  return (
    <div data-slot="framework-detail" data-framework-id={framework.id} className="flex flex-col gap-4">
      {back}
      <SettingsCard
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            {framework.name}
            {framework.provisional ? <span className="rounded-full bg-muted px-2 py-px text-micro font-medium text-muted-foreground">provisional</span> : null}
            <span className="font-mono text-meta font-normal text-muted-foreground">{source === 'builtin' ? `builtin/${framework.id}.yaml` : `.ai/cezar/frameworks/${framework.id}.yaml`}</span>
          </span>
        }
        description={framework.description}
        action={
          <>
            <Button type="button" variant="outline" size="sm" aria-pressed={graphOpen} onClick={() => setGraphOpen((v) => !v)}>
              <WorkflowIcon className="size-3.5" aria-hidden="true" />
              {graphOpen ? 'Hide compiled graph' : 'Open compiled graph'}
            </Button>
            <Button type="button" size="sm" onClick={() => setDuplicating(true)}>
              <CopyIcon className="size-3.5" aria-hidden="true" />
              Duplicate &amp; edit
            </Button>
          </>
        }
      >
        {duplicating ? (
          <div className="px-4 pb-3">
            <DuplicateForm id={framework.id} onDone={() => setDuplicating(false)} onCreated={(newId) => onOpen?.(newId)} />
          </div>
        ) : null}
        <div className="overflow-x-auto">
          <StageTable framework={framework} availability={availability} index={index} />
        </div>
      </SettingsCard>

      {graphOpen ? (
        <SettingsCard title="Compiled graph" description="What a card with default fields runs — read-only.">
          <div className="h-[460px]">
            <React.Suspense fallback={<LoadingState label="Loading graph…" />}>
              <CompiledGraph graph={graph} />
            </React.Suspense>
          </div>
        </SettingsCard>
      ) : null}

      <SettingsCard title="YAML source" description={source === 'builtin' ? 'Built in — duplicate it to edit a project copy.' : 'Edit the file in your repo.'}>
        <pre data-slot="framework-yaml" className="max-h-[480px] overflow-auto bg-muted/40 px-4 py-3 font-mono text-meta whitespace-pre text-foreground">
          {yaml}
        </pre>
      </SettingsCard>
    </div>
  )
}

function StageTable({
  framework,
  availability,
  index,
}: {
  framework: FrameworkFile
  availability: Map<string, StageAvailability>
  index: Map<string, number>
}) {
  return (
    <table data-slot="framework-stages" className="w-full min-w-[760px] border-collapse text-label">
      <thead>
        <tr className="text-left text-soft-foreground">
          {['#', 'Stage', 'Runs', 'Mode', 'Session', 'Gate / loop', 'Must leave'].map((h) => (
            <th key={h} scope="col" className="eyebrow border-b border-border px-3 py-2 font-normal first:pl-4">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {framework.stages.map((stage, i) => {
          const avail = availability.get(stage.id)
          const runs = stage.skill ?? stage.command
          return (
            <tr key={stage.id} data-stage={stage.id} className="border-b border-border last:border-b-0 align-top">
              <td className="px-3 py-2 pl-4 font-mono text-muted-foreground">{i + 1}</td>
              <td className="px-3 py-2 font-medium text-foreground">{stage.name ?? stage.id}</td>
              <td className="px-3 py-2">
                {runs ? (
                  <span
                    data-slot="stage-runs"
                    data-present={avail ? String(avail.present) : undefined}
                    className={cn('font-mono text-meta', avail && !avail.present ? 'text-danger' : 'text-foreground')}
                  >
                    {runs}
                    {avail && !avail.present ? ' — missing in this repo' : ''}
                  </span>
                ) : (
                  <span className="text-muted-foreground">generated prompt</span>
                )}
                {stage.runner || stage.model ? (
                  <div className="text-meta text-muted-foreground">{[stage.runner, stage.model].filter(Boolean).join(' · ')}</div>
                ) : null}
              </td>
              <td className="px-3 py-2 text-muted-foreground">{modeText(stage)}</td>
              <td className="px-3 py-2 text-muted-foreground">
                {!stage.session || stage.session === 'fresh' ? 'fresh' : `continue: ${stage.session.continue}`}
              </td>
              <td className="px-3 py-2 text-muted-foreground">{gateText(stage, index)}</td>
              <td className="px-3 py-2 font-mono text-meta text-muted-foreground">{stage.artifacts?.join(', ') || '—'}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
