import { extensionKeys, extensionSettingsHref, listExtensionInventory, listExtensions } from '@/api/extensions'
import { extensionChatDescriptor } from '@/lib/chat-providers/extension'
import { extensionAvailabilityLabel } from './extensions-section'
import { ChatNotificationWizard } from './chat-notification-wizard'
import { WebhookNotice, noticeForFormat } from './webhook-notice'
import { chatProviderDescriptors, type ChatProviderDescriptor } from '@/lib/chat-providers'
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useLocation, useSearchParams } from 'react-router'
import type { ChatInboundStateResponse, WebhookReceiver } from '@open-mercato/cezar-api-client'
import { ArrowLeftIcon, ChevronRightIcon, CircleDotIcon, SearchIcon, TicketIcon, WebhookIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Pill } from '@/components/pill'
import { Skeleton } from '@/components/ui/skeleton'
import { Segmented } from '@/components/segmented'
import type { StatusDotTone } from '@/components/status-dot'
import { useE2eStatus, useHealth, useRun, useTrackerAssociation, useTrackerConnection } from '@/api/queries'
import testerArmyLogo from '@/assets/integrations/tester-army.png'
import { Navigate, useActiveProjectId } from '@/lib/project-router'
import { trackerProviders } from '@/lib/tracker-providers'
import { useWebhookList, webhookKey } from '@/hooks/use-webhooks'
import { chatKey, useChatSubscriptions } from '@/hooks/use-chat'
import { repliesDisabled, ChatSettings } from './chat-inbound'
import { ChatWizard, uniqueNotificationName } from './chat-wizard'
import { E2E_SETUP_IN_FLIGHT, TesterArmyE2eCard } from './tester-army-e2e-card'
import { TrackerSection } from './tracker-section'
import { WebhooksSection, type ChatReceiverUpgrade } from './webhooks-section'

const chatBadgeLabels: Record<string, string> = {
  polling: 'Connected',
  backoff: 'Retrying',
  stopped: 'Not running',
  blocked: 'Blocked',
  conflict: 'Conflict',
  'credentials-unavailable': 'No credentials',
}

type ChatBadgeTone = 'connected' | 'attention' | 'pending' | 'none'

/** Slack/Discord with webhook-only receivers and no bot: the tile and the panel read the same delivery status. */
function legacyWebhookBadge(
  rows: readonly WebhookReceiver[],
  failed: boolean,
  enabled: boolean,
  health: string | undefined,
): { tone: ChatBadgeTone; label: string } {
  const active = rows.filter(row => row.state === 'active').length
  const attention = rows.some(row => ['suspended', 'disabled'].includes(row.state)) || health !== 'ready'
  if (failed) return { tone: 'attention', label: 'Status unavailable' }
  if (!enabled) return { tone: 'none', label: 'Off on this server' }
  if (attention) return { tone: 'attention', label: 'Needs attention' }
  return active ? { tone: 'connected', label: `${active} active` } : { tone: 'pending', label: 'Inactive or paused' }
}
const legacyWebhooksOnly = (
  provider: ChatProviderDescriptor,
  rows: readonly WebhookReceiver[],
  state: ChatInboundStateResponse | undefined,
) =>
  !!provider.webhookNotifications &&
  rows.length > 0 &&
  rows.every(row => !row.chatId) &&
  !state?.receivers.some(row => row.botId)
type ChatGate = { available: boolean; reason?: string }
type ChatAvailability = { notifications: ChatGate; taskControl: ChatGate }

/** Notifications need CEZ_WEBHOOKS=1 only; task control also needs CEZ_CHAT_INBOUND=1 (spec 2026-10-29-telegram-setup-and-replies). */
function chatAvailability(
  state: ChatInboundStateResponse | undefined,
  webhooks: boolean | undefined,
): ChatAvailability {
  if (!state) {
    const off = webhooks === false ? { available: false, reason: 'webhooks_off' } : undefined
    return {
      notifications: off ?? { available: webhooks === true },
      taskControl: off ?? { available: false, reason: 'unavailable' },
    }
  }
  const { notifications, taskControl } = state
  return {
    notifications,
    taskControl: notifications.available
      ? taskControl
      : { available: false, reason: taskControl.reason ?? notifications.reason },
  }
}

