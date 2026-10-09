import { ZapIcon } from 'lucide-react'
import { useParams, useSearchParams } from 'react-router'

import { Page, PageBody, PageHeader } from '@/components/page'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Spinner } from '@/components/ui/spinner'
import { useNavigate } from '@/lib/project-router'

import { AutomationEditor } from './editor'
import { AutomationLog } from './log'
import { AutomationsList } from './automations-list'
import { useAutomationActions, useAutomationsGate, useAutomationsQuery } from './use-automations'

export type AutomationsView = 'list' | 'week' | 'day'

/**
 * `/automations`, `/automations/new`, `/automations/:id`, `/automations/:id/log` (spec
 * 2026-09-14-automations-redesign § UI/UX). One route component owns the gate — health must
 * have answered, and the capability must be on — so all four modes degrade identically: a cold
 * deep link never paints an editor whose every request would 409.
 *
 * The list's view (`list | week | day`) is a `?view=` search param, so a reload and a shared link
 * keep it.
 */
export function AutomationsRoute({ mode = 'list' }: { mode?: 'list' | 'new' | 'edit' | 'log' }) {
  const { automationId } = useParams()
  const navigate = useNavigate()
  const gate = useAutomationsGate()
  const query = useAutomationsQuery(gate.known && !gate.off)
  const actions = useAutomationActions(query.data)
  const [searchParams, setSearchParams] = useSearchParams()
  const view = viewOf(searchParams.get('view'))

  if (!gate.known) {
    return <StatePage text="Loading automations…" loading />
  }
  if (gate.off) {
    return (
      <Page data-route="automations">
        <PageHeader title="Automations" />
        <Empty data-slot="centered-state" className="flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon"><ZapIcon /></EmptyMedia>
            <EmptyTitle>Automations are off</EmptyTitle>
            <EmptyDescription>
              This cockpit was started with <span className="font-mono text-xs">CEZ_AUTOMATIONS=0</span>. Unset it and restart the service to turn automations on.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </Page>
    )
  }

  const back = () => navigate('/automations')
  if (mode === 'new') {
    return <AutomationEditor data={query.data} onBack={back} onSaved={back} />
  }
  if (mode === 'edit') {
    const automation = query.data?.automations.find((item) => item.id === automationId)
    if (query.data && !automation) return <StatePage text="Automation not found." />
    return automation
      ? <AutomationEditor data={query.data} automation={automation} actions={actions} onBack={back} onSaved={back} onLog={() => navigate(`/automations/${encodeURIComponent(automation.id)}/log`)} />
      : <StatePage text="Loading automation…" loading />
  }
  if (mode === 'log') {
    const automation = query.data?.automations.find((item) => item.id === automationId)
    return automationId
      ? <AutomationLog automationId={automationId} automation={automation} timeZone={query.data?.timeZone} onBack={back} />
      : <StatePage text="Automation not found." />
  }
  return (
    <AutomationsList
      data={query.data}
      error={query.error ? String(query.error instanceof Error ? query.error.message : query.error) : undefined}
      actions={actions}
      view={view}
      onViewChange={(next) => setSearchParams((current) => {
        const params = new URLSearchParams(current)
        if (next === 'list') params.delete('view')
        else params.set('view', next)
        return params
      }, { replace: true })}
    />
  )
}

function viewOf(raw: string | null): AutomationsView {
  return raw === 'week' || raw === 'day' ? raw : 'list'
}

export function PageState({ text, loading = false }: { text: string; loading?: boolean }) {
  return (
    <div className="flex items-center justify-center gap-2 rounded-xl border border-dashed p-10 text-center text-[13px] text-muted-foreground">
      {loading ? <Spinner /> : null}
      {text}
    </div>
  )
}

/** A whole-page state under the Automations title: loading, not found. */
function StatePage({ text, loading = false }: { text: string; loading?: boolean }) {
  return (
    <Page data-route="automations">
      <PageHeader title="Automations" />
      <PageBody>
        <PageState text={text} loading={loading} />
      </PageBody>
    </Page>
  )
}
