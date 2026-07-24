import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2Icon, RefreshCwIcon, SparklesIcon, TriangleAlertIcon } from 'lucide-react'
import { useCallback, useMemo, useRef, useState } from 'react'

import { applySkillsUpdate, checkSkillsUpdate, createRun, putWorkspaceUiState } from '@/api/client'
import { queryKeys, useImportableSkills, useSkillsUpdate, useWorkspaceUiState, workspaceQueryKeys } from '@/api/queries'
import type { SkillsUpdateState, WorkspaceUiState } from '@/api/types'
import { Button } from '@/components/ui/button'
import { CenteredState } from '@/components/centered-state'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/toaster'
import { useNavigate } from '@/lib/project-router'
import { cn } from '@/lib/utils'
import { startedRunPath } from '@/routes/new-task-form'

const SKILLS_REPO_URL = 'https://github.com/open-mercato/skills'

/** The user's EXPLICIT selection, or `undefined` when the key is absent (not curated) — mirrors
 *  the server's tri-state `readImportedSkills`. A non-array (hand-edited file) degrades to
 *  `undefined` (the safe, keep-all reading), and junk entries inside an array are dropped. */
function curatedNames(uiState: WorkspaceUiState | undefined): string[] | undefined {
  const value = uiState?.importedSkills
  if (!Array.isArray(value)) return undefined
  return value.filter((name): name is string => typeof name === 'string' && !!name)
}

/** The skills effectively enabled right now: the curated list if the user has one, otherwise ALL
 *  offered skills — the opt-out default, matching the server (absent `importedSkills` = keep all,
 *  so existing installs are never silently emptied on upgrade). */
function effectiveImported(uiState: WorkspaceUiState | undefined, allNames: readonly string[]): string[] {
  return curatedNames(uiState) ?? [...allNames]
}

/**
 * The "Manage skills" panel (replaces the old promo banner, #391 follow-up): the default
 * `open-mercato/skills` catalog is no longer forced on the user, but it is not taken away either —
 * every skill is enabled by default (opt-out) and the user unchecks the ones they don't want. The
 * selection lives in the GLOBAL `~/.cezar/ui-state.json` (`importedSkills`, via the workspace
 * ui-state) so it follows the person across projects rather than depending on the launch directory;
 * the gate that decides which team skills reach the catalog is server-side in `discoverSkills`, so
 * this panel only writes the selection. The first uncheck expands the "all on" default into an
 * explicit array (curation begins).
 *
 * Persistence copies the banner-dismiss pattern: optimistic cache write, then `putWorkspaceUiState`,
 * reconcile the cache with the server's merged answer on success, toast + refetch on failure. On
 * every successful change it also invalidates the skills catalog so the change shows up in the
 * list (and the composer picker) without a manual refresh.
 *
 * Writes are hardened against the classic lost-update race (two quick toggles, or PUT responses
 * arriving out of order). Each mutation derives its next array from the LATEST cache (not the
 * render-captured snapshot), so a second toggle builds on the first; the PUTs are chained so they
 * reach the server in issue order (no concurrent shallow-merge clobber); and only the newest write
 * may reconcile the cache, so a slow older response can never overwrite a newer selection.
 */