/** Badge from the server's inbound state, not the receiver count, so a degraded bot never reads as healthy. */
function chatBadge(
  state: ChatInboundStateResponse | undefined,
  notificationChats: number,
  failed: boolean,
  taskControl: boolean,
  chats: readonly WebhookReceiver[] = [],
  notifications?: ChatGate,
): { tone: ChatBadgeTone; label: string } {
  // Server-wide switches explain the tile before any per-project state, like the Webhooks tile.
  if (notifications && !notifications.available && notifications.reason === 'webhooks_off')
    return { tone: 'none', label: 'Off on this server' }
  if (notifications && !notifications.available && notifications.reason === 'hosted')
    return { tone: 'none', label: 'Unavailable on this server' }
  if (failed) return { tone: 'attention', label: 'Unavailable' }
  const connected = state?.receivers.some(row => row.botId) ?? false
  // Without task control nothing polls, so delivery receivers are the only sign of a working setup.
  if (!connected && notificationChats > 0 && state?.available === false)
    return { tone: 'connected', label: 'Notifications only' }
  if (!connected) return { tone: 'none', label: 'Not set up' }
  const health: string[] = state?.bots.map(bot => bot.health.state) ?? []
  if (health.every(state => state === 'polling')) return { tone: 'connected', label: 'Connected' }
  const fatal = ['blocked', 'conflict', 'credentials-unavailable'].find(state => health.includes(state))
  // A bot that is starting or not connected yet reports `stopped`; it is not a fault (yet).
  if (!fatal && state?.bots.some(bot => bot.health.connecting)) return { tone: 'none', label: 'Connecting…' }
  // Without an approved person or task control the bot never polls; its chats still get notifications.
  if (!fatal && (!state?.grants.length || !taskControl)) return { tone: 'connected', label: 'Notifications only' }
  // Replies disabled on every chat stops the poller on purpose; a suspended chat is a fault and stays attention.
  if (
    !fatal &&
    state &&
    state.bots.every(bot => bot.health.state === 'polling' || repliesDisabled(state, bot.botId, chats))
  )
    return { tone: 'connected', label: health.includes('polling') ? 'Connected' : 'Notifications only' }
  const order = ['blocked', 'conflict', 'credentials-unavailable', 'backoff', 'stopped']
  const worst = order.find(state => health.includes(state)) ?? 'backoff'
  return { tone: 'attention', label: chatBadgeLabels[worst] ?? 'Needs attention' }
}

