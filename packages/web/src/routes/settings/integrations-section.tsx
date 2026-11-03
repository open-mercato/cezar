import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation, useSearchParams } from 'react-router'
import type { TelegramInboundStateResponse, WebhookReceiver } from '@open-mercato/cezar-api-client'
import { ArrowLeftIcon, ChevronRightIcon, CircleDotIcon, HashIcon, MessagesSquareIcon, SearchIcon, SendIcon, TicketIcon, WebhookIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Pill } from '@/components/pill'
import { Segmented } from '@/components/segmented'
import type { StatusDotTone } from '@/components/status-dot'
import { useE2eStatus, useHealth, useRun, useTrackerAssociation, useTrackerConnection } from '@/api/queries'
import { telegramApi } from '@/api/client'
import testerArmyLogo from '@/assets/integrations/tester-army.png'
import { Navigate, useActiveProjectId } from '@/lib/project-router'
import { trackerProviders } from '@/lib/tracker-providers'
import { useWebhookList, webhookKey } from '@/hooks/use-webhooks'
import { telegramKey } from '@/hooks/use-telegram'
import { SettingsField } from './settings-field'
import { TelegramSettings, repliesDisabled } from './telegram-inbound'
import { TelegramWizard, telegramUnavailableMessages } from './telegram-wizard'
import { E2E_SETUP_IN_FLIGHT, TesterArmyE2eCard } from './tester-army-e2e-card'
import { TrackerSection } from './tracker-section'
import { WebhooksSection } from './webhooks-section'


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


/** Integrations → Telegram (spec .ai/specs/2026-10-29-telegram-setup-and-replies.md). */
function TelegramIntegrationPanel() {
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
  return (
    <div className="mx-auto w-full max-w-2xl p-4 md:p-6">
      <section className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4" data-slot="telegram-integration">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold">Telegram</h2>
              <Pill data-slot="telegram-badge" data-state={badge.tone} dot={telegramTone[badge.tone]}>{badge.label}</Pill>
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
    </div>
  )
}

const telegramTone: Record<TelegramBadgeTone, StatusDotTone> = { connected: 'success', attention: 'danger', none: 'neutral' }

type Category = 'Issue tracking' | 'Testing' | 'Notifications'
type Tool = {
  id: string
  name: string
  description: string
  status: string
  category: Category
  tone: StatusDotTone
  detail?: string
  icon: ReactNode
  configuration: ReactNode
  /** The configuration renders its own name and status, so the detail header shows only the way back. */
  ownHeader?: boolean
}

const categories: ReadonlyArray<readonly [Category, string]> = [
  ['Issue tracking', 'Connect the project or team whose issues you work on.'],
  ['Testing', 'Set up browser tests for this project.'],
  ['Notifications', 'Send task updates to your channels or endpoints. You can add several receivers.'],
]

// Chat tools first, generic Webhooks last (after Telegram).
const webhookTools = [
  { id: 'slack', name: 'Slack', format: 'slack.v1', description: 'Send task updates to your Slack channels.', icon: HashIcon },
  { id: 'discord', name: 'Discord', format: 'discord.v1', description: 'Send task updates to your Discord channels.', icon: MessagesSquareIcon },
] as const
const genericWebhooks = { id: 'webhooks', name: 'Webhooks', format: 'cezar.json.v1', description: 'Send signed task events to your own endpoints.', icon: WebhookIcon } as const

const tileByFormat: Partial<Record<string, string>> = { 'slack.v1': 'slack', 'discord.v1': 'discord' }

/**
 * Old `/settings/webhooks` bookmarks land on the gallery; receiver/history links land on the
 * tile that lists that receiver (Slack, Discord, else Webhooks).
 */
