import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { useLocation, useSearchParams } from 'react-router'
import { ArrowLeftIcon, ChevronRightIcon, CircleDotIcon, HashIcon, MessagesSquareIcon, SearchIcon, TicketIcon, WebhookIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Pill } from '@/components/pill'
import { Skeleton } from '@/components/ui/skeleton'
import { Segmented } from '@/components/segmented'
import type { StatusDotTone } from '@/components/status-dot'
import { useE2eStatus, useHealth, useRun, useTrackerAssociation, useTrackerConnection } from '@/api/queries'
import testerArmyLogo from '@/assets/integrations/tester-army.png'
import { Navigate, useActiveProjectId } from '@/lib/project-router'
import { trackerProviders } from '@/lib/tracker-providers'
import { useWebhookList } from '@/hooks/use-webhooks'
import { E2E_SETUP_IN_FLIGHT, TesterArmyE2eCard } from './tester-army-e2e-card'
import { TrackerSection } from './tracker-section'
import { WebhooksSection } from './webhooks-section'

type Category = 'Issue tracking' | 'Testing' | 'Webhooks'
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
  ['Issue tracking', 'Connect the project or team whose issues you work on.'],
  ['Testing', 'Set up browser tests for this project.'],
  ['Webhooks', 'Send task updates to your channels or endpoints. You can add several receivers.'],
]

// Slack and Discord receive notifications through their channel webhook URLs; they cannot control tasks.
const channelWebhooks = [
  { id: 'slack', name: 'Slack', format: 'slack.v1', description: 'Send task updates to your Slack channels.', icon: HashIcon },
  { id: 'discord', name: 'Discord', format: 'discord.v1', description: 'Send task updates to your Discord channels.', icon: MessagesSquareIcon },
] as const

const tileByFormat: Partial<Record<string, string>> = { 'slack.v1': 'slack', 'discord.v1': 'discord' }

/**
 * Old `/settings/webhooks` bookmarks land on the gallery; receiver/history links land on the
 * tile that lists that receiver (Slack, Discord, else Webhooks, which also keeps deleted receivers' history).
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
    const row = list.data?.receivers.find(item => item.id === endpoint)
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
  // Slack and Discord tiles list only their own channel receivers; Webhooks lists signed cezar JSON receivers.
  const webhookTools = [
    ...channelWebhooks,
    { id: 'webhooks', name: 'Webhooks', format: 'cezar.json.v1', description: 'Send signed task events to your own endpoints.', icon: WebhookIcon },
  ] as const
  webhookTools.forEach(tool => {
    const rows = webhooks.data?.receivers.filter(row => row.format === tool.format) ?? []
    const active = rows.filter(row => row.state === 'active').length
    const attention =
      rows.some(row => ['suspended', 'disabled'].includes(row.state)) ||
      (rows.length > 0 && webhooks.data?.webhookHealth.status !== 'ready')
    tools.push({
      id: tool.id,
      name: tool.name,
      description: tool.description,
      icon: <tool.icon className="size-5" aria-hidden />,
      configuration: <WebhooksSection format={tool.format} webhookOnly={tool.format !== 'cezar.json.v1'} />,
      status: webhooksFailed
        ? 'Status unavailable'
        : webhooksLoading
          ? 'Loading…'
          : unsupported
            ? 'Unavailable on this server'
            : !webhooksEnabled
              ? 'Off on this server'
              : attention
                ? 'Needs attention'
                : active
                  ? `${active} active`
                  : rows.length
                    ? 'Inactive or paused'
                    : 'Not set up',
      loading: !webhooksFailed && webhooksLoading,
      category: 'Webhooks',
      tone:
        webhooksFailed || attention
          ? 'danger'
          : webhooksEnabled && active
            ? 'success'
            : rows.length
              ? 'pending'
              : 'neutral',
      ...(rows.length ? { detail: receiverCount(rows.length) } : {}),
    })
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

  return (
    <IntegrationsGalleryGrid
      tools={tools}
      query={query}
      onQueryChange={setQuery}
      category={category}
      onCategoryChange={setCategory}
      onOpen={openIntegration}
    />
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
