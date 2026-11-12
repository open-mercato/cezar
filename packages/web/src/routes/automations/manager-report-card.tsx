import { MessageSquareShareIcon } from 'lucide-react'

import type { AutomationReport, AutomationReportMode, ManagerSummary } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const MODES: Array<{ value: AutomationReportMode; label: string }> = [
  { value: 'post-result', label: 'Every result' },
  { value: 'notify-on-failure', label: 'Failures only' },
  { value: 'none', label: 'Nothing' },
]

/**
 * Which manager's chat a finished run is posted to (spec 2026-10-31-managers § Automation
 * reports). Absent when it reports nowhere and there is no manager to pick.
 */
export function ManagerReportCard({ report, managers, busy = false, onChange }: {
  report?: AutomationReport
  managers?: readonly Pick<ManagerSummary, 'id' | 'name'>[]
  busy?: boolean
  onChange: (report: AutomationReport | null) => void
}) {
  if (!report && !managers?.length) return null
  const manager = report ? managers?.find((candidate) => candidate.id === report.managerId) : undefined
  return (
    <Card flush data-slot="manager-report-card" className="min-w-0 px-3.5 py-3">
      <h2 className="m-0 mb-2 text-meta font-semibold tracking-[.05em] uppercase text-soft-foreground">Reports to</h2>
      {report ? (
        <>
          <p className="m-0 flex items-center gap-1.5 text-ui font-medium text-foreground">
            <MessageSquareShareIcon aria-hidden="true" className="size-3.5 text-violet" />
            <span className="truncate">{manager?.name ?? 'A manager no longer listed'}</span>
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Select value={report.mode} disabled={busy} onValueChange={(mode) => onChange({ managerId: report.managerId, mode: mode as AutomationReportMode })}>
              <SelectTrigger size="sm" aria-label="What to post" className="h-7 px-2 text-label">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODES.map((mode) => <SelectItem key={mode.value} value={mode.value}>{mode.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => onChange(null)}>Unlink</Button>
          </div>
          <p className="m-0 mt-2 text-meta text-muted-foreground">
            {report.mode === 'post-result'
              ? 'Each finished run’s last message is posted to its chat; a failure is marked important.'
              : report.mode === 'notify-on-failure'
                ? 'Only a failed run is posted, marked important.'
                : 'Linked, but nothing is posted.'}
          </p>
        </>
      ) : (
        <Select value="" disabled={busy} onValueChange={(managerId) => onChange({ managerId, mode: 'post-result' })}>
          <SelectTrigger size="sm" aria-label="Report to a manager" className="h-7 px-2 text-label">
            <SelectValue placeholder="Post results to a manager…" />
          </SelectTrigger>
          <SelectContent>
            {managers?.map((candidate) => <SelectItem key={candidate.id} value={candidate.id}>{candidate.name}</SelectItem>)}
          </SelectContent>
        </Select>
      )}
    </Card>
  )
}
