import type { SelfUpdateStatus, WebhookDeliveryStatus, WebhookReceiver, WebhookReceiverState } from '@open-mercato/cezar-api-client'

import type { StatusDotTone } from '@/components/status-dot'

export const endpointHealthTone: Record<WebhookReceiverState, StatusDotTone> = {
  inactive: 'neutral', active: 'success', paused: 'neutral', suspended: 'pending', disabled: 'danger',
}

export const receiverStateLabels: Record<WebhookReceiverState, string> = {
  inactive: 'Inactive', active: 'Active', paused: 'Paused', suspended: 'Failing', disabled: 'Disabled',
}

export const formatLabels: Record<WebhookReceiver['format'], string> = {
  'cezar.json.v1': 'Custom receiver', 'slack.v1': 'Slack', 'discord.v1': 'Discord',
}

export const profileLabels: Record<WebhookReceiver['profile'], string> = { minimal: 'Minimal', standard: 'Standard' }

export const scopeLabels: Record<WebhookReceiver['scope'], string> = {
  main_and_questions: 'Main tasks and questions from child tasks', every_task: 'Every task',
}

export const presetLabels: Record<WebhookReceiver['preset'], string> = {
  attention: 'Attention, review and results', all: 'All results', custom: 'Custom',
}

export const graceLabels: Record<WebhookReceiver['graceSeconds'], string> = { 0: 'Immediately', 60: '1 minute', 180: '3 minutes', 600: '10 minutes' }

export const lastTestLabels: Record<WebhookReceiver['lastTest'], string> = {
  none: 'Not tested', success: 'Passed', transient_failure: 'Failed — temporary error', permanent_failure: 'Failed',
}

export const deliveryStatusLabels: Record<WebhookDeliveryStatus, string> = {
  pending: 'Queued', in_flight: 'Sending', retrying: 'Retrying', blocked_policy: 'Blocked by address policy',
  delivered: 'Delivered', failed: 'Failed', superseded: 'Superseded', cancelled: 'Cancelled', dropped: 'Dropped',
}

const reasonLabels: Record<string, string> = {
  timeout: 'Receiver did not respond within 10 seconds', connection_failed: 'Could not connect to the receiver',
  transport_failed: 'Network error', delivery_failed: 'Delivery failed', outcome_unknown: 'Result unknown — it may have arrived',
  rate_limited: 'Rate limited', expired: 'Retry window ended', aborted: 'Stopped', owner_restarted: 'cezar restarted during delivery',
  payload_invalid: 'Message could not be built', integrity_reset: 'Webhook data was reset', retained_capacity: 'History storage is full',
  newer_continuation: 'A newer update replaced it', operation_superseded: 'A newer action replaced it',
  failure_schedule_changed: 'Automatic resume changed', denied_address: 'Address is never allowed',
  local_network_consent_required: 'Private-network delivery not allowed', local_consent_required: 'Private-network delivery not allowed',
}

const activityLabels: Record<string, string> = {
  created: 'Receiver added', activated: 'Activated', resumed: 'Resumed', paused: 'Paused', deleted: 'Deleted', renamed: 'Renamed',
  configuration_changed: 'Settings changed', delivery_changed: 'Delivery settings changed', secret_rotated: 'Signing key rotated',
  test: 'Test sent', test_result: 'Test result', delivery_result: 'Delivery result', retry: 'Retry requested', replay: 'Replay requested',
  notice_acknowledged: 'Change marked as reviewed', history_pruned: 'Old history removed', integrity_reset: 'Webhook data reset',
}

export const sourceLabels: Record<'cockpit/api' | 'system', string> = { 'cockpit/api': 'cockpit or API', system: 'cezar' }

/** Unknown server codes still read as words: `http_404` → `HTTP 404`, `foo_bar` → `Foo bar`. */
function humanize(code: string) {
  const text = code.replaceAll('_', ' ').replace(/^http /i, 'HTTP ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}
export const reasonLabel = (code: string) => reasonLabels[code] ?? humanize(code)
export const activityLabel = (code: string) => activityLabels[code] ?? humanize(code)

export function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`
}

export function webhookTimeZone(zone?: string) {
  try {
    if (zone) { new Intl.DateTimeFormat(undefined, { timeZone: zone }); return { zone, label: zone } }
  } catch { /* An unsupported server zone falls back to this browser's own time. */ }
  return { zone: undefined, label: 'your local time' }
}
export function webhookTime(value: string, zone?: string) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return 'Time unavailable'
  return date.toLocaleString(undefined, { timeZone: webhookTimeZone(zone).zone, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
}

export function webhookGuide(_metadata?: Pick<SelfUpdateStatus, 'version' | 'installKind'>) {
  return {
    href: 'https://github.com/open-mercato/cezar/blob/main/packages/cezar/docs/webhooks.md',
    note: 'Webhook guide',
  }
}
