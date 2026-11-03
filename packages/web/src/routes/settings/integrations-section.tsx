import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { TelegramInboundStateResponse, WebhookReceiver } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { useHealth } from '@/api/queries'
import { telegramApi } from '@/api/client'
import { useActiveProjectId } from '@/lib/project-router'
import { useWebhookList, webhookKey } from '@/hooks/use-webhooks'
import { telegramKey } from '@/hooks/use-telegram'
import { TelegramSettings, repliesDisabled } from './telegram-inbound'
import { TelegramWizard, telegramUnavailableMessages } from './telegram-wizard'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { TesterArmyE2eCard } from './tester-army-e2e-card'

const telegramBadgeLabels: Record<string, string> = {
  polling: 'Connected',
  backoff: 'Retrying',
  stopped: 'Not running',
  blocked: 'Blocked',
  conflict: 'Conflict',
  'credentials-unavailable': 'No credentials',
}

type TelegramBadgeTone = 'connected' | 'attention' | 'none'
type TelegramGate = { available: boolean; reason?: string }
export type TelegramAvailability = { notifications: TelegramGate; taskControl: TelegramGate }

/** Notifications need CEZ_WEBHOOKS=1 only; task control also needs CEZ_CHAT_INBOUND=1 (spec 2026-10-29-telegram-setup-and-replies). */
export function telegramAvailability(state: TelegramInboundStateResponse | undefined, webhooks: boolean | undefined): TelegramAvailability {
  if (!state) {
    const off = webhooks === false ? { available: false, reason: 'webhooks_off' } : undefined
    return { notifications: off ?? { available: webhooks === true }, taskControl: off ?? { available: false, reason: 'unavailable' } }
  }
  const { notifications, taskControl } = state
  return { notifications, taskControl: notifications.available ? taskControl : { available: false, reason: taskControl.reason ?? notifications.reason } }
}

/**
 * The badge answers "is Telegram actually working for this project?", from the inbound state the
 * server owns — not from how many webhook receivers happen to be configured. A bot that is
 * polling reads as connected; a bot in a degraded health state (blocked, conflicted, retrying)
 * reads as the problem itself, so a broken integration never masquerades as a healthy one.
 */
function telegramBadge(state: TelegramInboundStateResponse | undefined, notificationChats: number, failed: boolean, taskControl: boolean, chats: readonly WebhookReceiver[] = []): { tone: TelegramBadgeTone; label: string } {
  if (failed) return { tone: 'attention', label: 'Unavailable' }
  const connected = state?.receivers.some(row => row.botId) ?? false
  // Without task control nothing polls, so delivery receivers are the only sign of a working setup.
  if (!connected && notificationChats > 0 && state?.available === false) return { tone: 'connected', label: 'Notifications only' }
  if (!connected) return { tone: 'none', label: 'Not set up' }
  const health: string[] = state?.bots.map(bot => bot.health.state) ?? []
  if (health.every(state => state === 'polling')) return { tone: 'connected', label: 'Connected' }
  const fatal = ['blocked', 'conflict', 'credentials-unavailable'].find(state => health.includes(state))
  // Without an approved person or task control the bot never polls; its chats still get notifications.
  if (!fatal && (!state?.grants.length || !taskControl)) return { tone: 'connected', label: 'Notifications only' }
  // Replies disabled on every chat stops the poller on purpose; a suspended chat is a fault and stays attention.
  if (!fatal && state && state.bots.every(bot => bot.health.state === 'polling' || repliesDisabled(state, bot.botId, chats)))
    return { tone: 'connected', label: health.includes('polling') ? 'Connected' : 'Notifications only' }
  const order = ['blocked', 'conflict', 'credentials-unavailable', 'backoff', 'stopped']
  const worst = order.find(state => health.includes(state)) ?? 'backoff'
  return { tone: 'attention', label: telegramBadgeLabels[worst] ?? 'Needs attention' }
}

