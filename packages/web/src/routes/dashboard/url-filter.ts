import { useLocation, useSearchParams } from 'react-router'

/** Independent report scopes share the URL without overwriting one another. */
export function useDashboardFilter<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): [T, (value: T) => void] {
  const location = useLocation()
  const entryKey = location.state?.dashboardEntry ?? location.key
  const [search, setSearch] = useSearchParams()
  const candidate = search.get(key) as T | null
  const value = candidate !== null && allowed.includes(candidate) ? candidate : fallback
  return [
    value,
    (nextValue) =>
      setSearch(
        (previous) => {
          const next = new URLSearchParams(previous)
          next.set(key, nextValue)
          return next
        },
        { replace: true, state: { ...location.state, dashboardEntry: entryKey } },
      ),
  ]
}
