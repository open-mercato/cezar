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
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
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
            <span>cezar {data ? `v${data.version}` : ''}</span>
            {data?.installed.find((entry) => entry.active)?.source === 'local' ? (
              <Badge variant="outline">local build</Badge>
            ) : null}
          </DialogTitle>
          <DialogDescription className="sr-only">Update cezar, pick a release channel or switch versions.</DialogDescription>
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

            <VersionPicker
              data={data}
              picked={picked}
              onPick={setPicked}
              onApply={(version) => apply.mutate(version)}
              applying={apply.isPending}
            />

            {!data.canSelfUpdate ? <InstallHint data={data} /> : null}

            {data.activeRuns > 0 && data.canSelfUpdate ? (
              <p className="rounded-md border border-pending/50 bg-pending/10 px-3 py-2 text-[12.5px] text-foreground">
                {data.activeRuns} task{data.activeRuns === 1 ? ' is' : 's are'} running. A restart interrupts
                them; cezar re-queues or resumes them on the way back up.
              </p>
            ) : null}

            {apply.error ? <p className="text-[12.5px] text-danger">{apply.error.message}</p> : null}

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
]

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
        <div className="text-[13px] font-semibold">Release channel</div>
        <div className="text-[12px] text-muted-foreground">
          {data.channel === 'stable' ? 'Tagged releases.' : 'A fresh build of main every night.'}
        </div>
      </div>
      <div
        role="radiogroup"
        aria-label="Release channel"
        data-slot="channel-toggle"
        className="flex shrink-0 rounded-md border border-border bg-muted/40 p-0.5"
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
                'rounded-[5px] px-3 py-1 text-[12.5px] font-semibold transition-colors',
                active ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
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
  const target = data.updateAvailable
  return (
    <div
      data-slot="self-update-latest"
      className={cn(
        'flex items-center justify-between gap-3 rounded-md border px-3 py-2.5',
        target ? 'border-primary/40 bg-primary/5' : 'border-border bg-card',
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
          <div className="text-[11.5px] text-muted-foreground">checked {new Date(data.checkedAt).toLocaleTimeString()}</div>
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
      <div className="text-[13px] font-semibold">
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
      <p className="text-[11.5px] text-muted-foreground">
        Any version, older ones included. Installed versions stay on disk, so switching back is instant.
      </p>
    </div>
  )
}

function InstallHint({ data }: { data: SelfUpdateStatus }) {
  const command =
    data.installKind === 'checkout'
      ? 'node packages/cezar/dist/index.js install'
      : data.installKind === 'global-npm'
        ? 'cezar install'
        : 'npx cezar-cli install'
  return (
    <div data-slot="self-update-install-hint" className="rounded-md border border-border bg-muted/40 px-3 py-2.5 text-[12.5px]">
      <p>{data.reason}</p>
      <p className="mt-1.5 text-muted-foreground">Run this once, then start cezar with the plain command:</p>
      <pre className="mt-1.5 overflow-x-auto rounded bg-background px-2 py-1.5 font-mono text-[12px]">{command}</pre>
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
      <div className="flex items-center justify-between text-[12.5px]">
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
        className="max-h-40 min-w-0 overflow-y-auto rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[11px] leading-[1.5] break-all whitespace-pre-wrap text-muted-foreground"
      >
        {job.log.join('\n')}
      </pre>
      {job.error ? <p className="text-[12.5px] text-danger">{job.error}</p> : null}
    </div>
  )
}
