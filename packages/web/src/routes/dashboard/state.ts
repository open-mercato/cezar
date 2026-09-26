import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
export function affectedKeys<T>(old: T[], current: T[], key: (row: T) => string) {
  const result = new Set<string>()
  const previous = new Map(old.map((r, i) => [key(r), { r, i }]))
  current.forEach((r, i) => {
    const before = previous.get(key(r))
    if (!before || before.i !== i || JSON.stringify(before.r) !== JSON.stringify(r))
      result.add(key(r))
    previous.delete(key(r))
  })
  previous.forEach((_, id) => result.add(id))
  return result
}
export function reconcileRows<T>(old: T[], current: T[], key: (row: T) => string) {
  const truth = new Map(current.map((r) => [key(r), r]))
  return old.map((row) => ({ row: truth.get(key(row)) ?? row, removed: !truth.has(key(row)) }))
}
export const DashboardEntryContext = createContext('')
export const DashboardReconciledContext = createContext(true)
const stagedEntries = new Map<string, unknown[]>()
export function useStagedRows<T>(
  current: T[] | undefined,
  key: (row: T) => string,
  identity = '',
  pageCount = 0,
  retainRemoved?: (row: T) => boolean,
) {
  const entry = useContext(DashboardEntryContext)
  const storageKey = `${entry}:${identity}`
  const [shown, setShown] = useState<T[] | undefined>(
    () => stagedEntries.get(storageKey) as T[] | undefined,
  )
  const [observedKey, setObservedKey] = useState(storageKey)
  const previousCount = useRef(pageCount)
  const acceptPage = useRef(false)
  if (observedKey !== storageKey) {
    setObservedKey(storageKey)
    setShown(stagedEntries.get(storageKey) as T[] | undefined)
    previousCount.current = pageCount
    acceptPage.current = false
  }
  if (previousCount.current !== pageCount) {
    previousCount.current = pageCount
    acceptPage.current = true
  }
  useEffect(() => {
    if (current && (!shown || acceptPage.current)) {
      setShown(current)
      acceptPage.current = false
    }
  }, [shown, current])
  // Each identity owns its cleanup snapshot, even when the control stays mounted.
  const saved = useMemo(() => ({ current: shown }), [storageKey])
  saved.current = shown
  useEffect(
    () => () => {
      if (!entry || !saved.current) return
      stagedEntries.delete(storageKey)
      stagedEntries.set(storageKey, saved.current)
      if (stagedEntries.size > 60) stagedEntries.delete(stagedEntries.keys().next().value!)
    },
    [entry, storageKey, saved],
  )
  const previous = shown ?? current ?? []
  const present = new Set((current ?? previous).map(key))
  // Rows removed immediately cannot shift surviving indices in the staged comparison.
  const comparable = retainRemoved
    ? previous.filter((row) => present.has(key(row)) || retainRemoved(row))
    : previous
  return {
    rows: reconcileRows(comparable, current ?? previous, key),
    updates: current ? affectedKeys(comparable, current, key).size : 0,
    show: () => setShown(current),
  }
}
export type EntryState = {
  questions: number
  reviews: number
  feed: number
  scroll: number
  focus?: string
}
const entries = new Map<string, EntryState>()
export function readEntry(key: string) {
  return entries.get(key)
}
export function saveEntry(key: string, state: EntryState) {
  entries.delete(key)
  entries.set(key, state)
  if (entries.size > 20) entries.delete(entries.keys().next().value!)
}

type PanelState = { count: number; scroll: number }
const panels = new Map<string, Record<string, PanelState>>()
export function readPanel(entry: string, group: string) {
  return panels.get(entry)?.[group]
}
export function savePanel(entry: string, group: string, state: PanelState) {
  const saved = panels.get(entry) ?? {}
  saved[group] = state
  panels.delete(entry)
  panels.set(entry, saved)
  if (panels.size > 20) panels.delete(panels.keys().next().value!)
}
