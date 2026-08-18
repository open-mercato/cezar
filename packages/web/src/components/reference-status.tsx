import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

import {
  useReferenceStatuses,
  type ReferenceStatusEntry,
  type ReferenceStatusLookup,
  type ReferenceStatusRequest,
} from '@/api/queries'

/**
 * The one fetcher, mounted once at the app root.
 *
 * Surfaces do not each go and ask. Before this existed they did, and it showed: a six-project
 * sidebar, a task table and an open run header were eight requests on load, several of them about
 * the SAME pull requests — the server's per-number cache absorbed the forge cost, but the round
 * trips were real and the chips lit up in waves as each answered.
 *
 * So a surface REGISTERS what it is painting and the registry unions it. `useReferenceStatuses`
 * still groups by project, so the union comes out as one request per project no matter how many
 * surfaces contributed to it — and a reference two surfaces share is asked about once.
 *
 * A surface with no registry above it (a bare render, a test) keeps fetching for itself, so
 * mounting this is an optimisation and never a requirement.
 */
interface ReferenceStatusRegistryValue {
  publish: (id: string, requests: readonly ReferenceStatusRequest[]) => void
  retract: (id: string) => void
  lookup: ReferenceStatusLookup
}

const ReferenceStatusRegistryContext = createContext<ReferenceStatusRegistryValue | null>(null)

export function ReferenceStatusRegistry({ children }: { children: ReactNode }) {
  const [surfaces, setSurfaces] = useState<ReadonlyMap<string, readonly ReferenceStatusRequest[]>>(
    () => new Map(),
  )

  const publish = useCallback((id: string, requests: readonly ReferenceStatusRequest[]) => {
    setSurfaces((current) => {
      const next = new Map(current)
      next.set(id, requests)
      return next
    })
  }, [])

  const retract = useCallback((id: string) => {
    setSurfaces((current) => {
      if (!current.has(id)) return current
      const next = new Map(current)
      next.delete(id)
      return next
    })
  }, [])

  const union = useMemo(() => [...surfaces.values()].flat(), [surfaces])
  const lookup = useReferenceStatuses(union)
  const value = useMemo(() => ({ publish, retract, lookup }), [publish, retract, lookup])
  return (
    <ReferenceStatusRegistryContext.Provider value={value}>
      {children}
    </ReferenceStatusRegistryContext.Provider>
  )
}

/**
 * Batched PR/issue status, mounted once per surface and read by the chips inside it.
 *
 * A context rather than a prop, and the reason is where the two halves of this feature live. The
 * REQUEST list is known at the top of a surface (it holds the rows, and it alone can see that
 * forty of them belong to six different projects, which is what makes one request per project
 * possible). The CONSUMER is a chip four components down, inside cells and popovers that have no
 * business relaying a value they never read. Threading it as a prop meant touching every one of
 * those intermediate components on every surface — for a value that is, by design, optional
 * everywhere.
 *
 * Mounting is also what makes it opt-in. A surface that does not mount the provider — a test
 * rendering a table with no query client, a preview, an embedded row — gets `undefined` for
 * every chip, which is exactly the neutral chip the cockpit painted before statuses existed.
 */
interface ReferenceStatusContextValue {
  lookup: ReferenceStatusLookup
  /** The project a chip belongs to when it does not name one. Absent on the global Tasks page
   *  alone, which spans the whole registry and whose chips each name their own; every other
   *  surface stands in exactly one project, where repeating it per chip would be noise. */
  projectId?: string
}

const ReferenceStatusContext = createContext<ReferenceStatusContextValue | null>(null)

export function ReferenceStatusProvider({
  projectId,
  requests,
  children,
}: {
  projectId?: string
  /** Every reference on this surface. Stable content matters, not identity — the hook keys off
   *  what is IN the list, so rebuilding it each render is free. */
  requests: readonly ReferenceStatusRequest[]
  children: ReactNode
}) {
  const registry = useContext(ReferenceStatusRegistryContext)
  const id = useId()
  // The CONTENT is what the registry needs, and it is rebuilt every render — so the effect keys
  // off a signature rather than the array, or it would republish (and re-render the whole app)
  // on every repaint of every surface.
  const signature = requests
    .map((ref) => `${ref.projectId} ${ref.kind}#${ref.number}`)
    .sort()
    .join('|')
  useEffect(() => {
    if (!registry) return
    registry.publish(id, requests)
    return () => registry.retract(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `signature` IS the content of `requests`
  }, [registry, id, signature])

  // Only when there is no registry above us. Called unconditionally with an empty list otherwise:
  // hooks cannot be skipped, and an empty list fetches nothing.
  const own = useReferenceStatuses(registry ? EMPTY_REQUESTS : requests)
  const lookup = registry?.lookup ?? own
  const value = useMemo(() => ({ lookup, projectId }), [lookup, projectId])
  return <ReferenceStatusContext.Provider value={value}>{children}</ReferenceStatusContext.Provider>
}

/** Stable identity, so the fallback hook's signature does not churn. */
const EMPTY_REQUESTS: readonly ReferenceStatusRequest[] = []

/**
 * What is known about one chip: the last status learned for it, and what the request covering it
 * is doing. Both matter to the chip — the status decides its colour, the state decides what its
 * tooltip can honestly say when there is no colour to show.
 *
 * A chip with no status still renders the neutral chip it always did. "We could not ask" must
 * never be painted as "nothing is wrong" — but it can, and now does, SAY so on hover.
 */
export function useReferenceStatus(
  kind: 'PR' | 'Issue',
  number: number | undefined,
  projectId?: string,
): ReferenceStatusEntry {
  const context = useContext(ReferenceStatusContext)
  const owner = projectId ?? context?.projectId
  if (!context || !owner || number === undefined) return IDLE
  return context.lookup({ projectId: owner, kind, number })
}

/** Outside a provider (a bare render, a test, a surface that never mounted one) nothing has been
 *  asked and nothing is claimed — the pre-status chip, exactly. Frozen and shared so it is a
 *  stable identity rather than a new object per render. */
const IDLE: ReferenceStatusEntry = Object.freeze({ state: 'idle' })