export function ImportSkillsPanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient()
  const uiState = useWorkspaceUiState()
  const importable = useImportableSkills()
  const [query, setQuery] = useState('')
  const update = useSkillsUpdate(projectId, Boolean(projectId))

  const all = importable.data ?? []
  const allNames = useMemo(() => all.map((skill) => skill.name), [all])
  // persist() is a stable callback, but the opt-out default ("all on") must expand into an
  // explicit array on the first curation — so it needs the current offered names via a ref.
  const allNamesRef = useRef<string[]>([])
  allNamesRef.current = allNames

  const imported = useMemo(
    () => new Set(effectiveImported(uiState.data, allNames)),
    [uiState.data, allNames],
  )

  // Serializes the PUTs (each waits for the prior) and marks the newest write, so out-of-order
  // completion can neither reorder the server's writes nor let a stale response win the cache.
  const writeChain = useRef<Promise<unknown>>(Promise.resolve())
  const latestWrite = useRef(0)

  const persist = useCallback(
    (compute: (prev: string[]) => string[]) => {
      const key = workspaceQueryKeys.uiState
      // Read the LATEST cache, not the render-captured snapshot — a second toggle fired before the
      // rerender must build on the first, or the two derive from the same old array and one is lost.
      const current = queryClient.getQueryData<WorkspaceUiState>(key)
      // Base the change on the EFFECTIVE set: before any curation everything is enabled, so the
      // first uncheck must start from "all offered", not from an empty array.
      const next = compute(effectiveImported(current, allNamesRef.current))
      // Optimistic now, so the checkbox flips instantly and the next toggle reads this state.
      queryClient.setQueryData(key, { ...current, importedSkills: next })
      const seq = ++latestWrite.current
      writeChain.current = writeChain.current.then(async () => {
        try {
          const merged = await putWorkspaceUiState({ importedSkills: next })
          // Only the newest write reconciles: an earlier, slower response must not resurrect a
          // selection the user has already moved past.
          if (seq === latestWrite.current) {
            queryClient.setQueryData(key, merged)
            // The gate lives in discoverSkills — re-read so the catalog (and the composer picker)
            // reflect the change without a manual Refresh.
            void queryClient.invalidateQueries({ queryKey: queryKeys.skills })
          }
        } catch (error: unknown) {
          toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
          // The write failed to persist — re-sync with the server's truth rather than leave the
          // cache claiming a selection that never saved.
          if (seq === latestWrite.current) void queryClient.invalidateQueries({ queryKey: key })
        }
      })
    },
    [queryClient],
  )

  const toggle = useCallback(
    (name: string) => {
      persist((prev) => (prev.includes(name) ? prev.filter((entry) => entry !== name) : [...prev, name]))
    },
    [persist],
  )

  const allImported = allNames.length > 0 && allNames.every((name) => imported.has(name))

  const enableOrDisableAll = useCallback(() => {
    if (allImported) {
      // Remove only the names this panel offers — never touch a selection made elsewhere.
      const offered = new Set(allNamesRef.current)
      persist((prev) => prev.filter((name) => !offered.has(name)))
    } else {
      // Union so an already-kept skill is preserved and duplicates never accumulate.
      persist((prev) => [...new Set([...prev, ...allNamesRef.current])])
    }
  }, [allImported, persist])

  if (importable.isError) {
    return (
      <CenteredState
        icon={<TriangleAlertIcon />}
        tone="danger"
        heading="h2"
        title="Could not load importable skills"
        subtitle={importable.error.message}
      />
    )
  }

  const needle = query.trim().toLowerCase()
  const shown = needle
    ? all.filter(
        (skill) =>
          skill.name.toLowerCase().includes(needle) ||
          (skill.description ?? '').toLowerCase().includes(needle),
      )
    : all

  return (
    <div data-slot="skills-import-panel" className="mx-auto w-full max-w-2xl">
      <h2 className="text-base font-semibold">Manage skills</h2>
      <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
        Reusable, technology-agnostic agent skills from{' '}
        <a
          href={SKILLS_REPO_URL}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2 hover:text-foreground"
        >
          open-mercato/skills
        </a>{' '}
        — PR creation, code review, CI stabilisation, spec writing and more. They&apos;re all in your
        catalog and the composer picker by default; uncheck any you don&apos;t want.
      </p>

      <SkillsUpdateCard projectId={projectId} state={update.data} loadError={update.error} />

      <p className="mt-4 text-xs text-soft-foreground">
        These checkboxes choose what cezar shows; updates refresh installed skill files.
      </p>

      <div className="mt-4 flex items-center gap-2">
        <Input
          data-slot="import-filter"
          placeholder="Filter skills…"
          aria-label="Filter skills"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="h-8 text-[13px]"
        />
        <button
          type="button"
          data-slot="import-all"
          disabled={allNames.length === 0 || uiState.isPending}
          onClick={enableOrDisableAll}
          className="h-8 shrink-0 rounded-md border border-border bg-card px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-55"
        >
          {allImported ? 'Remove all' : 'Enable all'}
        </button>
      </div>

      <div data-slot="import-list" className="mt-3 flex flex-col gap-1.5">
        {importable.isPending ? (
          <p className="px-1 py-2 text-[13px] text-soft-foreground">Loading…</p>
        ) : shown.length > 0 ? (
          shown.map((skill) => {
            const checked = imported.has(skill.name)
            return (
              <label
                key={skill.name}
                data-slot="import-row"
                data-skill={skill.name}
                data-imported={checked ? 'true' : undefined}
                className={cn(
                  'flex cursor-pointer items-start gap-2.5 rounded-md border border-border px-2.5 py-2 transition-colors hover:bg-muted',
                  checked && 'bg-muted',
                )}
              >
                <input
                  type="checkbox"
                  data-slot="import-toggle"
                  checked={checked}
                  onChange={() => toggle(skill.name)}
                  className="mt-0.5 size-3.5 shrink-0"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <SparklesIcon aria-hidden="true" className="size-3.5 shrink-0 text-soft-foreground" />
                    <span className="min-w-0 truncate font-mono text-[13px] font-medium text-foreground">
                      {skill.name}
                    </span>
                  </span>
                  {skill.description ? (
                    <span className="mt-0.5 block pl-[22px] text-xs text-soft-foreground">
                      {skill.description}
                    </span>
                  ) : null}
                </span>
              </label>
            )
          })
        ) : (
          <p className="px-1 py-2 text-xs text-soft-foreground">
            {all.length > 0 ? '(no skills match)' : '(no skills available — the repo may still be cloning)'}
          </p>
        )}
      </div>
    </div>
  )
}

