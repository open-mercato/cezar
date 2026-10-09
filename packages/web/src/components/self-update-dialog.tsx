import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { getHealth, getSelfUpdate } from '@/api/client'
import {
  useApplySelfUpdate,
  useRefreshSelfUpdate,
  useSelfUpdate,
  useSetSelfUpdateChannel,
  workspaceQueryKeys,
} from '@/api/queries'
import type { SelfUpdateStatus, UpdateChannel } from '@open-mercato/cezar-api-client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

import { DevelopmentPanel, pullOfVersion } from './self-update-development'

/**
 * The dialog behind the footer's version chip (self-update PoC): which channel cezar follows,
 * whether something newer is out, and a picker over every stable release and nightly so a
 * downgrade is one click too. Applying = the server installs into `~/.cezar/versions`, flips
 * `current`, and restarts; the dialog then waits for the new process to answer and reloads.
 *
 * Only a managed install (`cezar install`) can do that to itself. Any other install kind gets
 * the reason and the one command that gets it there — never a download it could not use.
 */
export function SelfUpdateDialog({
  open,
  onOpenChange,
  autoApply,
  brandName = 'cezar',
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  brandName?: string
  /** Start installing this version as soon as the status confirms it can (the title strip's
   *  "Update cezar" button): the dialog then only shows progress. Fires once per mount, and
   *  ONLY when no task is running — a restart interrupts running tasks, so with any in flight
   *  the dialog opens to its warning and waits for "Update & restart" like every other entry. */
  autoApply?: string
}) {
  const status = useSelfUpdate(open)
  const refresh = useRefreshSelfUpdate()
  const setChannel = useSetSelfUpdateChannel()
  const apply = useApplySelfUpdate()
  const [picked, setPicked] = useState<string>('')
  const data = status.data
  const contentRef = useRef<HTMLDivElement>(null)
  const autoApplied = useRef(false)
  useEffect(() => {
    if (!autoApply || autoApplied.current || !data) return
    if (!data.canSelfUpdate || data.job) return
    // Decided once, on the first status: tasks that finish while the dialog is open must not
    // start an install the user has not asked for a second time.
    autoApplied.current = true
    if (data.activeRuns > 0) return
    apply.mutate(autoApply)
  }, [autoApply, data, apply])

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // An install in flight ends in a restart of the cockpit. Closing the dialog would stop
        // the polling and leave nothing on screen saying so — it stays until the job settles.
        if (!next && data?.job?.status === 'running') return
        onOpenChange(next)
      }}
    >
      <DialogContent
        data-slot="self-update-dialog"
        className="sm:max-w-xl"
        ref={contentRef}
        // Radix focuses the first focusable element on open, which here is the close button —
        // a highlighted X on a dialog the user opened to READ a version. Send the initial focus
        // to the panel itself instead: it stays inside the focus trap (Tab reaches the controls,
        // Escape still closes) but nothing is ringed until the keyboard is actually used.
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          contentRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span>{brandName} {data ? `v${data.version}` : ''}</span>
            <ActiveBadge data={data} />
          </DialogTitle>
          <DialogDescription className="sr-only">Update {brandName}, pick a release channel or switch versions.</DialogDescription>
        </DialogHeader>

        {data ? (
          <div className="flex min-w-0 flex-col gap-5">
            <ChannelToggle
              data={data}
              busy={setChannel.isPending}
              onChange={(channel) => {
                setPicked('')
                setChannel.mutate(channel)
              }}
            />

            <LatestCard
              data={data}
              checking={refresh.isPending}
              onCheck={() => refresh.mutate()}
              onApply={(version) => apply.mutate(version)}
              applying={apply.isPending}
            />

            {data.channel === 'development' ? (
              <DevelopmentPanel data={data} onApply={(target) => apply.mutate(target)} applying={apply.isPending} />
            ) : (
              <VersionPicker
                data={data}
                picked={picked}
                onPick={setPicked}
                onApply={(version) => apply.mutate(version)}
                applying={apply.isPending}
              />
            )}

            {!data.canSelfUpdate ? <InstallHint data={data} /> : null}

            {data.activeRuns > 0 && data.canSelfUpdate ? (
              <p className="rounded-lg bg-pending/10 px-3.5 py-2.5 text-[13px] text-foreground">
                {data.activeRuns} task{data.activeRuns === 1 ? ' is' : 's are'} running. A restart interrupts
                them; {brandName} re-queues or resumes them on the way back up.
              </p>
            ) : null}

            {setChannel.error ? (
              <p className="text-[13px] text-danger">
                Could not switch the channel: {setChannel.error.message}
                {/* The cockpit is read from disk on every request, the server only at boot: a rebuilt
                    worktree can show a channel its still-running server has never heard of. */}
                {setChannel.variables === 'development'
                  ? ` The running ${brandName} server predates the Development channel — restart ${brandName} to load it.`
                  : null}
              </p>
            ) : null}

            {apply.error ? <p className="text-[13px] text-danger">{apply.error.message}</p> : null}

            {data.job ? <JobPanel data={data} /> : null}
          </div>
        ) : status.error ? (
          <p className="text-[13px] text-danger">{status.error.message}</p>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

const CHANNELS: { value: UpdateChannel; label: string }[] = [
  { value: 'stable', label: 'Stable' },
  { value: 'nightly', label: 'Nightly' },
  { value: 'development', label: 'Development' },
]

const CHANNEL_HINTS: Record<UpdateChannel, string> = {
  stable: 'Tagged releases.',
  nightly: 'A fresh build of main every night.',
  development: 'A cezar worktree or an open pull request. Never updates on its own.',
}

function ChannelToggle({
  data,
  busy,
  onChange,
}: {
  data: SelfUpdateStatus
  busy: boolean
  onChange: (channel: UpdateChannel) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-[13.5px] font-medium">Release channel</div>
        <div className="text-xs text-muted-foreground">
          {CHANNEL_HINTS[data.channel]}
        </div>
      </div>
      <div
        role="radiogroup"
        aria-label="Release channel"
        data-slot="channel-toggle"
        className="flex shrink-0 gap-0.5 rounded-lg bg-muted p-[3px]"
      >
        {CHANNELS.map((channel) => {
          const active = data.channel === channel.value
          return (
            <button
              key={channel.value}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={busy}
              onClick={() => !active && onChange(channel.value)}
              className={cn(
                'flex h-7 items-center rounded-md px-3 text-[13px] font-medium transition-colors',
                active ? 'bg-card text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {channel.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function LatestCard({
  data,
  checking,
  onCheck,
  onApply,
  applying,
}: {
  data: SelfUpdateStatus
  checking: boolean
  onCheck: () => void
  onApply: (version: string) => void
  applying: boolean
}) {
  const jobBusy = data.job?.status === 'running' || data.job?.status === 'restarting'
  // A linked worktree or a local build shares its version number with a release but is not that
  // release: "newest version" would be a claim about code cezar did not ship. Offer the channel's
  // newest release as the way back instead.
  const active = data.installed.find((entry) => entry.active)
  const pr = active?.source === 'registry' ? pullOfVersion(active.version) : null
  const dev = active && (active.source === 'link' || active.source === 'local' || pr !== null) ? active : null
  if (dev || data.channel === 'development') {
    // Development never offers an update; the way back to releases is the channel toggle.
    const release = data.channel === 'development' ? null : data.latest[data.channel]
    // "Back to" only when that release is really on disk; otherwise it is a download.
    const releaseInstalled = release !== null && data.installed.some((entry) => entry.source === 'registry' && entry.id === release)
    // Stacked rather than side by side: branch names and nightly versions are long enough to
    // squeeze a one-row layout into a narrow word-per-line column.
    return (
      <div data-slot="self-update-latest" className="flex flex-col gap-2 rounded-lg border border-border bg-card px-4 py-3 shadow-xs">
        <div className="min-w-0 text-[13px] break-words">
          {dev?.source === 'link' ? (
            <>
              Running worktree <span className="font-mono text-[13px] font-semibold">{dev.branch ?? dev.id}</span>, not
              a release.
            </>
          ) : dev?.source === 'local' ? (
            <>Running a local build, not a release.</>
          ) : pr !== null ? (
            <>
              Running the preview build of <span className="font-semibold">PR #{pr}</span>, not a release.
            </>
          ) : (
            <>
              Running <span className="font-semibold">v{data.version}</span>. Pick a worktree or a pull request below.
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div className="min-w-0 text-xs break-words text-muted-foreground">
            {data.channel === 'development' ? (
              'Switch the channel back to Stable or Nightly to follow releases again.'
            ) : !data.checkedAt ? (
              'The npm registry has not answered yet.'
            ) : (
              <>
                {release ? (
                  <>
                    Newest {data.channel}: <span className="font-mono text-foreground">v{release}</span> ·{' '}
                  </>
                ) : null}
                checked {new Date(data.checkedAt).toLocaleTimeString()}
              </>
            )}
          </div>
          {data.channel !== 'development' ? (
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <Button variant="ghost" size="sm" onClick={onCheck} disabled={checking || jobBusy}>
                {checking ? 'Checking…' : 'Check again'}
              </Button>
              {release ? (
                <Button
                  size="sm"
                  aria-label={releaseInstalled ? `Back to v${release}` : `Install v${release} & restart`}
                  onClick={() => onApply(release)}
                  disabled={!data.canSelfUpdate || applying || jobBusy}
                >
                  {releaseInstalled ? 'Switch back' : 'Install & restart'}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    )
  }
  const target = data.updateAvailable
  return (
    <div
      data-slot="self-update-latest"
      className={cn(
        'flex items-center justify-between gap-3 rounded-lg border px-4 py-3 shadow-xs',
        target ? 'border-transparent bg-primary/15' : 'border-border bg-card',
      )}
    >
      <div className="min-w-0 text-[13px]">
        {!data.checkedAt ? (
          <span className="text-muted-foreground">The npm registry has not answered yet.</span>
        ) : target ? (
          <>
            <span className="font-semibold">v{target}</span> is available on {data.channel}.
          </>
        ) : (
          <>
            You are on the newest {data.channel} version
            {data.channel === 'nightly' && data.latest.nightly ? ` (v${data.latest.nightly})` : ''}.
          </>
        )}
        {data.checkedAt ? (
          <div className="text-xs text-muted-foreground">checked {new Date(data.checkedAt).toLocaleTimeString()}</div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onCheck} disabled={checking || jobBusy}>
          {checking ? 'Checking…' : 'Check again'}
        </Button>
        {target ? (
          <Button size="sm" onClick={() => onApply(target)} disabled={!data.canSelfUpdate || applying || jobBusy}>
            Update &amp; restart
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function VersionPicker({
  data,
  picked,
  onPick,
  onApply,
  applying,
}: {
  data: SelfUpdateStatus
  picked: string
  onPick: (version: string) => void
  onApply: (version: string) => void
  applying: boolean
}) {
  const jobBusy = data.job?.status === 'running' || data.job?.status === 'restarting'
  // Local builds only exist in `installed`; registry versions come from `available`, with the
  // `installed` flag telling the two apart in the label.
  const options = useMemo(() => {
    const locals =
      data.channel === 'stable'
        ? data.installed
            .filter((entry) => entry.source === 'local')
            .map((entry) => ({ value: entry.id, label: `v${entry.version} · local build`, installed: true, active: entry.active }))
        : []
    const remote = data.available
      .filter((entry) => entry.channel === data.channel)
      .map((entry) => ({
        value: entry.version,
        label: `v${entry.version}${entry.publishedAt ? ` · ${entry.publishedAt.slice(0, 10)}` : ''}`,
        installed: entry.installed,
        active: data.installed.some((row) => row.active && row.id === entry.version),
      }))
    return [...locals, ...remote]
  }, [data])
  const selected = options.find((option) => option.value === picked)
  return (
    <div data-slot="self-update-picker" className="flex min-w-0 flex-col gap-2">
      <div className="text-[13.5px] font-medium">
        Pick a version <span className="font-normal text-muted-foreground">· {data.channel}</span>
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <Select value={picked} onValueChange={onPick} disabled={options.length === 0 || jobBusy}>
          <SelectTrigger size="sm" aria-label="Version" className="w-0 min-w-0 flex-1 text-[13px]">
            <SelectValue placeholder={options.length === 0 ? 'No versions known' : 'Choose a version to install'} />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                <span className="flex items-center gap-2">
                  {option.label}
                  {option.active ? (
                    <Badge variant="secondary">current</Badge>
                  ) : option.installed ? (
                    <Badge variant="outline">installed</Badge>
                  ) : null}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant="contrast"
          onClick={() => selected && onApply(selected.value)}
          disabled={!selected || selected.active || !data.canSelfUpdate || applying || jobBusy}
        >
          {selected?.installed ? 'Switch & restart' : 'Install & restart'}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Any version, older ones included. Installed versions stay on disk, so switching back is instant.
      </p>
    </div>
  )
}

function ActiveBadge({ data }: { data: SelfUpdateStatus | undefined }) {
  const active = data?.installed.find((entry) => entry.active)
  if (active?.source === 'local') return <Badge variant="outline">local build</Badge>
  if (active?.source === 'link') return <Badge variant="outline">worktree · {active.branch ?? active.id}</Badge>
  const pr = active ? pullOfVersion(active.version) : null
  if (pr !== null) return <Badge variant="outline">PR #{pr} build</Badge>
  return null
}

function InstallHint({ data }: { data: SelfUpdateStatus }) {
  const command =
    data.installKind === 'checkout'
      ? 'node packages/cezar/dist/index.js install'
      : data.installKind === 'global-npm'
        ? 'cezar install'
        : 'npx cezar-cli install'
  return (
    <div data-slot="self-update-install-hint" className="rounded-lg bg-muted/60 px-4 py-3 text-[13px]">
      <p>{data.reason}</p>
      <p className="mt-1.5 text-muted-foreground">Run this once, then start cezar with the plain command:</p>
      <pre className="mt-1.5 overflow-x-auto rounded-md border border-border bg-card px-2.5 py-2 font-mono text-xs">{command}</pre>
    </div>
  )
}

/** The install log while npm runs, then the restart wait: once the process is gone, poll until a
 *  fresh one (no job on its status) answers, and reload into it. */
function JobPanel({ data }: { data: SelfUpdateStatus }) {
  const job = data.job!
  const queryClient = useQueryClient()
  const logRef = useRef<HTMLPreElement>(null)
  const [comeback, setComeback] = useState<'waiting' | 'back' | 'timeout'>('waiting')

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [job.log.length])

  useEffect(() => {
    if (job.status !== 'restarting') return
    let cancelled = false
    const startedAt = Date.now()
    const back = () => {
      setComeback('back')
      queryClient.removeQueries({ queryKey: workspaceQueryKeys.selfUpdate })
      window.setTimeout(() => window.location.reload(), 400)
    }
    const tick = async () => {
      if (cancelled) return
      try {
        // Health is the one route EVERY version answers — a downgrade may land on a cezar that
        // predates the update route. A different version is the new process; the same version
        // (a switch between two builds of one release) is settled by the update status, which
        // the old process answers with this very job and the new one without.
        const health = await getHealth()
        if (health.version !== data.version) return back()
        const fresh = await getSelfUpdate().catch(() => null)
        if (fresh && !fresh.job) return back()
      } catch {
        // Down between the two processes — expected.
      }
      if (Date.now() - startedAt > 90_000) {
        setComeback('timeout')
        return
      }
      window.setTimeout(tick, 1_000)
    }
    window.setTimeout(tick, 1_500)
    return () => {
      cancelled = true
    }
  }, [job.status, data.version, queryClient])

  return (
    <div data-slot="self-update-job" className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-center justify-between text-[13px]">
        <span className="font-semibold">
          {job.status === 'running'
            ? `Installing ${job.target}…`
            : job.status === 'failed'
              ? `Install of ${job.target} failed`
              : comeback === 'back'
                ? 'Back — reloading'
                : comeback === 'timeout'
                  ? 'Restart took too long — reload the page by hand'
                  : `Restarting into ${job.target}…`}
        </span>
      </div>
      <pre
        ref={logRef}
        className="max-h-40 min-w-0 overflow-y-auto rounded-lg bg-muted/60 px-3 py-2 font-mono text-[11px] leading-[1.5] break-all whitespace-pre-wrap text-muted-foreground"
      >
        {job.log.join('\n')}
      </pre>
      {job.error ? <p className="text-[13px] text-danger">{job.error}</p> : null}
    </div>
  )
}
