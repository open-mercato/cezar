import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'

import type { CezarClient } from '@open-mercato/cezar-api-client'

const { providerProps } = vi.hoisted(() => ({ providerProps: [] as unknown[] }))

vi.mock('@open-mercato/cezar-react', () => ({
  CezarProvider: (props: unknown) => {
    providerProps.push(props)
    return null
  },
}))

import { AppearanceProvider } from './appearance-provider'
import { ReferenceCezarProvider } from './reference-cezar-provider'
import { ThemeProvider } from './theme-provider'

afterEach(() => {
  localStorage.clear()
  providerProps.length = 0
  vi.unstubAllGlobals()
})

it('passes the resolved light system theme into CezarProvider before it mounts', () => {
  const rootElement = document.createElement('div')
  const queryClient = new QueryClient()
  localStorage.setItem('cez-theme', 'system')
  vi.stubGlobal(
    'matchMedia',
    () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }),
  )

  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider rootElement={rootElement}>
        <AppearanceProvider rootElement={rootElement}>
          <MemoryRouter initialEntries={['/p/project-a/']}>
            <ReferenceCezarProvider
              client={{ identity: 'reference' } as CezarClient}
              queryClient={queryClient}
              rootElement={rootElement}
            >
              <span />
            </ReferenceCezarProvider>
          </MemoryRouter>
        </AppearanceProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  )

  expect(providerProps.at(-1)).toMatchObject({ theme: 'light' })
})
