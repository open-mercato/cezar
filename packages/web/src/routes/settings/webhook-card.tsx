import { useHealth } from '@/api/queries'
import { Link, useActiveProjectId } from '@/lib/project-router'
import { useWebhookList } from '@/hooks/use-webhooks'
import { SettingsField } from './settings-field'
export function WebhookCard() {
  const health = useHealth()
  const enabled = !health.isError && health.data?.capabilities?.webhooks === true
  const unsupported = health.data?.capabilities?.webhooksUnavailableReason === 'unsupported_platform'
  const projectId = useActiveProjectId() ?? 'default'
  const list = useWebhookList(projectId, enabled)
  const rows = list.data?.receivers ?? []
  const attention = rows.filter(row => ['suspended', 'disabled'].includes(row.state)).length
  const inactive = rows.filter(row => row.state === 'inactive').length
  const pending = rows.reduce((total, row) => total + row.pendingCount, 0)
  return <SettingsField title="Webhooks" hint="Task updates sent to Slack, Discord or your own endpoint.">
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-md border border-border bg-card p-3 text-[13px]">
      <div className="min-w-0">
        {health.isError ? <p>Status unavailable — could not load server health.</p>
          : !health.data ? <p>Loading webhook status…</p>
          : unsupported ? <p>Not available on this server’s platform.</p>
          : !enabled ? <p>Off on this server.</p>
          : list.isPending ? <p className="text-muted-foreground">Loading…</p>
          : list.error ? <p className="text-danger">Status unavailable — open Webhooks for details.</p>
          : !rows.length ? <p>No receivers yet.</p>
          : <p>{rows.filter(row => row.state === 'active').length} active · {rows.filter(row => row.state === 'paused').length} paused{inactive ? ` · ${inactive} inactive` : ''}{attention ? <> · <span className="text-warning">{attention} need attention</span></> : ''}{pending ? ` · ${pending} pending` : ''}</p>}
        {enabled && !unsupported && !list.error && list.data?.webhookHealth && ['degraded', 'unavailable'].includes(list.data.webhookHealth.status) && <p role="status" className="text-warning">{list.data.webhookHealth.reason || 'Webhook delivery needs attention. Open Webhooks for details.'}</p>}
      </div>
      <Link className="shrink-0 underline underline-offset-2 hover:text-foreground" to="/settings/webhooks">{enabled && !unsupported ? 'Manage webhooks' : 'Open webhook settings'}</Link>
    </div>
  </SettingsField>
}
