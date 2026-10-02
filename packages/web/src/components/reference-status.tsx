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

import type { ForgeKind } from '@open-mercato/cezar-api-client'

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
  /** That project's forge, for the chips' tooltip copy (Step 5.10) — it travels with the
   *  project id and for the same reason: the surface knows it, the chip four components down
   *  reads it, and nothing in between should have to relay it. Absent on the global Tasks page,
   *  whose chips name their own, and outside a provider — both read as GitHub (`forgeLabel`). */
  forge?: ForgeKind | null
}

const ReferenceStatusContext = createContext<ReferenceStatusContextValue | null>(null)

/**
 * The forge the SCOPED project lives on, for every chip under the app shell (Step 5.10).
 *
 * Mounted once, by `AppShellContainer`, which already reads `useForgeKind()` for the document
 * title — so the chips' copy costs no second registry subscriber. That mattered: subscribing to
 * the registry from inside a routed view destabilizes the scope resolution the router does above
 * it (`routes.tsx` `ProjectScopeRoute`, whose registry-and-health-both-failed path is asserted in
 * `routes.test.tsx`), which is exactly the wrong place to pay for a tooltip's wording.
 *
 * A surface that spans several projects overrides it per provider (the sidebar's project groups)
 * or per chip (the global Tasks page); outside the shell there is no scope and `forgeLabel` reads
 * the absence as GitHub — the copy this cockpit always had.
 */
const ForgeScopeContext = createContext<ForgeKind | null | undefined>(undefined)

export function ReferenceForgeScope({
  forge,
  children,
}: {
  forge: ForgeKind | null | undefined
  children: ReactNode
}) {
  return <ForgeScopeContext.Provider value={forge}>{children}</ForgeScopeContext.Provider>
}

export function ReferenceStatusProvider({
  projectId,
  forge,
  requests,
  children,
}: {
  projectId?: string
  /** The forge this surface's project lives on (`useForgeKind()`, or a per-project `forge` where
   *  the surface paints several projects one provider each). Absent reads as GitHub. */
  forge?: ForgeKind | null
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
  const publish = registry?.publish
  const retract = registry?.retract
  useEffect(() => {
    if (!publish || !retract) return
    publish(id, requests)
    return () => retract(id)
    // `signature` is the content of `requests`; `publish`/`retract` are stable callbacks. The
    // registry object also carries `lookup`, which changes when a status query answers and must
    // not make every surface unregister/register just to keep its same request set alive.
  }, [publish, retract, id, signature])

  // Only when there is no registry above us. Called unconditionally with an empty list otherwise:
  // hooks cannot be skipped, and an empty list fetches nothing.
  const own = useReferenceStatuses(registry ? EMPTY_REQUESTS : requests)
  const lookup = registry?.lookup ?? own
  const value = useMemo(() => ({ lookup, projectId, forge }), [lookup, projectId, forge])
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

/** The forge a chip that is not told its own should name (Step 5.10): its surface's, if that
 *  surface named one, and otherwise the scoped project's. `undefined` means "not specified" at
 *  both levels, so a surface can only be overridden BY naming a forge — including `null`, which
 *  is a positive "this row's project has none" and reads as GitHub, exactly as no scope does. */
export function useReferenceForge(): ForgeKind | null | undefined {
  const surface = useContext(ReferenceStatusContext)?.forge
  const scope = useContext(ForgeScopeContext)
  return surface === undefined ? scope : surface
}

/** Read the shared status cache without starting another request. Consumers that paint more
 * than one reference can use this to make a display decision from the same answer as each chip. */
export function useReferenceStatusLookup(): {
  lookup: ReferenceStatusLookup
  projectId?: string
} {
  const context = useContext(ReferenceStatusContext)
  return { lookup: context?.lookup ?? (() => IDLE), projectId: context?.projectId }
}

/** Outside a provider (a bare render, a test, a surface that never mounted one) nothing has been
 *  asked and nothing is claimed — the pre-status chip, exactly. Frozen and shared so it is a
 *  stable identity rather than a new object per render. */
const IDLE: ReferenceStatusEntry = Object.freeze({ state: 'idle' })