export function LegacyWebhooksRedirect() {
  const location = useLocation()
  const projectId = useActiveProjectId() ?? 'default'
  const health = useHealth()
  const search = new URLSearchParams(location.search)
  const endpoint = search.get('endpoint')
  const lookup = Boolean(endpoint) && health.data?.capabilities?.webhooks === true
  const list = useWebhookList(projectId, lookup)
  if (endpoint && ((!health.data && !health.isError) || (lookup && list.isPending))) return null
  if (endpoint) {
    const row = [...(list.data?.receivers ?? []), ...(list.data?.history ?? [])].find(item => item.id === endpoint)
    search.set('integration', (row?.format && tileByFormat[row.format]) || 'webhooks')
  } else { search.delete('integration'); search.delete('tab') }
  return <Navigate replace to={{ pathname: '/settings/integrations', search: `?${search}`, hash: location.hash }} />
}

/**
 * Settings → project → Integrations: one gallery of the tools this project works with; a tile
 * opens that tool's configuration in place (`?integration=<id>`).
 */
export function IntegrationsSection() {
  const projectId = useActiveProjectId() ?? 'default'
  // A project switch must discard open forms and their unsaved credentials.
  return <IntegrationsGallery key={projectId} />
}

function IntegrationsGallery() {
  const [params, setParams] = useSearchParams()
  const projectId = useActiveProjectId() ?? 'default'
  const health = useHealth()
  const webhooksEnabled = !health.isError && health.data?.capabilities?.webhooks === true
  const webhooks = useWebhookList(projectId, webhooksEnabled)
  const telegram = useQuery({ queryKey: telegramKey(projectId), queryFn: ({ signal }) => telegramApi.list(projectId, signal), retry: false })
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<Category | 'all'>('all')
  const selected = params.get('integration')
  const openIntegration = (id?: string) => {
    const next = new URLSearchParams(params)
    next.delete('endpoint'); next.delete('tab')
    if (id) next.set('integration', id)
    else next.delete('integration')
    setParams(next)
  }
  const previousSelection = useRef<string | null>(null)
  const detailFocus = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (selected) detailFocus.current?.focus()
    else if (previousSelection.current) document.getElementById(`integration-${previousSelection.current}`)?.focus()
    previousSelection.current = selected
  }, [selected])

  const association = useTrackerAssociation()
  const connection = useTrackerConnection()
  const e2e = useE2eStatus()
  const setupRun = useRun(e2e.data?.setup?.runId)
  const saved = association.data?.association
  const credentials = connection.data?.connection
  const trackerError = association.isError || connection.isError || Boolean(connection.data?.error)
  const trackerPending = association.isPending || connection.isPending
  const tools: Tool[] = trackerProviders.map(provider => {
    const ownsScope = saved?.kind === provider.kind
    const ownsCredentials = credentials?.kind === provider.kind
    const connected = ownsScope && (connection.data?.demo === true || (ownsCredentials && saved.connectionId === credentials.id))
    // A saved scope without this project's matching credentials — nothing here probes the vendor.
    const status = trackerError ? 'Status unavailable' : trackerPending ? 'Loading…' : connected ? 'Connected' : ownsScope ? 'Credentials missing' : ownsCredentials ? 'Choose a project or team' : 'Not connected'
    return {
      id: provider.kind,
      name: provider.label,
      description: provider.kind === 'jira' ? 'Turn issues from your project into coding tasks.' : 'Bring your team’s issues into your coding workflow.',
      status,
      category: 'Issue tracking',
      tone: trackerError ? 'danger' : connected ? 'success' : ownsScope || ownsCredentials ? 'pending' : 'neutral',
      ...(ownsScope ? { detail: saved.externalName } : {}),
      icon: provider.kind === 'jira' ? <TicketIcon className="size-5" aria-hidden /> : <CircleDotIcon className="size-5" aria-hidden />,
      configuration: <TrackerSection providerKind={provider.kind} />,
    }
  })

  const setupStatus = setupRun.data?.status ?? e2e.data?.setup?.status
  const settingUp = setupStatus !== undefined && E2E_SETUP_IN_FLIGHT.has(setupStatus)
  const installed = Boolean(e2e.data?.configFile && e2e.data.workflow)
  const needsMerge = !installed && (setupStatus === 'review' || setupStatus === 'done')
  const setupFailed = !installed && (setupStatus === 'failed' || setupStatus === 'cancelled')
  tools.push({
    id: 'e2e', name: 'TesterArmy e2e',
    description: 'Verify your changes with browser end-to-end tests.',
    status: e2e.isError ? 'Status unavailable' : e2e.isPending ? 'Loading…' : settingUp ? 'Setting up' : needsMerge ? 'Awaiting merge' : installed ? 'Installed' : setupFailed ? 'Setup incomplete' : 'Not set up',
    category: 'Testing',
    tone: e2e.isError || setupFailed ? 'danger' : installed ? 'success' : settingUp || needsMerge ? 'pending' : 'neutral',
    icon: <img src={testerArmyLogo} alt="" className="size-7 rounded-md" />,
    configuration: <div className="mx-auto w-full max-w-2xl p-4 md:p-6"><TesterArmyE2eCard /></div>,
  })

  const webhooksFailed = health.isError || (webhooksEnabled && webhooks.isError)
  const webhooksLoading = (!health.data && !health.isError) || (webhooksEnabled && webhooks.isPending)
  const unsupported = health.data?.capabilities?.webhooksUnavailableReason === 'unsupported_platform'
  const receiverCount = (count: number) => `${count} receiver${count === 1 ? '' : 's'}`
  const pushWebhookTool = (tool: typeof webhookTools[number] | typeof genericWebhooks) => {
    const rows = webhooks.data?.receivers.filter(row => row.format === tool.format) ?? []
    const active = rows.filter(row => row.state === 'active').length
    const attention = rows.some(row => ['suspended', 'disabled'].includes(row.state)) || (rows.length > 0 && webhooks.data?.webhookHealth.status !== 'ready')
    tools.push({
      id: tool.id, name: tool.name, description: tool.description,
      icon: <tool.icon className="size-5" aria-hidden />,
      configuration: <WebhooksSection format={tool.format} />,
      status: webhooksFailed ? 'Status unavailable' : webhooksLoading ? 'Loading…' : unsupported ? 'Unavailable on this server' : !webhooksEnabled ? 'Off on this server' : attention ? 'Needs attention' : active ? `${active} active` : rows.length ? 'Inactive or paused' : 'Not configured',
      category: 'Notifications',
      tone: webhooksFailed || attention ? 'danger' : webhooksEnabled && active ? 'success' : rows.length ? 'pending' : 'neutral',
      ...(rows.length ? { detail: receiverCount(rows.length) } : {}),
    })
  }
  webhookTools.forEach(pushWebhookTool)
  const telegramChats = webhooks.data?.receivers.filter(row => row.format === 'telegram.v1') ?? []
  const telegramAvailable = telegramAvailability(telegram.data, health.data ? webhooksEnabled : undefined)
  const telegramStatus = telegramBadge(telegram.data, telegramChats.length, telegram.isError, telegramAvailable.taskControl.available, telegramChats)
  tools.push({
    id: 'telegram', name: 'Telegram', description: 'Send task updates to your Telegram chats and answer tasks from them.',
    icon: <SendIcon className="size-5" aria-hidden />,
    configuration: <TelegramIntegrationPanel />,
    ownHeader: true,
    status: telegram.isPending && !telegram.isError ? 'Loading…' : telegramStatus.label,
    category: 'Notifications',
    tone: telegramTone[telegramStatus.tone],
    ...(telegramChats.length ? { detail: `${telegramChats.length} chat${telegramChats.length === 1 ? '' : 's'}` } : {}),
  })
  pushWebhookTool(genericWebhooks)

  const activeTool = tools.find(tool => tool.id === selected)
  if (activeTool) return <div role="region" aria-label={activeTool.name} data-slot="integration-detail">
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 pt-4 md:px-6 md:pt-6">
      <Button ref={activeTool.ownHeader ? node => { detailFocus.current = node } : undefined} className="self-start" size="sm" variant="ghost" onClick={() => openIntegration()}><ArrowLeftIcon />All integrations</Button>
      {!activeTool.ownHeader && <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 ref={node => { detailFocus.current = node }} tabIndex={-1} className="text-sm font-semibold outline-none">{activeTool.name}</h2>
        <Pill dot={activeTool.tone}>{activeTool.status}</Pill>
      </div>}
    </div>
    {/* Keyed by tool: Jira and Linear share TrackerSection and must not share its form state. */}
    <Fragment key={activeTool.id}>{activeTool.configuration}</Fragment>
  </div>

  // Unavailable statuses show on their own tiles; no gallery-wide alert or retry.
  return <IntegrationsGalleryGrid tools={tools} query={query} onQueryChange={setQuery} category={category} onCategoryChange={setCategory} onOpen={openIntegration} />
}

