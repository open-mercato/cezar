import { useId, useState } from 'react'
import { Link } from 'react-router'

import { useManagerChanges, useManagers, type ManagerChangesQuery } from '@/api/managers'
import { useProjects } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { managerMessageTime } from '@/lib/managers'
import { cn } from '@/lib/utils'
import { ManagerAvatar } from '@/routes/manager/manager-avatar'
import type { ManagerActionCategory, ManagerChange } from '@open-mercato/cezar-api-client'
import { CardNote, SettingsCard } from './form-row'

/** Kinds a change can have today; the server adds categories as the registry grows (spec 2026-11-20 § 1). */
const CATEGORY_LABEL: Partial<Record<ManagerActionCategory, string>> = {
  'pull-requests': 'Pull requests',
  automations: 'Automations',
  jobs: 'Jobs',
  connectors: 'Connectors',
  managers: 'Managers',
}

const OUTCOME: Record<ManagerChange['outcome'], { label: string; className: string }> = {
  done: { label: 'Done', className: 'text-success' },
  failed: { label: 'Failed', className: 'text-danger' },
  rejected: { label: 'Rejected', className: 'text-soft-foreground' },
  dismissed: { label: 'Dismissed', className: 'text-soft-foreground' },
}

const PAGE = 50
const ALL = 'all'

/** Who settled it, in the user's words. */
export function changeByLabel(change: Pick<ManagerChange, 'by' | 'outcome' | 'kind'>): string {
  if (change.kind === 'direct') return 'by the manager, no card'
  if (change.by === 'cezar') return 'by cezar'
  return change.outcome === 'rejected' || change.outcome === 'dismissed' ? 'by you' : 'approved by you'
}

/**
 * Settings → Behaviour → Change history (spec 2026-11-20-manager-admin-actions § 3.3): every card the
 * user or cezar settled and every change a manager made without one, newest first, from
 * `~/.cezar/admin-audit.ndjson`. Read-only in phase 0: Undo arrives with the first undoable change.
 */
export function ManagerChangesSection() {
  const [filters, setFilters] = useState<Omit<ManagerChangesQuery, 'limit'>>({})
  const [limit, setLimit] = useState(PAGE)
  const changes = useManagerChanges({ ...filters, limit })
  const managers = useManagers().data?.managers ?? []
  const projects = useProjects().data?.projects ?? []
  const ids = { manager: useId(), project: useId(), category: useId() }
  const list = changes.data?.changes ?? []
  const filtered = Object.keys(filters).length > 0
  const set = (key: keyof typeof filters, value: string) => {
    setLimit(PAGE)
    setFilters((current) => {
      const { [key]: _dropped, ...rest } = current
      return value === ALL ? rest : { ...rest, [key]: value }
    })
  }

  return (
    <SettingsCard
      slot="manager-changes"
      title="Change history"
      description="Every proposal you or cezar settled, and every change a manager made without a card. Newest first."
    >
      <div data-slot="manager-changes-filters" className="flex flex-wrap gap-2 px-4 py-2.5">
        <span id={ids.manager} className="sr-only">Manager</span>
        <Select value={filters.managerId ?? ALL} onValueChange={(value) => set('managerId', value)}>
          <SelectTrigger aria-labelledby={ids.manager} className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All managers</SelectItem>
            {managers.map((manager) => <SelectItem key={manager.id} value={manager.id}>{manager.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <span id={ids.project} className="sr-only">Project</span>
        <Select value={filters.projectId ?? ALL} onValueChange={(value) => set('projectId', value)}>
          <SelectTrigger aria-labelledby={ids.project} className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All projects</SelectItem>
            {projects.map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <span id={ids.category} className="sr-only">Kind</span>
        <Select value={filters.category ?? ALL} onValueChange={(value) => set('category', value)}>
          <SelectTrigger aria-labelledby={ids.category} className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All kinds</SelectItem>
            {Object.entries(CATEGORY_LABEL).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      {changes.isPending ? <CardNote>Loading the change history…</CardNote> : null}
      {changes.isError ? <CardNote tone="danger">Could not load the change history: {changes.error.message}</CardNote> : null}
      {changes.isSuccess && list.length === 0 ? (
        <CardNote slot="manager-changes-empty">
          {filtered ? 'Nothing matches these filters.' : 'No changes yet. When you approve, reject or dismiss a manager’s card, it shows up here.'}
        </CardNote>
      ) : null}
      {list.length > 0 ? (
        <ul data-slot="manager-changes-list" className="divide-y divide-border">
          {list.map((change) => <ChangeRow key={change.id} change={change} projectName={projects.find((project) => project.id === change.projectId)?.name} />)}
        </ul>
      ) : null}
      {list.length >= limit ? (
        <div className="flex justify-center px-4 py-2.5">
          <Button variant="outline" size="sm" data-slot="manager-changes-more" onClick={() => setLimit((current) => current + PAGE)}>Show older</Button>
        </div>
      ) : null}
      <CardNote>Stored in ~/.cezar/admin-audit.ndjson. Secret values never reach it.</CardNote>
    </SettingsCard>
  )
}

function ChangeRow({ change, projectName }: { change: ManagerChange; projectName: string | undefined }) {
  const manager = useManagers().data?.managers.find((entry) => entry.id === change.managerId)
  const outcome = OUTCOME[change.outcome]
  const category = change.category ? CATEGORY_LABEL[change.category] : undefined
  const showResult = change.result && change.result !== change.summary && change.outcome !== 'rejected'
  return (
    <li data-slot="manager-change" className="grid grid-cols-[1.75rem_1fr_auto] gap-3 px-4 py-2.5">
      {manager ? <ManagerAvatar avatar={manager.avatar} mascot={manager.mascot} className="size-7" sizes="28px" /> : <span aria-hidden="true" className="size-7 rounded-full bg-muted" />}
      <div className="min-w-0">
        <div className="font-medium">{change.summary}</div>
        <div className="flex flex-wrap items-center gap-x-1.5 text-meta text-muted-foreground">
          <span>{manager?.name ?? change.managerName}</span>
          {projectName ?? change.projectId ? <><span aria-hidden="true">·</span><span className="rounded-full border px-1.5">{projectName ?? change.projectId}</span></> : null}
          {category ? <><span aria-hidden="true">·</span><span className="rounded-full border px-1.5">{category}</span></> : null}
          <span aria-hidden="true">·</span>
          <span data-slot="manager-change-outcome" className={cn(outcome.className)}>{outcome.label}</span>
          <span aria-hidden="true">·</span>
          <span>{changeByLabel(change)}</span>
        </div>
        {change.reason || showResult ? (
          <div className="text-meta text-muted-foreground">
            {change.reason ? <>{manager?.name ?? change.managerName}&rsquo;s reason: <q className="italic">{change.reason}</q></> : null}
            {change.reason && showResult ? ' · ' : null}
            {showResult ? change.result : null}
          </div>
        ) : null}
      </div>
      <div className="text-right text-meta text-muted-foreground">
        <time dateTime={change.at}>{managerMessageTime(change.at)}</time>
        {change.actionId && manager ? (
          <Link
            data-slot="manager-change-card"
            className="block text-violet underline-offset-4 hover:underline"
            to={`/manager/${encodeURIComponent(change.managerId)}#decision-${encodeURIComponent(change.actionId)}`}
          >
            Open card
          </Link>
        ) : null}
      </div>
    </li>
  )
}
