import { useQueryClient } from '@tanstack/react-query'
import { SparklesIcon, TriangleAlertIcon } from 'lucide-react'
import { useCallback, useMemo, useRef, useState } from 'react'

import { putWorkspaceUiState } from '@/api/client'
import { queryKeys, useImportableSkills, useWorkspaceUiState, workspaceQueryKeys } from '@/api/queries'
import type { WorkspaceUiState } from '@/api/types'
import { CenteredState } from '@/components/centered-state'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/toaster'
import { cn } from '@/lib/utils'

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
export function ImportSkillsPanel() {
  const queryClient = useQueryClient()
  const uiState = useWorkspaceUiState()
  const importable = useImportableSkills()
  const [query, setQuery] = useState('')

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