function IntegrationsGalleryGrid({ tools, query, onQueryChange, category, onCategoryChange, onOpen }: { tools: Tool[]; query: string; onQueryChange: (value: string) => void; category: Category | 'all'; onCategoryChange: (value: Category | 'all') => void; onOpen: (id: string) => void }) {
  const needle = query.trim().toLocaleLowerCase()
  const categoryOptions = [
    { value: 'all', label: 'All categories', count: tools.length },
    ...categories.map(([value]) => ({ value, label: value, count: tools.filter(tool => tool.category === value).length })),
  ] as const
  const visible = tools.filter(tool => (category === 'all' || tool.category === category)
    && (!needle || [tool.name, tool.description, tool.category, tool.status, tool.detail ?? ''].some(value => value.toLocaleLowerCase().includes(needle))))
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-6 md:pb-6" data-slot="integrations-settings">
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input type="search" aria-label="Search integrations" placeholder="Search integrations…" className="pl-9" value={query} onChange={event => onQueryChange(event.target.value)} />
      </div>
      <Segmented slot="integration-category-filter" label="Integration category" value={category} options={categoryOptions} onChange={onCategoryChange} full />
      {visible.length === 0 && <p role="status" className="text-ui text-muted-foreground">{needle ? `No integrations match “${query.trim()}”.` : 'No integrations in this category.'}</p>}
      {categories.map(([category, hint]) => {
        const categoryTools = visible.filter(tool => tool.category === category)
        if (categoryTools.length === 0) return null
        return (
          <SettingsField key={category} title={category} hint={hint}>
            <div className="grid gap-3 sm:grid-cols-2">
              {categoryTools.map(tool => (
                <button key={tool.id} id={`integration-${tool.id}`} type="button" aria-label={`Configure ${tool.name}`} aria-describedby={`integration-${tool.id}-description`} onClick={() => onOpen(tool.id)} className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <span className="flex items-center gap-2.5">
                    <span className="flex size-7 shrink-0 items-center justify-center text-muted-foreground">{tool.icon}</span>
                    <span className="min-w-0 flex-1 text-sm font-semibold text-foreground">{tool.name}</span>
                    <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  </span>
                  <span className="text-ui text-muted-foreground">{tool.description}</span>
                  <span className="mt-auto flex flex-wrap items-center gap-2">
                    <Pill dot={tool.tone}>{tool.status}</Pill>
                    {tool.detail && <span className="min-w-0 break-words text-xs text-muted-foreground">{tool.detail}</span>}
                  </span>
                  <span id={`integration-${tool.id}-description`} className="sr-only">Status: {tool.status}{tool.detail ? `. ${tool.detail}.` : '.'}</span>
                </button>
              ))}
            </div>
          </SettingsField>
        )
      })}
    </div>
  )
}