/** Integrations → one chat provider (spec .ai/specs/2026-10-29-telegram-setup-and-replies.md). */
function ChatIntegrationPanel({ provider }: { provider: ChatProviderDescriptor }) {
  const projectId = useActiveProjectId() ?? 'default'
  const health = useHealth()
  const enabled = health.data?.capabilities.webhooks === true
  const list = useWebhookList(projectId, enabled)
  const client = useQueryClient()
  const notice = noticeForFormat(list.data, provider.format)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [chooseMode, setChooseMode] = useState(false)
  const [chooseDestination, setChooseDestination] = useState(false)
  const [notificationOpen, setNotificationOpen] = useState(false)
  const [setupIntent, setSetupIntent] = useState<'notifications' | 'conversation'>('conversation')
  const [repairing, setRepairing] = useState(false)
  const [upgradeReceiver, setUpgradeReceiver] = useState<ChatReceiverUpgrade>()
  const chatReceivers = list.data?.receivers.filter(row => row.format === provider.format) ?? []
  const notificationHooks = chatReceivers.filter(row => !row.chatId)
  const inbound = useQuery({
    queryKey: chatKey(projectId, provider.id),
    queryFn: ({ signal }) => provider.bot.api.list(projectId, signal),
    retry: false,
  })
  const availability = chatAvailability(inbound.data, health.data ? enabled : undefined)
  const badge = legacyWebhooksOnly(provider, chatReceivers, inbound.data)
    ? legacyWebhookBadge(chatReceivers, health.isError || list.isError, enabled, list.data?.webhookHealth.status)
    : chatBadge(
        inbound.data,
        chatReceivers.length,
        inbound.isError,
        availability.taskControl.available,
        chatReceivers,
        availability.notifications,
      )
  const hasBot =
    (inbound.data?.receivers.some(row => row.botId) ?? false) ||
    chatReceivers.some(row => !provider.webhookNotifications || !!row.chatId)
  const [params] = useSearchParams()
  // Webhook-only receivers get their own list; an empty one would only duplicate the panel's empty state.
  // It stays for deleted-receiver history, receiver links and the webhooks-off explanation.
  const showHooks =
    !!provider.webhookNotifications &&
    (!enabled ||
      notificationHooks.length > 0 ||
      params.has('endpoint') ||
      (list.data?.history ?? []).some(row => row.format === provider.format))
  const offReason =
    health.data && !availability.notifications.available
      ? (availability.notifications.reason ?? 'unavailable')
      : undefined
  const controlOff =
    inbound.data && availability.notifications.available && !availability.taskControl.available
      ? (availability.taskControl.reason ?? 'unavailable')
      : undefined
  return (
    <div className="w-full">
      <section
        className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4"
        data-slot={`${provider.id}-integration`}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold">{provider.name}</h2>
              <Pill data-slot="chat-badge" data-state={badge.tone} dot={chatBadgeDot[badge.tone]}>
                {badge.label}
              </Pill>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Choose what Cezar can do in {provider.name}: send notifications, or also let approved people answer and
              manage tasks from the chat. One connection handles both.
            </p>
          </div>
          <Button
            disabled={
              // The chooser explains an unavailable mode; a direct wizard has nothing to explain it with.
              (provider.directSetup ? !availability.notifications.available : !enabled) ||
              list.isPending ||
              !!list.error ||
              inbound.isPending
            }
            onClick={() => {
              setUpgradeReceiver(undefined)
              if (provider.directSetup) setWizardOpen(true)
              else {
                setChooseDestination(false)
                setChooseMode(true)
              }
            }}
          >
            {hasBot ? 'Add a chat' : `Connect ${provider.name}`}
          </Button>
        </div>
        {health.isError && (
          <p role="status" className="text-sm text-danger">
            {provider.name} settings are unavailable because server health could not be loaded.
          </p>
        )}
        {!health.isError && offReason && (
          <p role="status" className="text-sm text-muted-foreground" data-slot="chat-unavailable">
            {provider.bot.unavailableMessages[offReason] ??
              provider.bot.unavailableMessages.unavailable ??
              `${provider.name} is unavailable right now. Try again in a moment.`}
          </p>
        )}
        {!health.isError && controlOff && (
          <p className="text-sm text-muted-foreground" data-slot="chat-task-control-off">
            Notifications work now.{' '}
            {provider.bot.unavailableMessages[controlOff] ??
              provider.bot.unavailableMessages.unavailable ??
              `${provider.name} is unavailable right now. Try again in a moment.`}
          </p>
        )}
        {provider.bot.credentialRepair &&
          inbound.data?.receivers.map(row => {
            const receiver = chatReceivers.find(item => item.id === row.receiverId)
            const bot = inbound.data.bots.find(item => item.botId === row.botId)
            if (!receiver?.chatId || bot?.health.state !== 'credentials-unavailable') return null
            return (
              <div key={row.receiverId} role="status" className="rounded-md border border-warning/50 p-3 text-sm">
                <p>
                  {provider.name} access for {receiver.name} needs attention. {provider.bot.credentialRepair}
                </p>
                <Button
                  variant="outline"
                  disabled={!availability.notifications.available || inbound.isFetching || list.isFetching}
                  onClick={() => {
                    setUpgradeReceiver({ id: receiver.id, name: receiver.name, expectedRevision: row.inboundRevision })
                    setRepairing(true)
                    setSetupIntent(availability.taskControl.available ? 'conversation' : 'notifications')
                    setWizardOpen(true)
                  }}
                >
                  Repair connection for {receiver.name}
                </Button>
              </div>
            )
          })}
        {notice && (
          <WebhookNotice
            key={`${projectId}:${notice.changeSequence}`}
            projectId={projectId}
            notice={notice}
            changeSequence={list.data!.changeSequence}
          />
        )}
        {list.error && (
          <p role="alert" className="text-sm text-danger">
            {provider.name} settings could not be loaded. Refresh the page and try again.
          </p>
        )}
        {availability.notifications.available && !list.isPending && !list.error && (
          <ChatSettings
            provider={provider}
            key={projectId}
            projectId={projectId}
            receivers={chatReceivers.filter(receiver => !provider.webhookNotifications || !!receiver.chatId)}
          />
        )}
        <ChatWizard
          repairing={repairing}
          intent={provider.directSetup ? undefined : setupIntent}
          provider={provider}
          projectId={projectId}
          addingChat={hasBot}
          upgradeReceiver={upgradeReceiver}
          existingNames={list.data?.receivers.map(row => row.name) ?? []}
          taskControlUnavailable={controlOff}
          open={wizardOpen}
          onOpenChange={open => {
            setWizardOpen(open)
            if (!open) setRepairing(false)
          }}
          onComplete={() => {
            void client.invalidateQueries({ queryKey: webhookKey(projectId) })
            void client.invalidateQueries({ queryKey: chatKey(projectId, provider.id) })
          }}
        />
      </section>
      <Dialog open={chooseMode} onOpenChange={setChooseMode}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{hasBot ? `Add a ${provider.name} chat` : `Connect ${provider.name}`}</DialogTitle>
            <DialogDescription>
              {chooseDestination
                ? 'Choose an existing connection to keep its settings and avoid duplicate notifications.'
                : hasBot
                  ? 'What should this chat do?'
                  : 'What would you like Cezar to do?'}
            </DialogDescription>
          </DialogHeader>
          {chooseDestination ? (
            <div className="flex flex-col gap-3">
              {notificationHooks.map(receiver => {
                const revision = inbound.data?.receivers.find(row => row.receiverId === receiver.id)?.inboundRevision
                return (
                  <Button
                    key={receiver.id}
                    variant="outline"
                    disabled={!revision || inbound.isFetching || list.isFetching || inbound.isError}
                    onClick={() => {
                      if (!revision) return
                      setUpgradeReceiver({ id: receiver.id, name: receiver.name, expectedRevision: revision })
                      setSetupIntent('conversation')
                      setChooseMode(false)
                      setWizardOpen(true)
                    }}
                  >
                    Enable task control for {receiver.name}
                  </Button>
                )
              })}
              <Button
                variant="outline"
                onClick={() => {
                  setUpgradeReceiver(undefined)
                  setSetupIntent('conversation')
                  setChooseMode(false)
                  setWizardOpen(true)
                }}
              >
                Connect another chat
              </Button>
              <Button variant="ghost" onClick={() => setChooseDestination(false)}>
                Back
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <Button
                variant="outline"
                disabled={!availability.notifications.available && !provider.webhookNotifications}
                className="h-auto flex-col items-start whitespace-normal p-4 text-left"
                onClick={() => {
                  setChooseMode(false)
                  setSetupIntent('notifications')
                  if ((hasBot || !provider.webhookNotifications) && availability.notifications.available) setWizardOpen(true)
                  else setNotificationOpen(true)
                }}
              >
                <span>Notifications only</span>
                <span className="text-ui font-normal text-muted-foreground">
                  Get task updates. Nobody can control tasks from this chat. You can add task control later.
                </span>
              </Button>
              <Button
                variant="outline"
                disabled={!availability.taskControl.available}
                className="h-auto flex-col items-start whitespace-normal p-4 text-left"
                onClick={() => {
                  if (notificationHooks.length) {
                    setChooseDestination(true)
                    return
                  }
                  setChooseMode(false)
                  setSetupIntent('conversation')
                  setWizardOpen(true)
                }}
              >
                <span>Notifications and task control</span>
                <span className="text-ui font-normal text-muted-foreground">
                  Get task updates and answer Cezar from the chat. You choose who may start, continue or cancel tasks.
                </span>
              </Button>
              {hasBot && (
                <p className="text-ui text-muted-foreground">
                  Your bot also sends notifications. You do not need a separate webhook.
                </p>
              )}
              {!availability.notifications.available && !provider.webhookNotifications && (
                <p className="text-ui text-muted-foreground">
                  {provider.bot.unavailableMessages[availability.notifications.reason ?? 'unavailable']}
                </p>
              )}
              {(availability.notifications.available || provider.webhookNotifications) && !availability.taskControl.available && (
                <p className="text-ui text-muted-foreground">
                  {provider.bot.unavailableMessages[controlOff ?? 'unavailable']}
                </p>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
      {notificationOpen && provider.webhookNotifications && (
        <ChatNotificationWizard
          key={projectId}
          projectId={projectId}
          provider={{ ...provider, webhookNotifications: provider.webhookNotifications }}
          initialName={uniqueNotificationName(list.data?.receivers.map(row => row.name) ?? [], provider.name)}
          onClose={() => setNotificationOpen(false)}
        />
      )}
      {showHooks && (
        <WebhooksSection
          format={provider.format}
          webhookOnly
          hideAdd
          hideNotice
          upgradeStates={
            availability.taskControl.available &&
            !inbound.isError &&
            !list.isError &&
            !inbound.isFetching &&
            !list.isFetching
              ? inbound.data?.receivers
              : undefined
          }
          onUpgrade={receiver => {
            setUpgradeReceiver(receiver)
            setSetupIntent('conversation')
            setWizardOpen(true)
          }}
        />
      )}
    </div>
  )
}

const chatBadgeDot: Record<ChatBadgeTone, StatusDotTone> = {
  connected: 'success',
  attention: 'danger',
  pending: 'pending',
  none: 'neutral',
}

type Category = 'Chat' | 'Issue tracking' | 'Testing' | 'Webhooks'
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
  /** `status` is still `Loading…`: the pill shows a skeleton, the description still announces it. */
  loading?: boolean
}

const categories: ReadonlyArray<readonly [Category, string]> = [
  ['Chat', 'Connect the places where your team talks and works.'],
  ['Issue tracking', 'Connect the project or team whose issues you work on.'],
  ['Testing', 'Set up browser tests for this project.'],
  ['Webhooks', 'Send task updates to your own endpoints. You can add several receivers.'],
]

const tileByFormat: Partial<Record<string, string>> = Object.fromEntries(
  chatProviderDescriptors.map(provider => [provider.format, provider.id]),
)

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
  } else {
    search.delete('integration')
    search.delete('tab')
  }
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
  const extensions = useQuery({ queryKey: extensionKeys.list(projectId), queryFn: () => listExtensions(projectId) })
  const inventory = useQuery({
    queryKey: extensionKeys.inventory(projectId),
    queryFn: ({ signal }) => listExtensionInventory(projectId, signal),
  })
  const installedProviders = useMemo(
    () =>
      (inventory.data?.extensions ?? []).flatMap(item => {
        const access = extensions.data?.extensions.find(extension => extension.manifest.id === item.record.manifest.id)
        // Canonical native providers retain their native forms; delivery declarations must not duplicate them.
        return item.providers
          .filter(provider => !chatProviderDescriptors.some(native => native.id === provider.id))
          .flatMap(provider => {
            const declaration = item.record.manifest.contributes?.chatProviders?.find(
              declaration => provider.id === `${item.record.manifest.id}/${declaration.id}`,
            )
            if (!declaration) return []
            return [
              {
                extension: access ?? item.record,
                availability: item.availability,
                provider: {
                  ...extensionChatDescriptor(item.record.manifest.id, declaration),
                  id: provider.id,
                  name: provider.label,
                },
                running:
                  item.availability === 'available' &&
                  !health.isError &&
                  !!access?.enabled &&
                  access.status === 'running' &&
                  health.data?.capabilities?.extensions === true &&
                  !extensions.isError &&
                  !inventory.isError,
              },
            ]
          })
      }),
    [
      inventory.data,
      inventory.isError,
      extensions.data,
      extensions.isError,
      health.data?.capabilities?.extensions,
      health.isError,
    ],
  )
  const providers = [
    ...chatProviderDescriptors,
    ...installedProviders.filter(item => item.running).map(item => item.provider),
  ]
  const manageLink = (id: string) => (
    <Link
      className="text-sm text-primary underline"
      to={extensionSettingsHref(projectId, id)}
    >
      Manage extension
    </Link>
  )
  const botStates = useQueries({
    queries: providers.map(provider => ({
      queryKey: chatKey(projectId, provider.id),
      queryFn: ({ signal }: { signal: AbortSignal }) => provider.bot.api.list(projectId, signal),
      retry: false,
    })),
  })
  // Tiles read bot health live; only providers whose bots can run (task control available) are subscribed.
  useChatSubscriptions(
    projectId,
    providers.filter((_, index) => botStates[index]?.data?.taskControl.available === true),
  )
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<Category | 'all'>('all')
  const selected = params.get('integration')
  const openIntegration = (id?: string) => {
    const next = new URLSearchParams(params)
    next.delete('endpoint')
    next.delete('tab')
    if (id) next.set('integration', id)
    else next.delete('integration')
    setParams(next)
  }
  const previousSelection = useRef<string | null>(null)
  const detailFocus = useRef<HTMLElement | null>(null)
  const focusedDetail = useRef<string | null>(null)
  const focusDetail = (node: HTMLElement | null) => {
    detailFocus.current = node
    if (node && selected && focusedDetail.current !== selected) {
      node.focus()
      focusedDetail.current = selected
    }
  }
  useEffect(() => {
    if (!selected) focusedDetail.current = null
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
    const connected =
      ownsScope && (connection.data?.demo === true || (ownsCredentials && saved.connectionId === credentials.id))
    // A saved scope without this project's matching credentials — nothing here probes the vendor.
    const status = trackerError
      ? 'Status unavailable'
      : trackerPending
        ? 'Loading…'
        : connected
          ? 'Connected'
          : ownsScope
            ? 'Credentials missing'
            : ownsCredentials
              ? 'Choose a project or team'
              : 'Not connected'
    return {
      id: provider.kind,
      name: provider.label,
      description:
        provider.kind === 'jira'
          ? 'Turn issues from your project into coding tasks.'
          : 'Bring your team’s issues into your coding workflow.',
      status,
      loading: !trackerError && trackerPending,
      category: 'Issue tracking',
      tone: trackerError ? 'danger' : connected ? 'success' : ownsScope || ownsCredentials ? 'pending' : 'neutral',
      ...(ownsScope ? { detail: saved.externalName } : {}),
      icon:
        provider.kind === 'jira' ? (
          <TicketIcon className="size-5" aria-hidden />
        ) : (
          <CircleDotIcon className="size-5" aria-hidden />
        ),
      configuration: <TrackerSection providerKind={provider.kind} />,
    }
  })

  const setupStatus = setupRun.data?.status ?? e2e.data?.setup?.status
  const settingUp = setupStatus !== undefined && E2E_SETUP_IN_FLIGHT.has(setupStatus)
  const installed = Boolean(e2e.data?.configFile && e2e.data.workflow)
  const needsMerge = !installed && (setupStatus === 'review' || setupStatus === 'done')
  const setupFailed = !installed && (setupStatus === 'failed' || setupStatus === 'cancelled')
  tools.push({
    id: 'e2e',
    name: 'TesterArmy e2e',
    description: 'Verify your changes with browser end-to-end tests.',
    status: e2e.isError
      ? 'Status unavailable'
      : e2e.isPending
        ? 'Loading…'
        : settingUp
          ? 'Setting up'
          : needsMerge
            ? 'Awaiting merge'
            : installed
              ? 'Installed'
              : setupFailed
                ? 'Setup incomplete'
                : 'Not set up',
    loading: !e2e.isError && e2e.isPending,
    category: 'Testing',
    tone:
      e2e.isError || setupFailed ? 'danger' : installed ? 'success' : settingUp || needsMerge ? 'pending' : 'neutral',
    icon: <img src={testerArmyLogo} alt="" className="size-7 rounded-md" />,
    configuration: (
      <div className="w-full">
        <TesterArmyE2eCard />
      </div>
    ),
  })

  const webhooksFailed = health.isError || (webhooksEnabled && webhooks.isError)
  const webhooksLoading = (!health.data && !health.isError) || (webhooksEnabled && webhooks.isPending)
  const unsupported = health.data?.capabilities?.webhooksUnavailableReason === 'unsupported_platform'
  const receiverCount = (count: number) => `${count} receiver${count === 1 ? '' : 's'}`
  providers.forEach((provider, index) => {
    const inbound = botStates[index]!
    const chatReceivers = webhooks.data?.receivers.filter(row => row.format === provider.format) ?? []
    const chatAvailable = chatAvailability(inbound.data, health.data ? webhooksEnabled : undefined)
    const chatStatus = chatBadge(
      inbound.data,
      chatReceivers.length,
      inbound.isError,
      chatAvailable.taskControl.available,
      chatReceivers,
      chatAvailable.notifications,
    )
    const legacyOnly = legacyWebhooksOnly(provider, chatReceivers, inbound.data)
    const chatLoading =
      !legacyOnly && inbound.isPending && !inbound.isError && chatAvailable.notifications.reason !== 'webhooks_off'
    const legacyStatus = legacyWebhookBadge(
      chatReceivers,
      webhooksFailed,
      webhooksEnabled,
      webhooks.data?.webhookHealth?.status,
    )

    // Inventory projects trusted shipped/selected ownership onto canonical IDs, even
    // when the software is unavailable. Keep this separate from external tile discovery.
    const owner = (inventory.data?.extensions ?? []).find(item =>
      item.providers.some(owned => owned.id === provider.id),
    )?.record
    tools.push({
      id: provider.id,
      name: provider.name,
      description: provider.description,
      icon: <provider.icon className="size-5" aria-hidden />,
      configuration: (
        <>
          {owner && <div className="w-full pb-4">{manageLink(owner.manifest.id)}</div>}
          <ChatIntegrationPanel provider={provider} />
        </>
      ),
      ownHeader: true,
      status: legacyOnly ? legacyStatus.label : chatLoading ? 'Loading…' : chatStatus.label,
      loading: chatLoading,
      category: 'Chat',
      tone: chatBadgeDot[legacyOnly ? legacyStatus.tone : chatStatus.tone],
      ...(chatReceivers.length
        ? { detail: `${chatReceivers.length} chat${chatReceivers.length === 1 ? '' : 's'}` }
        : {}),
    })
  })
  installedProviders
    .filter(item => !item.running)
    .forEach(({ extension, provider, availability }) => {
      const status =
        extensions.isError || inventory.isError
          ? 'Status unavailable'
          : health.data?.capabilities?.extensions === false
            ? 'Off on this server'
            : extension.status === 'failed'
              ? 'Failed'
              : extension.status === 'starting'
                ? 'Starting'
                : extensionAvailabilityLabel[availability]

      const rows = webhooks.data?.receivers.filter(row => row.format === provider.format) ?? []
      tools.push({
        id: provider.id,
        name: provider.name,
        description: provider.description,
        category: 'Chat',
        status,
        tone: status === 'Failed' || extensions.isError ? 'danger' : 'pending',
        icon: <provider.icon className="size-5" aria-hidden />,
        ...(rows.length ? { detail: receiverCount(rows.length) } : {}),
        configuration: (
          <div className="flex w-full flex-col gap-3">
            <p className="text-sm">
              {provider.name} is unavailable. Extension status: {status.toLowerCase()}. Connection setup requires a
              running extension.
            </p>
            {extension.error && (
              <p role="alert" className="text-sm text-danger">
                {extension.error}
              </p>
            )}
            {rows.length > 0 && (
              <div>
                <p className="text-sm font-medium">Saved receivers</p>
                <ul className="text-sm">
                  {rows.map(row => (
                    <li key={row.id}>{row.name}</li>
                  ))}
                </ul>
              </div>
            )}
            <p className="text-sm text-muted-foreground">
              Manage the extension to restore access to this project's connections.
            </p>
            {manageLink(extension.manifest.id)}
            {(extensions.isError || inventory.isError) && (
              <Button
                variant="outline"
                onClick={() => {
                  void extensions.refetch()
                  void inventory.refetch()
                }}
              >
                Retry extensions
              </Button>
            )}
          </div>
        ),
      })
    })
  const webhookRows = webhooks.data?.receivers.filter(row => row.format === 'cezar.json.v1') ?? []
  const activeWebhooks = webhookRows.filter(row => row.state === 'active').length
  const webhookAttention =
    webhookRows.some(row => ['suspended', 'disabled'].includes(row.state)) ||
    (webhookRows.length > 0 && webhooks.data?.webhookHealth.status !== 'ready')
  tools.push({
    id: 'webhooks',
    name: 'Webhooks',
    description: 'Send signed task events to your own endpoints.',
    icon: <WebhookIcon className="size-5" aria-hidden />,
    configuration: <WebhooksSection format="cezar.json.v1" />,
    status: webhooksFailed
      ? 'Status unavailable'
      : webhooksLoading
        ? 'Loading…'
        : unsupported
          ? 'Unavailable on this server'
          : !webhooksEnabled
            ? 'Off on this server'
            : webhookAttention
              ? 'Needs attention'
              : activeWebhooks
                ? `${activeWebhooks} active`
                : webhookRows.length
                  ? 'Inactive or paused'
                  : 'Not set up',
    loading: !webhooksFailed && webhooksLoading,
    category: 'Webhooks',
    tone:
      webhooksFailed || webhookAttention
        ? 'danger'
        : webhooksEnabled && activeWebhooks
          ? 'success'
          : webhookRows.length
            ? 'pending'
            : 'neutral',
    ...(webhookRows.length ? { detail: receiverCount(webhookRows.length) } : {}),
  })

  const activeTool = tools.find(tool => tool.id === selected)
  if (activeTool)
    return (
      <div role="region" aria-label={activeTool.name} data-slot="integration-detail">
        <div className="flex w-full flex-col gap-4 pb-4">
          <Button
            ref={activeTool.ownHeader ? focusDetail : undefined}
            className="self-start"
            size="sm"
            variant="ghost"
            onClick={() => openIntegration()}
          >
            <ArrowLeftIcon />
            All integrations
          </Button>
          {!activeTool.ownHeader && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 ref={focusDetail} tabIndex={-1} className="text-sm font-semibold outline-none">
                {activeTool.name}
              </h2>
              <StatusPill tool={activeTool} labelled />
            </div>
          )}
        </div>
        {/* Keyed by tool: Jira and Linear share TrackerSection and must not share its form state. */}
        <Fragment key={activeTool.id}>{activeTool.configuration}</Fragment>
      </div>
    )

  // A failed catalog read cannot describe the missing tiles; offer a catalog retry.
  return (
    <>
      {/* Announced only: the tiles already show their own Loading…, so a visible line would shift the gallery. */}
      {inventory.isPending && (
        <p role="status" className="sr-only">
          Loading extension inventory…
        </p>
      )}
      {(extensions.isError || inventory.isError) && (
        <div role="alert" className="p-4 text-sm">
          Extension integrations could not be loaded.{' '}
          <Button
            variant="outline"
            onClick={() => {
              void extensions.refetch()
              void inventory.refetch()
            }}
          >
            Retry extensions
          </Button>
        </div>
      )}
      <IntegrationsGalleryGrid
        tools={tools}
        query={query}
        onQueryChange={setQuery}
        category={category}
        onCategoryChange={setCategory}
        onOpen={openIntegration}
      />
    </>
  )
}

