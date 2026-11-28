import { CheckIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { queryScope } from '@open-mercato/cezar-api-client'
import { cn } from '@/lib/utils'

/**
 * PR-style review aids for the Changes views (#2248): the comparison-base switch and the
 * per-file "Viewed" marks. Everything is local — no gh, no network; the marks live in
 * localStorage, per project + branch + base, and a file's mark resets when its patch changes.
 */

export type BaseKind = 'merge-base' | 'worktree' | 'ref'
export interface ChangesBase {
  kind: BaseKind
  /** The typed ref when `kind` is `ref`. */
  ref: string
}

/** The `?base=` value for a choice, or undefined while a ref is still being typed. A route's own
 *  default is sent as undefined so its response stays byte-identical (`null`: always send). */
export function baseParam(base: ChangesBase, defaultKind: BaseKind | null): string | undefined {
  if (base.kind === 'ref') {
    const ref = base.ref.trim()
    return ref && !ref.startsWith('-') ? ref : undefined
  }
  return base.kind === defaultKind ? undefined : base.kind
}

const LABELS: Record<BaseKind, string> = {
  'merge-base': 'vs base branch',
  worktree: 'Uncommitted only',
  ref: 'vs another ref…',
}

export function ChangesBaseSelect({
  value,
  onChange,
  className,
}: {
  value: ChangesBase
  onChange: (next: ChangesBase) => void
  className?: string
}) {
  return (
    <span data-slot="changes-base" className={cn('flex items-center gap-1.5', className)}>
      <span role="group" aria-label="Compare against" className="flex overflow-hidden rounded-md border border-border">
        {(Object.keys(LABELS) as BaseKind[]).map((kind) => (
          <button
            key={kind}
            type="button"
            data-kind={kind}
            aria-pressed={value.kind === kind}
            onClick={() => onChange({ ...value, kind })}
            className={cn(
              'h-7 px-2 text-xs',
              value.kind === kind ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted',
            )}
          >
            {LABELS[kind]}
          </button>
        ))}
      </span>
      {value.kind === 'ref' ? (
        <input
          aria-label="Base ref"
          placeholder="branch, tag or sha"
          value={value.ref}
          onChange={(event) => onChange({ ...value, ref: event.target.value })}
          className="h-7 w-36 rounded-md border border-border bg-background px-1.5 font-mono text-xs"
        />
      ) : null}
    </span>
  )
}

// ---- Viewed marks -----------------------------------------------------------

const STORAGE_KEY = 'cez:changes-viewed:v1'
/** Scopes kept; the least recently written fall off first. */
const MAX_SCOPES = 60

type Store = Record<string, Record<string, string>>

function readStore(): Store {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as unknown
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Store) : {}
  } catch {
    return {}
  }
}

function writeScope(scope: string, marks: Record<string, string>) {
  try {
    const store = readStore()
    delete store[scope] // re-insert last: object order doubles as recency
    if (Object.keys(marks).length > 0) store[scope] = marks
    const keys = Object.keys(store)
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_SCOPES))) delete store[key]
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch {
    // Private mode / full quota: marks simply do not persist.
  }
}

/** FNV-1a over the patch — a mark is only valid for the patch it was made on. */
export function patchHash(patch: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < patch.length; i++) {
    h ^= patch.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

export interface ViewedState {
  viewed: ReadonlySet<string>
  toggle: (path: string) => void
  count: number
  total: number
}

export function viewedScope(parts: { id: string; branch?: string | null; base: string }): string {
  return [queryScope(), parts.id, parts.branch ?? '', parts.base].join('|')
}

/** Viewed marks for one comparison. A file whose patch changed since it was marked reads as unviewed. */
export function useViewedFiles(scope: string, files: ReadonlyArray<{ path: string; patch: string }>): ViewedState {
  const [marks, setMarks] = useState<Record<string, string>>(() => readStore()[scope] ?? {})
  useEffect(() => setMarks(readStore()[scope] ?? {}), [scope])

  const hashes = useMemo(() => new Map(files.map((f) => [f.path, patchHash(f.patch)])), [files])
  const viewed = useMemo(() => {
    const set = new Set<string>()
    for (const [path, hash] of hashes) if (marks[path] === hash) set.add(path)
    return set
  }, [hashes, marks])

  const toggle = useCallback(
    (path: string) => {
      const hash = hashes.get(path)
      if (hash === undefined) return
      setMarks((current) => {
        const next = { ...current }
        if (next[path] === hash) delete next[path]
        else next[path] = hash
        writeScope(scope, next)
        return next
      })
    },
    [hashes, scope],
  )

  return { viewed, toggle, count: viewed.size, total: files.length }
}

export function ViewedCounter({ state }: { state: ViewedState }) {
  if (state.total === 0) return null
  return (
    <span data-slot="viewed-counter" className="flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
      <CheckIcon aria-hidden="true" className="size-3" />
      {state.count} / {state.total} viewed
    </span>
  )
}

/** Said whenever the server stopped sending patches — never a silent blank diff. */
export function TruncatedNote({ show }: { show: boolean }) {
  if (!show) return null
  return (
    <p data-slot="truncated-note" role="status" className="border-b px-4 py-2 text-label text-muted-foreground md:px-6">
      This diff is too large to show in full: files near the end are listed with their counts but without a patch.
      Narrow the comparison (another base, or uncommitted only) to read them.
    </p>
  )
}
