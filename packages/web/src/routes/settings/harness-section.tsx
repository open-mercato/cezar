import { NetworkIcon } from 'lucide-react'
import { Link, useParams } from 'react-router'

import { useHarnessStatus } from '@/api/harness'
import type { HarnessModel } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { SettingsCard } from './form-row'

/**
 * Project settings → Harness (spec 2026-07-23-harness-orchestration; user feedback
 * 2026-07-23): the model-access surface for the staged multi-model pipeline. It shows what
 * `GET /api/v1/harness/status` knows and routes model changes to a `cez-setup-harness` task.
 */
export function HarnessSection() {
  const { projectId } = useParams()
  const status = useHarnessStatus()
  const prefix = projectId !== undefined ? `/p/${encodeURIComponent(projectId)}` : ''
  const configureHref = `${prefix}/new?skill=cez-setup-harness&ref=${encodeURIComponent(
    'Configure the multi-model agent harness for this repository — detect and bind the reviewer and worker models I actually have access to.',
  )}`
  const checkHref = `${prefix}/new?skill=cez-setup-harness&ref=${encodeURIComponent(
    'Run cez-setup-harness --check and report the current model readiness table without changing anything.',
  )}`

  if (status.isPending) {
    return (
      <p data-slot="harness-loading" className="p-4 text-ui text-soft-foreground md:p-6">
        Loading harness status…
      </p>
    )
  }
  if (status.isError || status.data === undefined) {
    return (
      <CenteredState
        icon={<NetworkIcon />}
        tone="neutral"
        title="Harness status unavailable"
        subtitle="Could not read the harness configuration — is the server reachable?"
        heading="h2"
      />
    )
  }

  // Feature flag (off by default): the nav hides this section, but the route stays
  // registered, so a direct URL gets the honest explanation instead of a 404.
  if (status.data.enabled === false) {
    return (
      <CenteredState
        icon={<NetworkIcon />}
        tone="neutral"
        title="Multi-model runs are disabled"
        subtitle="Start this cezar instance with CEZ_MULTI_MODEL=1 to enable multi-model runs for every project."
        heading="h2"
      />
    )
  }

  const models = status.data.models ?? []
  const external = models.filter((model) => model.id !== 'claude')

  return (
    <SettingsCard
      title="Models"
      slot="harness-section"
      description="Check access to your models or connect another model. Both actions open an interactive setup task that verifies provider access and prepares changes for your review."
      action={(
        <>
          <Button asChild size="sm" variant="outline"><Link to={checkHref}>Check setup</Link></Button>
          <Button asChild size="sm" variant="contrast"><Link to={configureHref}>Configure models</Link></Button>
        </>
      )}
    >
      <ul>
        {models.map((model) => (
          <ModelRow key={model.id} model={model} />
        ))}
      </ul>
      {external.length === 0 ? (
        <p data-slot="harness-empty" className="px-4 py-2 text-label text-muted-foreground">
          No external models configured — the composer can still seat the Claude, Codex and
          OpenCode models you are signed in to. Configure models to add advisor reviewers such as
          DeepSeek or Kimi.
        </p>
      ) : null}
    </SettingsCard>
  )
}

function ModelRow({ model }: { model: HarnessModel }) {
  return (
    <li className="flex flex-wrap items-center gap-2.5 border-b border-border px-3.5 py-2 text-label last:border-b-0">
      <span className="w-[88px] shrink-0 font-semibold">{model.id}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-meta text-soft-foreground">
        {model.model ?? '—'}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {model.roles.map((role) => (
          <span
            key={role}
            className={cn(
              'rounded-[5px] px-1.5 py-px text-micro font-bold tracking-[0.05em] uppercase',
              role === 'host'
                ? 'bg-primary/15 text-primary'
                : role === 'worker'
                  ? 'bg-violet/15 text-violet'
                  : 'bg-muted text-muted-foreground',
            )}
          >
            {role}
          </span>
        ))}
      </span>
    </li>
  )
}
