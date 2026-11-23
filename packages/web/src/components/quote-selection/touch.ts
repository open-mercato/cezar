import { useSyncExternalStore } from 'react'

const COARSE = '(pointer: coarse)'

function query(): MediaQueryList | undefined {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(COARSE) : undefined
}

/** True on a touch-first device. False under SSR and in jsdom, which has no `matchMedia`. */
export function isCoarsePointer(): boolean {
  return query()?.matches ?? false
}

function subscribe(onChange: () => void): () => void {
  const list = query()
  if (!list || typeof list.addEventListener !== 'function') return () => {}
  list.addEventListener('change', onChange)
  return () => list.removeEventListener('change', onChange)
}

/** Touch hosts place the toolbar below the selection and add the composer chip (spec 2026-11-20, § 1). */
export function useCoarsePointer(): boolean {
  return useSyncExternalStore(subscribe, isCoarsePointer, () => false)
}
