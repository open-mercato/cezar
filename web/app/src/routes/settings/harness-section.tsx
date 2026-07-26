import { NetworkIcon } from 'lucide-react'
import { Link, useParams } from 'react-router'

import { useHarnessStatus } from '@/api/queries'
import type { HarnessModel } from '@/api/types'
import { CenteredState } from '@/components/centered-state'
import { cn } from '@/lib/utils'
import { HARNESS_PROFILE_OPTIONS } from '../new-task-form'

/**
 * Project settings → Harness (spec 2026-07-23-harness-orchestration; user feedback
 * 2026-07-23): the model-access surface for the staged multi-model pipeline. It shows what
 * `GET /api/harness/status` knows — the configured roster, which profiles the repo offers,
 * and which of them this cezar's driver conducts — and routes every change to an
 * `cez-setup-harness` task: the om pipeline owns `.ai/agentic.config.json`, cezar reads
 * it and never writes it.
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
      <p data-slot="harness-loading" className="p-4 text-[13px] text-soft-foreground md:p-6">
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

  // Defensive against an older server serving a newer bundle: absent arrays read as empty
  // (this exact skew blanked the page during development — never trust the wire shape).
  const { configured } = status.data
  const profiles = status.data.profiles ?? []
  const driven = status.data.driven ?? []
  const models = status.data.models ?? []
  const external = models.filter((model) => model.id !== 'claude')

  return (
    <div className="flex flex-col gap-5 p-4 md:p-6" data-slot="harness-section">
      <section>
        <h3 className="text-[13px] font-semibold">Profiles</h3>
        <p className="mt-1 max-w-[62ch] text-[12.5px] leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">standard</span> needs no provider config at
          all — Claude implements and a fresh Claude context reviews. Council and worker profiles
          use the models bound below.
        </p>
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {profiles.map((profile) => {
            const isDriven = driven.includes(profile)
            const label = HARNESS_PROFILE_OPTIONS.find((o) => o.id === profile)?.label ?? profile
            return (
              <span
                key={profile}
                className={cn(
                  'inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium',
                  isDriven
                    ? 'border-primary/50 text-foreground'
                    : 'border-border text-muted-foreground',
                )}
              >
                {label}
                <span className="font-mono text-[10px] text-soft-foreground/70">{profile}</span>
                <span className="text-[10px] tracking-[0.05em] text-soft-foreground uppercase">
                  {isDriven ? 'in cezar' : 'via desktop wrappers'}
                </span>
              </span>
            )
          })}
        </div>
      </section>

      <section>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[13px] font-semibold">Models</h3>
          <div className="flex items-center gap-1.5">
            <Link
              to={checkHref}
              className="inline-flex h-7 items-center rounded-lg border border-border px-2.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Check setup
            </Link>
            <Link
              to={configureHref}
              className="inline-flex h-7 items-center rounded-lg bg-contrast px-2.5 text-xs font-semibold text-contrast-foreground"
            >
              Configure models
            </Link>
          </div>
        </div>
        <p className="mt-1 max-w-[62ch] text-[12.5px] leading-relaxed text-muted-foreground">
          Bindings live in the repo's <code className="font-mono text-[11px]">.ai/agentic.config.json</code>,
          owned by the om pipeline — both actions run{' '}
          <code className="font-mono text-[11px]">cez-setup-harness</code> as an interactive
          task, which probes providers and stages the config for your review.
        </p>

        <ul className="mt-3 flex flex-col overflow-hidden rounded-xl border border-border bg-card">
          {models.map((model) => (
            <ModelRow key={model.id} model={model} />
          ))}
        </ul>
        {external.length === 0 ? (
          <p data-slot="harness-empty" className="mt-2 text-[12.5px] text-muted-foreground">
            No external models configured{configured ? ' in the active profiles' : ''} — runs use
            the <span className="font-medium text-foreground">standard</span> profile with Claude
            only. Configure models to unlock the <code className="font-mono text-[11px]">multi</code>{' '}
            review council and worker offloading.
          </p>
        ) : null}
      </section>
    </div>
  )
}

function ModelRow({ model }: { model: HarnessModel }) {
  return (
    <li className="flex flex-wrap items-center gap-2.5 border-b border-border px-3.5 py-2 text-[12.5px] last:border-b-0">
      <span className="w-[88px] shrink-0 font-semibold">{model.id}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-soft-foreground">
        {model.model ?? '—'}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {model.roles.map((role) => (
          <span
            key={role}
            className={cn(
              'rounded-[5px] px-1.5 py-px text-[10px] font-bold tracking-[0.05em] uppercase',
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
      <span className="hidden shrink-0 text-[11px] text-soft-foreground md:inline">
        {(model.profiles ?? []).join(' · ') || 'unused'}
      </span>
    </li>
  )
}
