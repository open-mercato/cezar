import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { DEFAULT_AGENT_ACCOUNT_ID, runnerSupportsReasoningEffort, type ApiRun, type ChangeRunEngineInput, type Runner } from '@open-mercato/cezar-api-client'
import { useAgentAccounts } from '@/api/agent-accounts'
import { changeRunEngine } from '@/api/client'
import { queryKeys, useConfig, useProviderStatus, useRunnerModels } from '@/api/queries'
import { PickerPill, RunnerPill } from '@/components/picker-pill'
import { ReasoningEffortPill } from '@/components/reasoning-effort-pill'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { RUNNER_ORDER, usableRunners } from '@/lib/provider-status'
import { modelCatalogStatus, modelsForRunner, reasoningEffortsForModel, resolveModel, resolveReasoningEffort } from '@/routes/new-task-form'

/** Mirror the pending continuation's selection; a workflow step can override the run's model. */
export function queuedEngineSelection(run: ApiRun, runner = run.runner ?? 'claude') {
  const pending = run.steps.at(-1)
  if (!pending?.id.startsWith('continue-') || pending.status !== 'pending') {
    return { model: run.model, effort: run.reasoningEffort, account: run.agentProfile }
  }
  const lastSession = [...run.steps].reverse().find(step => step.sessionId)
  const accountMatches = run.agentProfile === undefined || run.agentProfile === (lastSession?.profileId ?? DEFAULT_AGENT_ACCOUNT_ID)
  const owner = !pending.freshSession && accountMatches && (lastSession?.backend ?? runner) === runner ? lastSession : undefined
  const sessionSteps = owner ? run.steps.filter(step => step.sessionId === owner.sessionId) : []
  const latestModel = [...sessionSteps].reverse().find(step => step.model !== undefined)?.model
  const definition = run.workflowDef?.steps.find(step => step.id === sessionSteps[0]?.id)
  const workflowModel = definition && (definition.runner === undefined || definition.runner === runner) ? definition.model : undefined
  return {
    model: pending.model ?? latestModel ?? workflowModel ?? run.model,
    effort: pending.reasoningEffort,
    account: run.agentProfile ?? (owner ? owner.profileId ?? DEFAULT_AGENT_ACCOUNT_ID : undefined),
  }
}

export function QueuedEnginePicker({ run }: { run: ApiRun }) {
  const [open, setOpen] = useState(false)
  if (run.status !== 'queued') return null
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>Change agent</Button>
      {open ? <QueuedEngineForm run={run} onSaved={() => setOpen(false)} /> : null}
    </Dialog>
  )
}

function QueuedEngineForm({ run, onSaved }: { run: ApiRun; onSaved: () => void }) {
  const cache = useQueryClient()
  const config = useConfig()
  const providers = useProviderStatus()
  const { accounts, repoAccount } = useAgentAccounts()
  const usable = usableRunners(providers.data)
  // The provider probe describes the discovered login; a named account can still be signed in.
  const runners = RUNNER_ORDER.filter((runner) => usable.includes(runner) || providers.data?.providers.some((row) =>
    row.provider === runner && row.enabled && row.status !== 'not-installed'
    && accounts.some((account) => account.provider === runner && account.id !== DEFAULT_AGENT_ACCOUNT_ID)))
  const currentRunner = run.runner ?? config.data?.defaultRunner ?? 'claude'
  const current = queuedEngineSelection(run, currentRunner)
  const [pickedRunner, setRunner] = useState<Runner | null>(null)
  const [pickedModel, setModel] = useState<string | null>(null)
  const [pickedEffort, setEffort] = useState<string | null>(null)
  const [pickedAccount, setAccount] = useState<string | null>(null)
  const runner = pickedRunner ?? currentRunner
  const switched = runner !== currentRunner
  const locked = config.data?.modelsLocked === true
  const catalog = useRunnerModels(runner)
  const defaults = !locked && !switched ? { [runner]: current.model ?? '' } : config.data?.defaultModels
  const model = resolveModel(locked ? null : pickedModel, runner, defaults, catalog.data)
  const models = modelsForRunner(runner, catalog.data, [pickedModel, defaults?.[runner]])
  const efforts = reasoningEffortsForModel(runner, model, catalog.data)
  const effort = resolveReasoningEffort(pickedEffort ?? (!switched ? current.effort : undefined) ?? null, runner, model, catalog.data)
  const accountDefaults = switched ? repoAccount : { ...repoAccount, [runner]: current.account ?? repoAccount?.[runner] ?? DEFAULT_AGENT_ACCOUNT_ID }
  const changed = switched || pickedModel !== null || pickedEffort !== null || pickedAccount !== null
  const mutation = useMutation({
    mutationFn: () => {
      const input: ChangeRunEngineInput = {
        ...(switched ? { runner } : {}),
        ...(!locked && (switched || pickedModel !== null) ? { model } : {}),
        ...(!locked && pickedEffort !== null && runnerSupportsReasoningEffort(runner) ? { reasoningEffort: effort } : {}),
        ...(pickedAccount !== null ? { agentProfile: pickedAccount } : {}),
      }
      return changeRunEngine(run.id, input)
    },
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: queryKeys.runs.all })
      onSaved()
    },
    onError: () => { void cache.invalidateQueries({ queryKey: queryKeys.runs.all }) },
  })
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Change queued agent</DialogTitle>
        <DialogDescription>The task keeps its work and queue priority. It starts when the selected agent and a task slot are available.</DialogDescription>
      </DialogHeader>
      <div className="flex flex-wrap items-center gap-2">
        <RunnerPill runners={runners} disabled={mutation.isPending} value={runner} accounts={accounts} account={pickedAccount} repoAccount={accountDefaults}
          onPick={(next, account) => {
            setAccount(account)
            if (next !== runner) { setRunner(next); setModel(null); setEffort(null) }
          }} />
        <PickerPill slot="queued-model-pill" ariaLabel="Model" label={models.find((m) => m.id === model)?.label ?? 'auto'} value={model}
          readOnly={locked} disabled={mutation.isPending} disabledHint="Model selection is locked to native coding-agent settings."
          onPick={(next) => { setModel(next); setEffort('') }} options={models.map((m) => ({ value: m.id, label: m.label, desc: m.desc }))}
          status={modelCatalogStatus(runner, catalog.data, catalog.isError)} />
        <ReasoningEffortPill runner={runner} model={model} value={effort} options={efforts} disabled={mutation.isPending} modelsLocked={locked} onPick={setEffort} />
      </div>
      {providers.isError ? <p role="alert">Provider authentication could not be verified. Try again after checking Settings → Agent accounts.</p> : null}
      {providers.isSuccess && !runners.includes(runner) ? <p role="alert">Choose a connected agent.</p> : null}
      {mutation.error ? <p role="alert">{mutation.error.message}</p> : null}
      <DialogFooter>
        <Button variant="outline" onClick={onSaved} disabled={mutation.isPending}>Cancel</Button>
        <Button onClick={() => mutation.mutate()} disabled={!changed || !config.isSuccess || !providers.isSuccess || !runners.includes(runner) || mutation.isPending}>
          {mutation.isPending ? 'Saving…' : 'Save agent'}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
