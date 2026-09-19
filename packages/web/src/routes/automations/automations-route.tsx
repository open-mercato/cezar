import { ZapIcon } from 'lucide-react'
import { useParams, useSearchParams } from 'react-router'

import { CenteredState } from '@/components/centered-state'
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
    return (
      <div data-route="automations" className="flex min-h-full flex-col p-3 md:p-5">
        <PageState text="Loading automations…" />
      </div>
    )
  }
  if (gate.off) {
    return (
      <div data-route="automations" className="flex min-h-full flex-col p-3 md:p-5">
        <CenteredState
          icon={<ZapIcon />}
          tone="neutral"
          title="Automations are off"
          subtitle="This cockpit was started with CEZ_AUTOMATIONS=0. Unset it and restart cezar to turn automations on."
          heading="h2"
        />
      </div>
    )
  }

  const back = () => navigate('/automations')
  if (mode === 'new') {
    return <AutomationEditor data={query.data} onBack={back} onSaved={back} />
  }
  if (mode === 'edit') {
    const automation = query.data?.automations.find((item) => item.id === automationId)
    if (query.data && !automation) return <div data-route="automations" className="p-5"><PageState text="Automation not found." /></div>
    return automation
      ? <AutomationEditor data={query.data} automation={automation} actions={actions} onBack={back} onSaved={back} onLog={() => navigate(`/automations/${encodeURIComponent(automation.id)}/log`)} />
      : <div data-route="automations" className="p-5"><PageState text="Loading automation…" /></div>
  }
  if (mode === 'log') {
    const automation = query.data?.automations.find((item) => item.id === automationId)
    return automationId
      ? <AutomationLog automationId={automationId} automation={automation} timeZone={query.data?.timeZone} onBack={back} />
      : <div data-route="automations" className="p-5"><PageState text="Automation not found." /></div>
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

export function PageState({ text }: { text: string }) {
  return <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">{text}</div>
}
