import { QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { BrowserRouter } from 'react-router'

import { GlobalEventsProvider } from './api/global-events'
import { createQueryClient } from './api/query-client'
import { AppShellContainer } from './components/app-shell-container'
import { AppearanceProvider } from './components/appearance-provider'
import { LastLocationController } from './components/last-location-controller'
import { ReferenceStatusRegistry } from './components/reference-status'
import { RunNotifications } from './components/run-notifications'
import { ThemeProvider } from './components/theme-provider'
import { Toaster } from './components/ui/toaster'
import { AppRoutes } from './routes'

/** Real URLs, no basename: the cockpit is always mounted at the origin root, and the server
 *  serves index.html for every non-/api GET (src/server/static-ui.ts), so a deep link like
 *  `/tasks/:id/changes` cold-loads and survives a refresh.
 *
 *  The shell is inside BrowserRouter because its nav reads the current location, and inside
 *  QueryClientProvider because its chips read `/api/health` and `/api/todos`. Each chip renders
 *  nothing until its query answers — no placeholder that would read as real data.
 *
 *  GlobalEventsProvider sits here, at the root, because the app gets exactly one `/api/events`
 *  stream: it is mounted for the app's whole life, above every route, so navigating never drops
 *  and reopens it — and it publishes the live usage map to anything below.
 */
export function App() {
  // Lazy initial state rather than a module-level constant: one client per App instance, so a
  // test (or a remount) never inherits another's cache, and StrictMode's double-invoke of the
  // component body still yields exactly one client.
  const [queryClient] = useState(createQueryClient)

  return (
    <QueryClientProvider client={queryClient}>
      <GlobalEventsProvider>
        {/* Beside the stream on purpose: it watches the run-list cache the stream patches
            (and reconciliation refetches), turning attention transitions into browser
            notifications when the tab is hidden (R6 1.7). Renders nothing. */}
        <RunNotifications />
        <ThemeProvider>
          {/* Beside ThemeProvider on purpose: appearance (accent/density) is the ui-state.json
              half of the same boot contract — mirror pre-paints, server truth reconciles. */}
          <AppearanceProvider>
            <BrowserRouter>
              <LastLocationController />
              {/* At the root for the same reason the event stream is: the sidebar, the task table
                  and an open run header all paint PR/issue chips, often the SAME ones, and each
                  asking for itself was several round trips and a staggered wave of colour. They
                  register what they are painting here instead, and it goes out as one request per
                  project. */}
              <ReferenceStatusRegistry>
                <AppShellContainer>
                  <AppRoutes />
                </AppShellContainer>
              </ReferenceStatusRegistry>
              {/* One toast outlet for the whole app — `toast()` is a module-level call. */}
              <Toaster />
            </BrowserRouter>
          </AppearanceProvider>
        </ThemeProvider>
      </GlobalEventsProvider>
    </QueryClientProvider>
  )
}
