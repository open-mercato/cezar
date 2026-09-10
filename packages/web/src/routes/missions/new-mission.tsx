import { XIcon } from 'lucide-react'
import { useState, type FormEvent, type KeyboardEvent } from 'react'

import { useHealth, useStartMission } from '@/api/queries'
import { EnginePills, engineBody, useResolvedEngine, type EnginePick } from '@/components/engine-pills'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { UnitRoleChip } from '@/components/unit-role-chip'
import { useNavigate } from '@/lib/project-router'
import { cn } from '@/lib/utils'
import type { UnitLadder, UnitRole } from '@open-mercato/cezar-api-client'

import { MissionsFrame, UnitsOffState } from './missions'

/**
 * `/p/:projectId/missions/new` — the mission composer (spec
 * `.ai/specs/2026-09-08-units-hierarchy.md` §Cockpit).
 *
 * Three decisions, in the order they matter: WHAT (the objective and the standing rules), HOW BIG
 * (a mission is always the hierarchy — the commander picks its own depth), and ON WHAT (the
 * escalation ladder — which backend and model each rank runs on).
 *
 * There is no order-of-battle preview by design (spec Q5): the commander's first turn plans and
 * spawns, and a preview it is free to ignore would cost tokens before the user has committed.
 */

/** The ranks a mission places, and therefore the ladder rows worth showing. A mission is always
 *  the hierarchy: the commander decides at runtime whether it needs managers or spawns workers
 *  directly, so there is no size to choose here — a plain task has its own composer at `/new`. */
export const MISSION_ROLES: UnitRole[] = ['caesar', 'legate', 'centurion']

const EMPTY_PICK: EnginePick = { runner: null, model: null, account: null }