/** Never a `status` region: a tile is a button whose description already announces the status. */
function StatusPill({ tool, labelled = false }: { tool: Tool; labelled?: boolean }) {
  if (!tool.loading) return <Pill dot={tool.tone}>{tool.status}</Pill>
  return (
    <Pill dot="neutral">
      <Skeleton className="h-3 w-14" />
      {labelled && <span className="sr-only">{tool.status}</span>}
    </Pill>
  )
}

function IntegrationsGalleryGrid({
  tools,
  query,
  onQueryChange,
  category,
  onCategoryChange,
  onOpen,
}: {
  tools: Tool[]
  query: string
  onQueryChange: (value: string) => void
  category: Category | 'all'
  onCategoryChange: (value: Category | 'all') => void
  onOpen: (id: string) => void
}) {
  const needle = query.trim().toLocaleLowerCase()
  const categoryOptions = [
    { value: 'all', label: 'All categories', count: tools.length },
    ...categories.map(([value]) => ({
      value,
      label: value,
      count: tools.filter(tool => tool.category === value).length,
    })),
  ] as const
  const visible = tools.filter(
    tool =>
      (category === 'all' || tool.category === category) &&
      (!needle ||
        [tool.name, tool.description, tool.category, tool.status, tool.detail ?? ''].some(value =>
          value.toLocaleLowerCase().includes(needle),
        )),
  )
  return (
    <div
      className="flex w-full flex-col gap-6"
      data-slot="integrations-settings"
    >
      <div className="relative">
        <SearchIcon
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          type="search"
          aria-label="Search integrations"
          placeholder="Search integrations…"
          className="pl-9"
          value={query}
          onChange={event => onQueryChange(event.target.value)}
        />
      </div>
      <Segmented
        slot="integration-category-filter"
        label="Integration category"
        value={category}
        options={categoryOptions}
        onChange={onCategoryChange}
        full
        className="flex-wrap"
      />
      {visible.length === 0 && (
        <p role="status" className="text-ui text-muted-foreground">
          {needle ? `No integrations match “${query.trim()}”.` : 'No integrations in this category.'}
        </p>
      )}
      {categories.map(([category, hint]) => {
        const categoryTools = visible.filter(tool => tool.category === category)
        if (categoryTools.length === 0) return null
        return (
          <section key={category} data-slot="integration-category" className="flex flex-col gap-2">
            <div>
              <h2 className="text-ui font-semibold text-foreground">{category}</h2>
              <p className="text-meta text-muted-foreground">{hint}</p>
            </div>
            <div className="grid auto-rows-fr gap-3 sm:grid-cols-2">
              {categoryTools.map(tool => (
                <button
                  key={tool.id}
                  id={`integration-${tool.id}`}
                  type="button"
                  aria-label={`Configure ${tool.name}`}
                  aria-describedby={`integration-${tool.id}-description`}
                  onClick={() => onOpen(tool.id)}
                  className="flex h-full min-w-0 flex-col gap-3 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="flex items-center gap-2.5">
                    <span className="flex size-7 shrink-0 items-center justify-center text-muted-foreground">
                      {tool.icon}
                    </span>
                    <span className="min-w-0 flex-1 text-sm font-semibold text-foreground">{tool.name}</span>
                    <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  </span>
                  <span className="text-ui text-muted-foreground">{tool.description}</span>
                  <span className="mt-auto flex flex-wrap items-center gap-2">
                    <StatusPill tool={tool} />
                    {tool.detail && (
                      <span className="min-w-0 break-words text-xs text-muted-foreground">{tool.detail}</span>
                    )}
                  </span>
                  <span id={`integration-${tool.id}-description`} className="sr-only">
                    Status: {tool.status}
                    {tool.detail ? `. ${tool.detail}.` : '.'}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}
