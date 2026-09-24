import { cleanup, render } from '@testing-library/react'
import { StrictMode, useEffect } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { ProjectScopeProvider, useProjectScope } from './project-scope-context'
import { getApiScope, queryScope, apiPath, setApiScope } from '@open-mercato/cezar-api-client'

afterEach(() => {
  cleanup()
  setApiScope(null)
})

/** Reads everything a scoped child would: the context AND the module seam, during render —
 *  exactly when queries.ts computes keys and client calls fire from event handlers. */
function Probe() {
  const { projectId, apiBase } = useProjectScope()
  return (
    <output data-testid="probe">
      {`${projectId ?? '-'}|${apiBase}|${queryScope()}|${apiPath('/runs')}`}
    </output>
  )
}

describe('ProjectScopeProvider', () => {
  it('defaults to unscoped outside any provider — no project prefix, just the version', () => {
    const view = render(<Probe />)
    expect(view.getByTestId('probe').textContent).toBe('-|/api/v1|default|/api/v1/runs')
  })

  it('scopes both the context and the module seam before the children render', () => {
    const view = render(
      <ProjectScopeProvider projectId="cezar">
        <Probe />
      </ProjectScopeProvider>,
    )
    // The probe read apiPath/queryScope during ITS render — if the provider had waited
    // for an effect, the first paint would have fetched and cached under the wrong scope.
    expect(view.getByTestId('probe').textContent).toBe('cezar|/api/v1/p/cezar|cezar|/api/v1/p/cezar/runs')
    expect(getApiScope()).toBe('cezar')
  })

  it('follows a projectId change and resets to unscoped on unmount', () => {
    const view = render(
      <ProjectScopeProvider projectId="a">
        <Probe />
      </ProjectScopeProvider>,
    )
    expect(getApiScope()).toBe('a')

    view.rerender(
      <ProjectScopeProvider projectId="b">
        <Probe />
      </ProjectScopeProvider>,
    )
    expect(view.getByTestId('probe').textContent).toBe('b|/api/v1/p/b|b|/api/v1/p/b/runs')

    view.unmount()
    expect(getApiScope()).toBeNull()
  })

  // The composer's project pill (step 3.4) swaps scope by navigating, which remounts the
  // routed subtree under a provider whose projectId changed in the same commit. React runs
  // every destroy before any create, so a reset in the `[projectId]` effect's cleanup would
  // fire between the provider's render and the fresh children's mount effects — and their
  // first requests (the arriving project's skills, workflows, config) would go out unscoped.
  it('never dips back to unscoped while remounting children across a projectId change', () => {
    const seen: (string | null)[] = []
    /** Records the scope its mount effect sees — a child query's fetch timing, exactly. */
    function MountProbe() {
      useEffect(() => {
        seen.push(getApiScope())
      }, [])
      return null
    }

    const view = render(
      <ProjectScopeProvider projectId="a">
        <MountProbe key="a" />
      </ProjectScopeProvider>,
    )
    view.rerender(
      <ProjectScopeProvider projectId="b">
        <MountProbe key="b" />
      </ProjectScopeProvider>,
    )
    expect(seen).toEqual(['a', 'b'])
  })

  // #task-detail-404: the same rule under StrictMode's simulated remount, which is what a soft
  // navigation into another project's task hits in dev — the provider and the (lazily-loaded,
  // by then warm) thread mount in ONE commit, so the double-invoke's destroys include this
  // provider's own reset. A passive reset landed between it and the re-created child effects,
  // and the thread's very first `/runs/:id` went out unprefixed: a 404 the boot project honestly
  // answers, cached under the correctly-scoped key, so only a reload cleared it.
  it('never dips back to unscoped through StrictMode’s remount of a fresh subtree', () => {
    const seen: (string | null)[] = []
    function MountProbe() {
      useEffect(() => {
        seen.push(getApiScope())
      }, [])
      return null
    }

    render(
      <StrictMode>
        <ProjectScopeProvider projectId="a">
          <MountProbe />
        </ProjectScopeProvider>
      </StrictMode>,
    )
    expect(seen).toEqual(['a', 'a'])
  })

  // Two provider INSTANCES in one commit — leaving a project area for another (the global Tasks
  // page's rows, the sidebar's cross-project task links). The departing one's cleanup must not
  // land between the arriving one's render and its children's first requests.
  it('never dips back to unscoped when one provider replaces another in a single commit', () => {
    const seen: (string | null)[] = []
    function MountProbe() {
      useEffect(() => {
        seen.push(getApiScope())
      }, [])
      return null
    }

    const view = render(
      <div>
        <ProjectScopeProvider key="a" projectId="a">
          <MountProbe />
        </ProjectScopeProvider>
      </div>,
    )
    view.rerender(
      <div>
        <ProjectScopeProvider key="b" projectId="b">
          <MountProbe />
        </ProjectScopeProvider>
      </div>,
    )
    expect(seen).toEqual(['a', 'b'])
  })

  it('passes null through as the unscoped boot project', () => {
    const view = render(
      <ProjectScopeProvider projectId={null}>
        <Probe />
      </ProjectScopeProvider>,
    )
    expect(view.getByTestId('probe').textContent).toBe('-|/api/v1|default|/api/v1/runs')
  })
})
