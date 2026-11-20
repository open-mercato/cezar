import { useState } from 'react'
import { Link } from 'react-router'
import type { ProviderStatus } from '@open-mercato/cezar-api-client'

import { ApiError } from '@/api/client'
import { useConnectAgentAccount, useHealth, useProviderStatus, useRunnerModels } from '@/api/queries'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

export function CursorConnection({ status, installCommand }: { status: ProviderStatus | undefined; installCommand: string }) {
  const connect = useConnectAgentAccount()
  const health = useHealth()
  const connected = status?.status === 'connected'
  const providers = useProviderStatus()
  const enabled = providers.data?.providers.find((row) => row.provider === 'cursor')?.enabled ?? status?.enabled ?? true
  const models = useRunnerModels('cursor', connected)
  const [notice, setNotice] = useState<{ message: string; command?: string } | null>(null)
  const local = health.data?.capabilities?.localHandoff === true
  const missing = status?.status === 'not-installed'

  return (
    <div data-slot="cursor-connection" className="flex flex-col gap-3 rounded-md border border-border/60 bg-muted/30 p-3 text-label">
      <p>
        Use your Cursor account with the local Cursor Agent CLI. Sign in with the same account you
        use at <a className="underline" href="https://cursor.com/agents" target="_blank" rel="noreferrer">cursor.com/agents</a>, then Verify connection.
        Cezar runs Cursor in this project's local worktree; attaching or listing existing Cloud Agent sessions is not supported here.
      </p>
      {missing ? (
        <p>
          Install Cursor CLI on the machine running Cezar: <code className="select-all break-all">{installCommand}</code>.
          Then Verify connection and sign in. <a className="underline" href="https://cursor.com/docs/cli/installation" target="_blank" rel="noreferrer">Installation help</a>
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {local ? (
            <Button
              type="button"
              size="sm"
              data-action="cursor-connect"
              disabled={connect.isPending || status === undefined}
              onClick={() => {
                setNotice(null)
                connect.mutate({ provider: 'cursor', reconnect: true }, {
                  onSuccess: (result) => setNotice({
                    message: 'Finish signing in with Cursor in the terminal and browser, then Verify connection.',
                    command: result.command,
                  }),
                  onError: (error) => setNotice({
                    message: error.message,
                    ...(error instanceof ApiError && error.command ? { command: error.command } : {}),
                  }),
                })
              }}
            >
              {connect.isPending ? 'Opening sign-in…' : connected ? 'Sign in again' : 'Connect Cursor account'}
            </Button>
          ) : (
            <p>Sign in on the machine hosting Cezar with <code className="select-all">agent login</code>, then Verify connection.</p>
          )}
          <a className="underline" href="https://cursor.com/docs/cli/reference/authentication" target="_blank" rel="noreferrer">Sign-in help</a>
        </div>
      )}
      {notice ? (
        <div role="status" className="flex flex-col gap-1">
          <p>{notice.message}</p>
          {notice.command ? <code className="select-all break-all">{notice.command}</code> : null}
        </div>
      ) : null}
      <p className="text-muted-foreground">
        A browser session alone does not sign in the CLI. You can also use a Cursor user API key via
        CURSOR_API_KEY in Cezar's environment. Cezar cannot import browser cookies or store a Cursor API key here.
      </p>
      {connected ? (
        <div data-slot="cursor-models" className="flex flex-col gap-2 border-t border-border/60 pt-2">
          <p className="font-medium">Cursor models</p>
          {models.isPending ? <p>Loading models from Cursor CLI…</p> : models.isError || models.data?.source === 'unavailable' || !models.data?.models.length ? (
            <p role="status">Models could not be verified. Run <code>agent models</code> on the machine running Cezar to check account access, then Verify connection to retry.</p>
          ) : (
            <>
              {models.data.stale ? <p role="status">Showing previously discovered models. Verify connection to retry Cursor.</p> : null}
              <ul className="flex flex-wrap gap-2" aria-label="Available Cursor models">
                {models.data.models.map((model) => <li key={model.id}><Badge variant="outline">{model.label}</Badge></li>)}
              </ul>
            </>
          )}
          <p className="text-muted-foreground">A connected CLI does not guarantee access to every model. Cursor enforces your plan and team permissions when a task runs.</p>
          {enabled ? (
            <Button asChild size="sm" variant="outline" className="self-start">
              <Link to="/new?runner=cursor">New task with Cursor</Link>
            </Button>
          ) : (
            <p>Cursor is disabled for tasks. Enable Cursor before starting a task. <Link className="underline" to="/settings/agents">Open task agent settings</Link></p>
          )}
        </div>
      ) : null}
    </div>
  )
}