/**
 * Settings → project → External integrations: third-party tools cezar can install and wire into
 * this project for you. One tab per kind of tool; each tool is a card that owns its own setup
 * (spec .ai/specs/2026-10-29-telegram-setup-and-replies.md).
 */
export function IntegrationsSection() {
  const projectId = useActiveProjectId() ?? 'default'
  const health = useHealth()
  const enabled = health.data?.capabilities.webhooks === true
  const list = useWebhookList(projectId, enabled)
  const client = useQueryClient()
  const [wizardOpen, setWizardOpen] = useState(false)
  const telegramReceivers = list.data?.receivers.filter(row => row.format === 'telegram.v1') ?? []
  const telegram = useQuery({ queryKey: telegramKey(projectId), queryFn: ({ signal }) => telegramApi.list(projectId, signal), retry: false })
  const availability = telegramAvailability(telegram.data, health.data ? enabled : undefined)
  const badge = telegramBadge(telegram.data, telegramReceivers.length, telegram.isError, availability.taskControl.available, telegramReceivers)
  const hasBot = (telegram.data?.receivers.some(row => row.botId) ?? false) || telegramReceivers.length > 0
  const offReason = health.data && !availability.notifications.available ? availability.notifications.reason ?? 'unavailable' : undefined
  const controlOff = telegram.data && availability.notifications.available && !availability.taskControl.available ? availability.taskControl.reason ?? 'unavailable' : undefined
  const badgeClass = badge.tone === 'connected'
    ? 'rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-success'
    : badge.tone === 'attention'
      ? 'rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning'
      : 'rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground'
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4 md:p-6" data-slot="integrations-settings">
      <p className="text-sm text-muted-foreground">
        Connect services and set up tools for this project.
      </p>
      <Tabs defaultValue="test-frameworks">
        <TabsList variant="line" data-slot="integrations-tabs">
          <TabsTrigger value="test-frameworks">Test frameworks</TabsTrigger>
          <TabsTrigger value="telegram">Telegram</TabsTrigger>
        </TabsList>
        <TabsContent value="test-frameworks" className="pt-4">
          <TesterArmyE2eCard />
        </TabsContent>
        <TabsContent value="telegram" className="pt-4">
          <section className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4" data-slot="telegram-integration">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm font-semibold">Telegram</h2>
                  <span data-slot="telegram-badge" data-state={badge.tone} className={badgeClass}>
                    {badge.label}
                  </span>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">Connect a Telegram bot to send task notifications and optionally manage tasks from Telegram. One bot per project can serve several chats.</p>
              </div>
              <Button disabled={!availability.notifications.available || list.isPending || telegram.isPending} onClick={() => setWizardOpen(true)}>{hasBot ? 'Add a chat' : 'Connect Telegram'}</Button>
            </div>
            {health.isError && <p role="status" className="text-sm text-danger">Telegram settings are unavailable because server health could not be loaded.</p>}
            {!health.isError && offReason && <p role="status" className="text-sm text-muted-foreground" data-slot="telegram-unavailable">{telegramUnavailableMessages[offReason] ?? telegramUnavailableMessages.unavailable}</p>}
            {!health.isError && controlOff && <p className="text-sm text-muted-foreground" data-slot="telegram-task-control-off">Notifications work now. {telegramUnavailableMessages[controlOff] ?? telegramUnavailableMessages.unavailable}</p>}
            {list.error && <p role="alert" className="text-sm text-danger">Telegram settings could not be loaded. Refresh the page and try again.</p>}
            {availability.notifications.available && !list.isPending && !list.error && <TelegramSettings key={projectId} projectId={projectId} receivers={telegramReceivers} />}
            <TelegramWizard projectId={projectId} addingChat={hasBot} existingNames={list.data?.receivers.map(row => row.name) ?? []} taskControlUnavailable={controlOff} open={wizardOpen} onOpenChange={setWizardOpen} onComplete={() => { void client.invalidateQueries({ queryKey: webhookKey(projectId) }); void client.invalidateQueries({ queryKey: telegramKey(projectId) }) }} />
          </section>
        </TabsContent>
      </Tabs>
    </div>
  )
}
