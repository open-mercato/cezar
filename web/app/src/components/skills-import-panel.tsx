import { useQueryClient } from '@tanstack/react-query'
import { SparklesIcon, TriangleAlertIcon } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'

import { putUiState } from '@/api/client'
import { queryKeys, useImportableSkills, useUiState } from '@/api/queries'
import type { UiState } from '@/api/types'
import { CenteredState } from '@/components/centered-state'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/toaster'
import { cn } from '@/lib/utils'

const SKILLS_REPO_URL = 'https://github.com/open-mercato/skills'

/** The imported set from ui-state, defensively — a user-editable file, so a non-array degrades
 *  to "nothing imported" rather than crashing the panel (mirrors the server-side `readImportedSkills`). */
function importedNames(uiState: UiState | undefined): string[] {
  const value = uiState?.importedSkills
  return Array.isArray(value) ? value.filter((name): name is string => typeof name === 'string' && !!name) : []
}

/**
 * The "Import skills" panel (replaces the old promo banner, #391 follow-up): the default
 * `open-mercato/skills` catalog is no longer forced on the user — they browse it here and import
 * only the skills they want. Imported names live in `ui-state.json` (`importedSkills`); the gate
 * that decides which team skills reach the catalog is server-side in `discoverSkills`, so this
 * panel only ever writes the selection.
 *
 * Persistence copies the banner-dismiss pattern exactly: optimistic cache write, then `putUiState`,
 * reconcile the cache with the server's merged answer on success, toast + refetch on failure. On
 * every successful change it also invalidates the skills catalog so the add/remove shows up in the
 * list (and the composer picker) without a manual refresh.
 */
export function ImportSkillsPanel() {
  const queryClient = useQueryClient()
  const uiState = useUiState()
  const importable = useImportableSkills()
  const [query, setQuery] = useState('')

  const imported = useMemo(() => new Set(importedNames(uiState.data)), [uiState.data])

  const persist = useCallback(
    (next: string[]) => {
      // Optimistic: reflect the toggle immediately rather than waiting on the round trip.
      queryClient.setQueryData(queryKeys.uiState, { ...uiState.data, importedSkills: next })
      putUiState({ importedSkills: next })
        .then((merged) => {
          queryClient.setQueryData(queryKeys.uiState, merged)
          // The gate lives in discoverSkills — re-read so the catalog (and the composer picker)
          // reflect the newly imported/removed skill without a manual Refresh.
          void queryClient.invalidateQueries({ queryKey: queryKeys.skills })
        })
        .catch((error: unknown) => {
          toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
          // The write failed to persist — re-sync with the server's truth rather than leave the
          // cache claiming a selection that never saved.
          void queryClient.invalidateQueries({ queryKey: queryKeys.uiState })
        })
    },
    [queryClient, uiState.data],
  )

  const toggle = useCallback(
    (name: string) => {
      const next = imported.has(name)
        ? importedNames(uiState.data).filter((entry) => entry !== name)
        : [...importedNames(uiState.data), name]
      persist(next)
    },
    [imported, persist, uiState.data],
  )

  const all = importable.data ?? []
  const allNames = useMemo(() => all.map((skill) => skill.name), [all])
  const allImported = allNames.length > 0 && allNames.every((name) => imported.has(name))

  const importOrRemoveAll = useCallback(() => {
    if (allImported) {
      // Remove only the names this panel offers — never touch an imported name from elsewhere.
      const offered = new Set(allNames)
      persist(importedNames(uiState.data).filter((name) => !offered.has(name)))
    } else {
      // Union so an already-imported skill is preserved and duplicates never accumulate.
      persist([...new Set([...importedNames(uiState.data), ...allNames])])
    }
  }, [allImported, allNames, persist, uiState.data])

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
      <h2 className="text-base font-semibold">Import skills</h2>
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
        — PR creation, code review, CI stabilisation, spec writing and more. Import the ones you
        want; they join your catalog and the composer picker. Nothing is imported until you pick it.
      </p>

      <div className="mt-4 flex items-center gap-2">
        <Input
          data-slot="import-filter"
          placeholder="Filter skills…"
          aria-label="Filter importable skills"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="h-8 text-[13px]"
        />
        <button
          type="button"
          data-slot="import-all"
          disabled={allNames.length === 0 || uiState.isPending}
          onClick={importOrRemoveAll}
          className="h-8 shrink-0 rounded-md border border-border bg-card px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-55"
        >
          {allImported ? 'Remove all' : 'Import all'}
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
            {all.length > 0 ? '(no skills match)' : '(no importable skills — the repo may still be cloning)'}
          </p>
        )}
      </div>
    </div>
  )
}
