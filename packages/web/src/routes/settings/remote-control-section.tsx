import { SmartphoneIcon } from 'lucide-react'

import { useRemoteControl, useStartRemoteControl, useStopRemoteControl } from '@/api/queries'
import type { RemoteControlStatus } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'

/**
 * Project settings → Remote Control (spec 2026-08-26-remote-control): start/stop the
 * cockpit-managed `claude remote-control` server for this project, and hand out the
 * claude.ai link once it is connected — the cockpit's `/remote-control`.
 *
 * No polling: both mutations answer with the final state (the server waits for the
 * claude.ai link before responding), so the section renders exactly what the last
 * answer said. The CLI's own refusals — the workspace-trust one included — arrive in
 * `status.error` and are shown verbatim, because the fix ("run `claude` there once")
 * is in the CLI's wording already.
 */
export function RemoteControlSection() {
  const status = useRemoteControl()

  if (status.isPending) {
    return (
      <p data-slot="remote-control-loading" className="p-4 text-[13px] text-soft-foreground md:p-6">
        Loading Remote Control state…
      </p>
    )
  }
  if (status.isError) {
    return (
      <CenteredState
        icon={<SmartphoneIcon />}
        tone="danger"
        title="Remote Control state did not load"
        subtitle={status.error.message}
        heading="h2"
      />
    )
  }
  if (!status.data.available) {
    return (
      <CenteredState
        icon={<SmartphoneIcon />}
        tone="neutral"
        title="Remote Control is unavailable here"
        subtitle={status.data.reason ?? 'This deployment cannot start local processes.'}
        heading="h2"
      />
    )
  }
  return <RemoteControlPanel status={status.data} />
}

function RemoteControlPanel({ status }: { status: RemoteControlStatus }) {
  const start = useStartRemoteControl()
  const stop = useStopRemoteControl()

  const startNow = () =>
    start.mutate(undefined, {
      onSuccess: (result) => {
        if (result.state === 'running') toast('Remote Control connected')
      },
      onError: (error: Error) => toast(error.message, { tone: 'danger' }),
    })
  const stopNow = () =>
    stop.mutate(undefined, {
      onSuccess: () => toast('Remote Control stopped'),
      onError: (error: Error) => toast(error.message, { tone: 'danger' }),
    })

  const running = status.state === 'running'
  const busy = start.isPending || stop.isPending

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div data-slot="remote-control-status" className="flex items-center gap-2">
        <StatusDot tone={running ? 'success' : status.state === 'error' ? 'danger' : 'neutral'} />
        <span className="text-[13px] font-medium">
          {start.isPending
            ? 'Connecting to claude.ai…'
            : running
              ? 'Connected — this project is controllable from claude.ai'
              : status.state === 'error'
                ? 'Remote Control could not start'
                : 'Not connected'}
        </span>
      </div>

      <p className="max-w-prose text-[13px] leading-relaxed text-muted-foreground">
        Remote Control runs <code className="font-mono text-[12px]">claude remote-control</code> in
        this project&apos;s folder, so you can open sessions in this repo from{' '}
        <span className="font-medium">claude.ai/code</span> or the Claude mobile app — the same
        thing <code className="font-mono text-[12px]">/remote-control</code> does in an interactive
        session. In a git repo, sessions started from your phone get their own worktrees; the
        server stops with cezar.
      </p>

      {running && status.url ? (
        <p data-slot="remote-control-link" className="text-[13px]">
          <a
            href={status.url}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-violet underline underline-offset-2"
          >
            Open this project on claude.ai/code →
          </a>
        </p>
      ) : null}

      {status.state === 'error' && status.error ? (
        <p
          data-slot="remote-control-error"
          className="max-w-prose rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-[12px] leading-relaxed text-danger"
        >
          {status.error}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        {running ? (
          <Button data-slot="remote-control-stop" variant="outline" disabled={busy} onClick={stopNow}>
            {stop.isPending ? 'Stopping…' : 'Stop Remote Control'}
          </Button>
        ) : (
          <Button data-slot="remote-control-start" disabled={busy} onClick={startNow}>
            {start.isPending ? 'Starting…' : status.state === 'error' ? 'Try again' : 'Start Remote Control'}
          </Button>
        )}
      </div>
    </div>
  )
}
