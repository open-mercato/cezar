import { cleanup, render, screen } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it } from 'vitest'

import type { CezarClient, CezarProjectClient } from '@open-mercato/cezar-api-client'
import {
  createCezarQueryClient,
  useCezarNavigation,
  useCezarRuntime,
} from '@open-mercato/cezar-react'
import { ThemeProvider } from './theme-provider'
import { AppearanceProvider } from './appearance-provider'

import { ReferenceCezarProvider } from './reference-cezar-provider'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

function fakeCezarClient(identity: string): CezarClient {
  const project = (projectId: string | null): CezarProjectClient => ({
    projectId,
    runs: {} as CezarProjectClient['runs'],
    events: {} as CezarProjectClient['events'],
    resolveUrl: (url) => url,
  })
  return {
    identity,
    baseUrl: '',
    rpc: {} as CezarClient['rpc'],
    events: { forProject: (projectId = null) => project(projectId).events },
    forProject: (projectId = null) => project(projectId),
  } as CezarClient
}

function Probe({ expectedQueryClient }: { expectedQueryClient: ReturnType<typeof createCezarQueryClient> }) {
  const runtime = useCezarRuntime()
  const navigation = useCezarNavigation()
  return (
    <output
      data-testid="reference-runtime"
      data-project={runtime.projectId ?? 'boot'}
      data-api-project={runtime.projectClient.projectId ?? 'boot'}
      data-task-href={navigation.href({ area: 'task', runId: 'run-a' })}
      data-tasks-href={navigation.href({ area: 'tasks' })}
      data-same-query-client={String(runtime.queryClient === expectedQueryClient)}
    />
  )
}

function renderReference(
  rootElement: HTMLElement,
  queryClient: ReturnType<typeof createCezarQueryClient>,
  entry: string,
) {
  return render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider rootElement={rootElement}>
        <AppearanceProvider rootElement={rootElement}>
          <MemoryRouter initialEntries={[entry]}>
            <ReferenceCezarProvider
              client={fakeCezarClient('reference')}
              queryClient={queryClient}
              rootElement={rootElement}
            >
              <Probe expectedQueryClient={queryClient} />
            </ReferenceCezarProvider>
          </MemoryRouter>
        </AppearanceProvider>
      </ThemeProvider>
    </QueryClientProvider>,
    { container: rootElement },
  )
}

it('adopts the existing root and maps the current project route without another router or cache', () => {
  const rootElement = document.createElement('div')
  rootElement.id = 'root'
  rootElement.className = 'host-root'
  document.body.append(rootElement)
  const queryClient = createCezarQueryClient()

  const view = renderReference(rootElement, queryClient, '/p/project-a/tasks/run-a')

  const probe = screen.getByTestId('reference-runtime')
  expect(probe.getAttribute('data-project')).toBe('project-a')
  expect(probe.getAttribute('data-task-href')).toBe('/p/project-a/tasks/run-a')
  expect(probe.getAttribute('data-tasks-href')).toBe('/p/project-a/')
  expect(probe.getAttribute('data-same-query-client')).toBe('true')
  expect(rootElement.classList.contains('cezar-root')).toBe(true)
  expect(document.querySelectorAll('.cezar-root')).toHaveLength(1)
  expect(rootElement.querySelectorAll('.cezar-root')).toHaveLength(0)

  view.unmount()
  expect(rootElement.className).toBe('host-root')
})

it('passes the current cockpit appearance through to the adopted Cezar root', () => {
  const rootElement = document.createElement('div')
  document.body.append(rootElement)
  const queryClient = createCezarQueryClient()

  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider rootElement={rootElement}>
        <AppearanceProvider rootElement={rootElement}>
        <MemoryRouter initialEntries={['/p/project-a/']}>
          <ReferenceCezarProvider
            client={fakeCezarClient('reference')}
            queryClient={queryClient}
            rootElement={rootElement}
          >
            <Probe expectedQueryClient={queryClient} />
          </ReferenceCezarProvider>
        </MemoryRouter>
        </AppearanceProvider>
      </ThemeProvider>
    </QueryClientProvider>,
    { container: rootElement },
  )

  expect(rootElement.getAttribute('data-cezar-theme')).toBe('dark')
  expect(rootElement.getAttribute('data-cezar-accent')).toBe('lime')
  expect(rootElement.getAttribute('data-cezar-density')).toBe('comfortable')
  expect(rootElement.getAttribute('data-cezar-width')).toBe('narrow')
})

it.each([
  ['/p/project%20space/tasks/run-a', 'project space', '/p/project%20space/tasks/run-a'],
  ['/p/%E2%9C%93/tasks/run-a', '✓', '/p/%E2%9C%93/tasks/run-a'],
  ['/p/team%2Fcore/tasks/run-a', 'team/core', '/p/team%2Fcore/tasks/run-a'],
  ['/p/100%25/tasks/run-a', '100%', '/p/100%25/tasks/run-a'],
  ['/p/bad%ZZ/tasks/run-a', 'bad%ZZ', '/p/bad%25ZZ/tasks/run-a'],
])('decodes project scope exactly once for %s', (route, projectId, taskHref) => {
  const rootElement = document.createElement('div')
  document.body.append(rootElement)
  const queryClient = createCezarQueryClient()
  const view = renderReference(rootElement, queryClient, route)

  const probe = screen.getByTestId('reference-runtime')
  expect(probe.getAttribute('data-project')).toBe(projectId)
  expect(probe.getAttribute('data-api-project')).toBe(projectId)
  expect(probe.getAttribute('data-task-href')).toBe(taskHref)
  view.unmount()
})
