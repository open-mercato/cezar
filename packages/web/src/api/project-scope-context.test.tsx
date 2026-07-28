import { cleanup, render } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { ProjectScopeProvider, useProjectScope } from './project-scope-context'
import { getApiScope, queryScope, scopeApiPath, setApiScope } from '@open-mercato/cezar-api-client'

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
      {`${projectId ?? '-'}|${apiBase}|${queryScope()}|${scopeApiPath('/api/runs')}`}
    </output>
  )
}

describe('ProjectScopeProvider', () => {
  it('defaults to unscoped outside any provider — the pre-3.2 app, byte-identical', () => {
    const view = render(<Probe />)
    expect(view.getByTestId('probe').textContent).toBe('-|/api|default|/api/runs')
  })

  it('scopes both the context and the module seam before the children render', () => {
    const view = render(
      <ProjectScopeProvider projectId="cezar">
        <Probe />
      </ProjectScopeProvider>,
    )
    // The probe read scopeApiPath/queryScope during ITS render — if the provider had waited
    // for an effect, the first paint would have fetched and cached under the wrong scope.
    expect(view.getByTestId('probe').textContent).toBe('cezar|/api/p/cezar|cezar|/api/p/cezar/runs')
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
    expect(view.getByTestId('probe').textContent).toBe('b|/api/p/b|b|/api/p/b/runs')

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

  it('passes null through as the unscoped boot project', () => {
    const view = render(
      <ProjectScopeProvider projectId={null}>
        <Probe />
      </ProjectScopeProvider>,
    )
    expect(view.getByTestId('probe').textContent).toBe('-|/api|default|/api/runs')
  })
})
