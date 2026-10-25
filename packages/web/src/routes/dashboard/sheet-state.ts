import { useCallback, useContext, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { DashboardEntryContext } from './state'

// Browser-history presentation only: bounded, local, and never an authority for policy.
let sequence = 0
export const newSheetSelection = () => ++sequence
const entries = new Map<string, Map<string, unknown>>()
export function useSheetState<T>(name: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const entry = useContext(DashboardEntryContext)
  const read = () => {
    const saved = entry ? entries.get(entry) : undefined
    return saved?.has(name) ? saved.get(name) as T : typeof initial === 'function' ? (initial as () => T)() : initial
  }
  const [value, setValue] = useState<T>(read)
  const key = `${entry}:${name}`
  const [observed, setObserved] = useState(key)
  if (key !== observed) {
    setObserved(key)
    setValue(() => read())
  }
  const saved = useMemo(() => ({ value }), [entry, name])
  saved.value = value
  useEffect(() => () => {
    if (!entry) return
    const fields = entries.get(entry) ?? new Map<string, unknown>()
    fields.set(name, saved.value)
    if (fields.size > 80) fields.delete(fields.keys().next().value!)
    entries.delete(entry)
    entries.set(entry, fields)
    if (entries.size > 20) entries.delete(entries.keys().next().value!)
  }, [entry, name, saved])
  return [value, setValue]
}

type Position = { scroll: number; href?: string; index?: number }
const controls = 'a[href], button, select, input, [tabindex]'
export function useSheetPosition(name: string) {
  const [position] = useSheetState<Position>(`${name}:position`, () => ({ scroll: 0 }))
  const restore = useCallback((node: HTMLElement) => {
    const targets = [...node.querySelectorAll<HTMLElement>(controls)]
    const target = position.href
      ? targets.find((el) => el.getAttribute('href') === position.href)
      : position.index === undefined ? undefined : targets[position.index]
    if (target && target.getAttribute('aria-disabled') !== 'true') target.focus({ preventScroll: true })
    node.scrollTop = position.scroll
    return !!target && target.getAttribute('aria-disabled') !== 'true'
  }, [position])
  const controller = useMemo<{ restore: () => boolean }>(() => ({ restore: () => false }), [position])
  const ref = useCallback((node: HTMLDivElement | null) => {
    if (!node) return
    let pending = position.href !== undefined || position.index !== undefined
    const retry = () => {
      if (!pending) return false
      const restored = restore(node)
      if (restored) {
        pending = false
        observer.disconnect()
      } else if (node.querySelector('[data-sheet-loading="false"]')) {
        // A settled page that no longer contains the target must leave focus in
        // the dialog. Slow pending requests keep their saved target until settled.
        pending = false
        observer.disconnect()
        node.querySelector<HTMLElement>('button:not([disabled]), select, [tabindex="0"]')?.focus({ preventScroll: true })
        node.scrollTop = position.scroll
      }
      return restored
    }
    controller.restore = retry
    const observer = new MutationObserver(retry)
    if (pending) observer.observe(node, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-sheet-loading'] })
    const interact = () => { pending = false; observer.disconnect() }
    const scroll = () => { if (!pending) position.scroll = node.scrollTop }
    const focus = (event: FocusEvent) => {
      if (pending || !(event.target instanceof HTMLElement)) return
      position.href = event.target.getAttribute('href') ?? undefined
      position.index = [...node.querySelectorAll(controls)].indexOf(event.target)
    }
    node.addEventListener('pointerdown', interact)
    node.addEventListener('keydown', interact)
    node.addEventListener('wheel', interact, { passive: true })
    node.addEventListener('scroll', scroll)
    node.addEventListener('focusin', focus)
    return () => {
      observer.disconnect()
      node.removeEventListener('pointerdown', interact)
      node.removeEventListener('keydown', interact)
      node.removeEventListener('wheel', interact)
      node.removeEventListener('scroll', scroll)
      node.removeEventListener('focusin', focus)
    }
  }, [position, restore, controller])
  return {
    ref,
    onOpenAutoFocus: (event: Event) => {
      if (position.href !== undefined || position.index !== undefined) {
        event.preventDefault()
        controller.restore()
      }
    },
  }
}


/** Resolve the original opener after route unmounts discarded its DOM node. */
export function useSheetTrigger(name: string, fallback: string) {
  const current = useRef<HTMLElement | null>(null)
  const [saved, setSaved] = useSheetState<{ label: string | null; text: string | null } | null>(`${name}:trigger`, null)
  return {
    capture: () => {
      const node = document.activeElement
      current.current = node instanceof HTMLElement && node !== document.body ? node : null
      setSaved(current.current ? { label: current.current.getAttribute('aria-label'), text: current.current.textContent } : null)
    },
    restore: () => {
      const candidate = current.current?.isConnected ? current.current : saved
        ? [...document.querySelectorAll<HTMLElement>('button')].find(node =>
          !node.closest('[role="dialog"]') && !node.hasAttribute('disabled') &&
          (saved.label ? node.getAttribute('aria-label') === saved.label : node.textContent === saved.text))
        : undefined
      ;(candidate ?? document.querySelector<HTMLElement>(fallback))?.focus({ preventScroll: true })
    },
  }
}