function scopeLabel(scope: SkillsUpdateState['scopes'][number]['scope']) {
  return scope === 'project' ? 'Project installation' : 'Global installation'
}

function SkillsUpdateCard({
  projectId,
  state,
  loadError,
}: {
  projectId: string
  state?: SkillsUpdateState
  loadError: Error | null
}) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const latestAction = useRef(0)
  const [showUpgradeNotesPrompt, setShowUpgradeNotesPrompt] = useState(false)
  const startUpgradeNotes = useMutation({
    mutationFn: () =>
      createRun({
        task: 'Apply the upgrade notes after updating the installed Open Mercato skills.',
        steps: [
          {
            id: 'apply-upgrade-notes',
            name: 'Apply upgrade notes',
            skill: 'om-apply-upgrade-notes',
            prompt: '{{task}}',
          },
        ],
      }),
    onSuccess: (created) => {
      setShowUpgradeNotesPrompt(false)
      void navigate(startedRunPath(created))
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  type UpdateRequest =
    | { action: 'check'; seq: number }
    | { action: 'apply'; seq: number; previousUpdatedAt: string | null }
  const accept = (result: SkillsUpdateState, request: UpdateRequest) => {
      // A forced check may finish after an apply. Only the newest user intent owns the cache.
      if (request.seq !== latestAction.current) return
      queryClient.setQueryData(workspaceQueryKeys.skillsUpdate(projectId), result)
      if (request.action === 'apply' && result.updatedAt && result.updatedAt !== request.previousUpdatedAt) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.skills })
        toast(result.status === 'error' ? 'Some skill updates failed.' : 'Open Mercato skills updated.')
        setShowUpgradeNotesPrompt(true)
      }
  }
  const reject = (error: Error, request: UpdateRequest) => {
      if (request.seq === latestAction.current) toast(error.message, { tone: 'danger' })
  }
  const checkMutation = useMutation({
    mutationFn: (request: { action: 'check'; seq: number }) => checkSkillsUpdate(projectId).then((result) => ({ result, request })),
    onSuccess: ({ result, request }) => accept(result, request),
    onError: (error: Error, request) => reject(error, request),
  })
  const applyMutation = useMutation({
    mutationFn: (request: Extract<UpdateRequest, { action: 'apply' }>) =>
      applySkillsUpdate(projectId).then((result) => ({ result, request })),
    onSuccess: ({ result, request }) => accept(result, request),
    onError: (error: Error, request) => reject(error, request),
  })
  const run = (action: 'check' | 'apply') => {
    const seq = ++latestAction.current
    if (action === 'apply') applyMutation.mutate({ action, seq, previousUpdatedAt: state?.updatedAt ?? null })
    else checkMutation.mutate({ action, seq })
  }
  const tracked = state?.scopes.some((scope) => scope.skills.length > 0) ?? false
  const retryable = state?.status === 'error'
  const canApply = tracked && (state?.available || retryable)
  const pending = applyMutation.isPending || state?.status === 'updating'
  const failed = state?.scopes.filter((scope) => scope.status === 'error' || scope.status === 'unavailable') ?? []
  const succeeded = state?.scopes.filter((scope) => scope.updatedAt && !failed.includes(scope)) ?? []

  let message = 'Checking installed Open Mercato skills…'
  if (loadError) message = 'Update status is unavailable right now.'
  else if (state?.status === 'available') message = 'An update is available for your installed Open Mercato skills.'
  else if (state?.status === 'updating') message = 'Updating installed Open Mercato skills…'
  else if (state?.status === 'current') message = 'Installed Open Mercato skills are up to date.'
  else if (state?.status === 'unavailable') message = state.scopes.find((scope) => scope.reason)?.reason ?? 'Automatic updates are unavailable.'
  else if (state?.status === 'error') message = 'The update did not finish for every installation.'

  return (
    <>
      <section data-slot="skills-update-card" aria-live="polite" className="mt-4 rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-foreground">{message}</p>
          {state?.checkedAt ? <p className="mt-1 text-xs text-soft-foreground">Last checked {new Date(state.checkedAt).toLocaleString()}.</p> : null}
          {state?.scopes.some((scope) => scope.skills.length > 0) ? (
            <ul className="mt-1 text-xs text-soft-foreground">
              {state.scopes.filter((scope) => scope.skills.length > 0).map((scope) => <li key={scope.scope}>{scopeLabel(scope.scope)} · {scope.skills.length} tracked</li>)}
            </ul>
          ) : null}
          {failed.length > 0 ? <p className="mt-1 text-xs text-destructive">Failed: {failed.map((scope) => scopeLabel(scope.scope)).join(', ')}{succeeded.length ? `; updated: ${succeeded.map((scope) => scopeLabel(scope.scope)).join(', ')}` : ''}.</p> : null}
        </div>
        {canApply ? (
          <Button data-action="skills-update-apply" size="sm" disabled={pending} onClick={() => run('apply')}>
            <RefreshCwIcon aria-hidden="true" className={cn('size-3.5', pending && 'motion-safe:animate-spin')} />
            {pending ? 'Updating…' : retryable ? 'Retry' : 'Update now'}
          </Button>
        ) : state?.status === 'current' ? (
          <Button data-action="skills-update-check" variant="outline" size="sm" disabled={checkMutation.isPending} onClick={() => run('check')}>Check again</Button>
        ) : state?.status === 'unavailable' || loadError ? (
          <Button data-action="skills-update-check" variant="outline" size="sm" disabled={checkMutation.isPending} onClick={() => run('check')}>Retry check</Button>
        ) : null}
      </div>
      {(state?.status === 'unavailable' || loadError) ? <div className="mt-2 text-xs text-soft-foreground">Manual examples: <code>npx skills update -p</code> · <code>npx skills update -g</code>. These broad commands may update other tracked sources.</div> : null}
      {state?.needsUpgradeNotes ? <div data-slot="skills-upgrade-notes" className="mt-3 flex gap-2 rounded-md border border-primary/30 bg-background p-2.5 text-xs text-foreground"><CheckCircle2Icon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-primary" /><span>Skill files were updated. Run <code>/om-apply-upgrade-notes</code> in each configured repository to apply descriptor migrations while preserving local edits.</span></div> : null}
      </section>
      <Dialog
        open={showUpgradeNotesPrompt}
        onOpenChange={(open) => (startUpgradeNotes.isPending ? undefined : setShowUpgradeNotesPrompt(open))}
      >
        <DialogContent data-slot="skills-upgrade-notes-dialog" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Apply the upgrade notes now?</DialogTitle>
            <DialogDescription>
              The skill files were updated successfully. Start a new session with{' '}
              <code>/om-apply-upgrade-notes</code> to sync repository descriptors while preserving local edits?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={startUpgradeNotes.isPending}
              onClick={() => setShowUpgradeNotesPrompt(false)}
            >
              No
            </Button>
            <Button
              type="button"
              disabled={startUpgradeNotes.isPending}
              onClick={() => startUpgradeNotes.mutate()}
            >
              {startUpgradeNotes.isPending ? 'Starting…' : 'Yes, start session'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
