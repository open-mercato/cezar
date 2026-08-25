import { useState } from 'react'
import { BrowserRouter } from 'react-router'
import { createCezarClient, setApiBaseUrl } from '@open-mercato/cezar-api-client'
import type { AppType } from '@open-mercato/cezar/app-type'

import { createQueryClient } from './api/query-client'
import { CezarCockpitImplementation } from './cockpit-implementation'

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
export interface AppProps {
  apiBase: string
  rootElement: HTMLElement
}

export function App({ apiBase, rootElement }: AppProps) {
  // Lazy initial state rather than a module-level constant: one client per App instance, so a
  // test (or a remount) never inherits another's cache, and StrictMode's double-invoke of the
  // component body still yields exactly one client.
  const [queryClient] = useState(createQueryClient)
  const [cezarClient] = useState(() => createCezarClient<AppType>({ baseUrl: apiBase }))
  // This must run before the child providers mount: their first query and the workspace event
  // stream resolve their URLs at render/effect time.
  setApiBaseUrl(apiBase)

  return (
    <BrowserRouter>
      <CezarCockpitImplementation
        client={cezarClient}
        queryClient={queryClient}
        rootElement={rootElement}
      />
    </BrowserRouter>
  )
}
