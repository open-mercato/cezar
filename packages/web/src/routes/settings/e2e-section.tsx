import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckIcon, MinusIcon } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'

import { E2E_CREDENTIAL_NAMES, queryScope, type E2eCredentialName, type RunStatus } from '@open-mercato/cezar-api-client'
import { startE2eSetup } from '@/api/client'
import { queryKeys, useE2eStatus, useRun } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { scopeTo } from '@/lib/project-router'

/** The provider behind each key, as the person picking one knows it. */
const PROVIDER_LABELS: Record<E2eCredentialName, string> = {
  AI_GATEWAY_API_KEY: 'Vercel AI Gateway',
  OPENAI_API_KEY: 'OpenAI',
  ANTHROPIC_API_KEY: 'Anthropic',
  OPENROUTER_API_KEY: 'OpenRouter',
}

const IN_FLIGHT: ReadonlySet<RunStatus> = new Set(['queued', 'running', 'waiting'])

/** What a setup run's status means for the person waiting on it. */
function setupLine(status: RunStatus): string {
  if (IN_FLIGHT.has(status)) return 'Setting up — cezar is installing and configuring e2e in its own worktree.'
  if (status === 'review') return 'Ready for review — merge the setup task’s branch to finish.'
  if (status === 'done') return 'Setup finished.'
  if (status === 'failed') return 'The last setup failed — open the task to see why, then try again.'
  return 'The last setup was cancelled.'
}

function Row({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2 text-sm" data-ok={ok}>
      {ok ? <CheckIcon className="size-4 text-success" aria-hidden /> : <MinusIcon className="size-4 text-muted-foreground" aria-hidden />}
      <span className={ok ? undefined : 'text-muted-foreground'}>{children}</span>
    </li>
  )
}

/**
 * Settings → project → End-to-end tests (spec 2026-10-10-e2e-one-click-setup). One button: cezar
 * installs and configures TesterArmy's `e2e` as a task that ends at the review gate. The model key
 * is optional — smoke tests run without one — and goes to the project's secret store for check
 * steps only, never to an agent.
 */
export function E2eSection() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const status = useE2eStatus()
  // The run record is what the event stream keeps live; the status payload is a snapshot.
  const setupRun = useRun(status.data?.setup?.runId)
  const [provider, setProvider] = useState<E2eCredentialName>('AI_GATEWAY_API_KEY')
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)

  const setupStatus = setupRun.data?.status ?? status.data?.setup?.status
  const inFlight = setupStatus !== undefined && IN_FLIGHT.has(setupStatus)
  const credentials = status.data?.credentials ?? []
  const installed = Boolean(status.data?.configFile && status.data.workflow)

  const starting = useMutation({
    mutationFn: async () => {
      const projectId = queryScope()
      const response = await startE2eSetup(key ? { credential: { name: provider, value: key } } : {})
      return { projectId, runId: response.runId }
    },
    onSuccess: async ({ projectId, runId }) => {
      setKey('')
      setError(null)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.e2e.allFor(projectId ?? '') }),
        queryClient.invalidateQueries({ queryKey: queryKeys.secrets.allFor(projectId ?? '') }),
      ])
      toast('e2e setup started')
      if (queryScope() === projectId) void navigate(scopeTo(projectId, `/tasks/${runId}`))
    },
    // Keep the key on failure: a transient 409 should not cost a re-paste.
    onError: (e: Error) => setError(e.message),
  })

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4 md:p-6" data-slot="e2e-settings">
      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">Browser end-to-end tests</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          cezar sets up <a className="underline" href="https://github.com/tester-army/e2e" target="_blank" rel="noreferrer">TesterArmy e2e</a> for
          this project: it installs it, points it at your dev server, writes a smoke test and an
          {' '}<code>implement-and-e2e</code> workflow, and proves it all passes — as a task you review and merge.
        </p>
        {status.isPending ? <p className="mt-4 text-sm text-muted-foreground">Loading…</p> : null}
        {status.isError ? <p role="alert" className="mt-4 text-sm text-danger">{status.error.message}</p> : null}
        {status.data ? (
          <ul className="mt-4 flex flex-col gap-1.5" aria-label="e2e status">
            <Row ok={Boolean(status.data.configFile)}>{status.data.configFile ? <>Configured (<code>{status.data.configFile}</code>)</> : 'Not configured in this checkout'}</Row>
            <Row ok={status.data.workflow}><code>implement-and-e2e</code> workflow {status.data.workflow ? 'available' : 'not added yet'}</Row>
            <Row ok={credentials.length > 0}>
              {credentials.length > 0
                ? <>Model key: <code>{credentials.join(', ')}</code></>
                : 'No model key — smoke tests run without one; agent steps need one'}
            </Row>
          </ul>
        ) : null}
        {status.data?.setup && setupStatus ? (
          <p className="mt-3 text-sm" data-slot="e2e-setup-run" data-status={setupStatus}>
            {setupLine(setupStatus)}{' '}
            <Link className="underline" to={scopeTo(queryScope(), `/tasks/${status.data.setup.runId}`)}>Open the setup task</Link>
          </p>
        ) : null}
      </section>

      <form className="rounded-lg border border-border bg-card p-4" autoComplete="off" onSubmit={(event) => { event.preventDefault(); starting.mutate() }}>
        <h2 className="text-sm font-semibold">{installed ? 'Set up again' : 'Set up e2e'}</h2>
        <label className="mt-3 block text-sm">Model provider
          <select aria-label="Model provider" value={provider} onChange={(event) => setProvider(event.target.value as E2eCredentialName)}
            className="mt-1 block w-full rounded border border-border bg-background p-2 outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50">
            {E2E_CREDENTIAL_NAMES.map((name) => (
              <option key={name} value={name}>{PROVIDER_LABELS[name]} ({name}){credentials.includes(name) ? ' — stored' : ''}</option>
            ))}
          </select>
        </label>
        <label className="mt-3 block text-sm">API key <span className="text-muted-foreground">(optional)</span>
          <input aria-label="API key" type="password" autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)}
            placeholder={credentials.includes(provider) ? 'stored — leave empty to keep it' : ''}
            className="mt-1 block w-full rounded border border-border bg-background p-2" />
        </label>
        <p className="mt-1 text-xs text-muted-foreground">
          Stored encrypted as a project secret for check steps only — never handed to an agent session.
        </p>
        {error ? <p role="alert" className="mt-2 text-sm text-danger">{error}</p> : null}
        <div className="mt-3">
          <Button type="submit" disabled={starting.isPending || inFlight || !status.data}>
            {inFlight ? 'Setup in progress…' : installed ? 'Set up again' : 'Set up e2e'}
          </Button>
        </div>
      </form>
    </div>
  )
}