export function NewMissionRoute() {
  const health = useHealth()
  const navigate = useNavigate()
  const start = useStartMission()

  const [objective, setObjective] = useState('')
  const [constraints, setConstraints] = useState<string[]>([])
  const [constraintDraft, setConstraintDraft] = useState('')
  const [budget, setBudget] = useState('')
  const [parallel, setParallel] = useState('')
  const [maxChildren, setMaxChildren] = useState('')
  const [error, setError] = useState('')

  // One pick per rank, and all three resolved unconditionally: the ROWS are conditional, the
  // hooks cannot be. A rank the current size does not place keeps its pick, so flipping Squad →
  // Army → Squad does not lose what the user chose for Caesar on the way through.
  const [caesarPick, setCaesarPick] = useState<EnginePick>(EMPTY_PICK)
  const [legatePick, setLegatePick] = useState<EnginePick>(EMPTY_PICK)
  const [centurionPick, setCenturionPick] = useState<EnginePick>(EMPTY_PICK)
  const picks: Record<UnitRole, EnginePick> = {
    caesar: caesarPick,
    legate: legatePick,
    centurion: centurionPick,
  }
  const setPick: Record<UnitRole, (pick: EnginePick) => void> = {
    caesar: setCaesarPick,
    legate: setLegatePick,
    centurion: setCenturionPick,
  }
  const resolved: Record<UnitRole, ReturnType<typeof useResolvedEngine>> = {
    caesar: useResolvedEngine(caesarPick),
    legate: useResolvedEngine(legatePick),
    centurion: useResolvedEngine(centurionPick),
  }

  if (health.data === undefined) return <MissionsFrame title="New mission"><p className="text-sm text-muted-foreground">Loading…</p></MissionsFrame>
  if (health.data.capabilities?.units !== true) return <UnitsOffState />

  const roles = MISSION_ROLES

  const addConstraint = () => {
    const rule = constraintDraft.trim()
    if (rule === '' || constraints.includes(rule)) {
      setConstraintDraft('')
      return
    }
    setConstraints((current) => [...current, rule])
    setConstraintDraft('')
  }

  /**
   * The mission body.
   *
   * `engineBody` rather than `engineRunBody`: a ladder rung is exactly `{runner?, model?}` and has
   * no `agentProfile` field, so the account-carrying sibling would put a key on the wire the
   * schema does not have. Empty rungs are dropped and an entirely empty ladder is omitted —
   * conditional spread per the HTTP-API rule, because `ladder: undefined` types a key as
   * always-present that `JSON.stringify` then drops, which the parity guards read as drift.
   */
  const ladder = (): UnitLadder | undefined => {
    const entries = roles.flatMap((role) => {
      const { runner, model } = engineBody(resolved[role])
      const rung = { ...(runner ? { runner } : {}), ...(model ? { model } : {}) }
      return Object.keys(rung).length > 0 ? [[role, rung] as const] : []
    })
    return entries.length > 0 ? (Object.fromEntries(entries) as UnitLadder) : undefined
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const text = objective.trim()
    if (text === '') return
    setError('')
    // An empty field is "no ceiling", not zero. Anything unparseable is refused here rather than
    // sent — the server would 400 on it, and the message it would answer with is about a body the
    // user never saw.
    const trimmedBudget = budget.trim()
    const budgetUsd = trimmedBudget === '' ? undefined : Number(trimmedBudget)
    if (budgetUsd !== undefined && (!Number.isFinite(budgetUsd) || budgetUsd < 0)) {
      setError('The budget must be a number of dollars, or empty for no ceiling.')
      return
    }
    // The mission's own concurrency and fan-out: empty means today's limits. A whole number of
    // at least one, or refused here for the same reason the budget is.
    const positiveInt = (raw: string, label: string): number | undefined | null => {
      const trimmed = raw.trim()
      if (trimmed === '') return undefined
      const value = Number(trimmed)
      if (!Number.isInteger(value) || value < 1) {
        setError(`${label} must be a whole number of at least 1, or empty for the default.`)
        return null
      }
      return value
    }
    const parallelRuns = positiveInt(parallel, 'Parallel runs')
    if (parallelRuns === null) return
    const childrenCap = positiveInt(maxChildren, 'Children per commander')
    if (childrenCap === null) return
    const rungs = ladder()
    try {
      const { id } = await start.mutateAsync({
        objective: text,
        unit: 'army',
        ...(budgetUsd === undefined ? {} : { budgetUsd }),
        ...(parallelRuns === undefined ? {} : { parallel: parallelRuns }),
        ...(childrenCap === undefined ? {} : { maxChildren: childrenCap }),
        ...(constraints.length > 0 ? { constraints } : {}),
        ...(rungs ? { ladder: rungs } : {}),
      })
      // The tree is where the mission's children will appear.
      navigate('/missions')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <MissionsFrame
      title="New mission"
      subtitle="Give one objective to a commander. It plans the work, splits it across agents of its own, and reports back once."
    >
      <form data-slot="new-mission" onSubmit={submit} className="flex flex-col gap-6">
        <section className="flex flex-col gap-2">
          <Label htmlFor="mission-objective">Objective</Label>
          <Textarea
            id="mission-objective"
            data-slot="mission-objective"
            value={objective}
            onChange={(event) => setObjective(event.target.value)}
            placeholder="What should this mission achieve? Name the outcome, not the steps — the commander plans those."
            maxLength={100_000}
            className="min-h-32"
          />
        </section>

        <section className="flex flex-col gap-2">
          <Label htmlFor="mission-constraint">Constraints</Label>
          <p className="text-[12.5px] text-muted-foreground">
            Standing rules for every agent on this mission — “never force-push”, “tests must pass
            before you report”. Press Enter to add one.
          </p>
          <div className="flex gap-2">
            <Input
              id="mission-constraint"
              data-slot="mission-constraint-input"
              value={constraintDraft}
              maxLength={400}
              onChange={(event) => setConstraintDraft(event.target.value)}
              onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                if (event.key !== 'Enter') return
                // The composer's own submit is a click on Start; Enter here adds a chip and must
                // not post a half-filled mission on the way.
                event.preventDefault()
                addConstraint()
              }}
              placeholder="Add a rule…"
            />
            <Button type="button" variant="outline" onClick={addConstraint} disabled={constraintDraft.trim() === ''}>
              Add
            </Button>
          </div>
          {constraints.length > 0 ? (
            <div data-slot="mission-constraints" className="flex flex-wrap gap-1.5">
              {constraints.map((rule) => (
                <button
                  key={rule}
                  type="button"
                  data-slot="mission-constraint"
                  onClick={() => setConstraints((current) => current.filter((entry) => entry !== rule))}
                  title={`Remove “${rule}”`}
                  className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2.5 py-px text-[12px] font-medium text-foreground transition-colors hover:bg-danger/10 hover:text-danger"
                >
                  {rule}
                  <XIcon aria-hidden="true" className="size-3" />
                </button>
              ))}
            </div>
          ) : null}
        </section>

        <section className="flex flex-col gap-2">
          <Label htmlFor="mission-budget">Budget</Label>
          <p className="text-[12.5px] text-muted-foreground">
            The whole mission’s ceiling in USD, carved up as it delegates. Leave empty for no
            ceiling — the behaviour every cezar task has today.
          </p>
          <Input
            id="mission-budget"
            data-slot="mission-budget"
            type="number"
            min={0}
            step="0.5"
            inputMode="decimal"
            value={budget}
            onChange={(event) => setBudget(event.target.value)}
            placeholder="e.g. 20"
            className="max-w-40"
          />
        </section>

        {(
          <section className="flex flex-col gap-2">
            <Label htmlFor="mission-parallel">Resources</Label>
            <p className="text-[12.5px] text-muted-foreground">
              How many of this mission’s runs may execute at once, and how many children one
              commander may have in flight. Empty keeps the workspace’s limits; a mission with its
              own parallel limit runs under it instead of the global cap.
            </p>
            <div className="flex flex-wrap gap-3">
              <Input
                id="mission-parallel"
                data-slot="mission-parallel"
                type="number"
                min={1}
                step="1"
                inputMode="numeric"
                value={parallel}
                onChange={(event) => setParallel(event.target.value)}
                placeholder="parallel runs"
                className="max-w-40"
              />
              <Input
                id="mission-max-children"
                data-slot="mission-max-children"
                type="number"
                min={1}
                step="1"
                inputMode="numeric"
                value={maxChildren}
                onChange={(event) => setMaxChildren(event.target.value)}
                placeholder="children per commander (4)"
                className="max-w-56"
              />
            </div>
          </section>
        )}

        <section className="flex flex-col gap-2">
          <Label>Escalation ladder</Label>
          <p className="text-[12.5px] text-muted-foreground">
            Which backend and model each rank runs on. Untouched, a rank uses this project’s
            defaults — the same fallback a plain task takes.
          </p>
          {roles.length === 0 ? (
            <p data-slot="mission-ladder-empty" className="text-[12.5px] text-soft-foreground">
              A plain task uses the composer defaults.
            </p>
          ) : (
            <div data-slot="mission-ladder" className="flex flex-col gap-2">
              {roles.map((role) => (
                <div
                  key={role}
                  data-slot="mission-ladder-row"
                  data-role={role}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2"
                >
                  <UnitRoleChip role={role} />
                  <div className="flex flex-wrap items-center gap-1.5">
                    <EnginePills pick={picks[role]} onChange={setPick[role]} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {error ? (
          <p data-slot="mission-error" role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        ) : null}

        <div className="flex items-center gap-2">
          <Button type="submit" disabled={objective.trim() === '' || start.isPending}>
            {start.isPending ? 'Starting…' : 'Start mission'}
          </Button>
          <Button type="button" variant="ghost" onClick={() => navigate(-1)}>
            Cancel
          </Button>
        </div>
      </form>
    </MissionsFrame>
  )
}
