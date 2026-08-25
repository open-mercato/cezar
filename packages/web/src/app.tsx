import { useState } from 'react'
import { createCezarClient, setApiBaseUrl } from '@open-mercato/cezar-api-client'
import type { AppType } from '@open-mercato/cezar/app-type'
import { CezarCockpit } from '@open-mercato/cezar-react/cockpit'

import { createQueryClient } from './api/query-client'

/** The public facade owns browser routing and the complete root composition. `App` retains only
 *  standalone runtime construction, so its one query client and event stream remain stable for
 *  the application lifetime. */
export interface AppProps {
  apiBase: string
}

export function App({ apiBase }: AppProps) {
  // Lazy initial state rather than a module-level constant: one client per App instance, so a
  // test (or a remount) never inherits another's cache, and StrictMode's double-invoke of the
  // component body still yields exactly one client.
  const [queryClient] = useState(createQueryClient)
  const [cezarClient] = useState(() => createCezarClient<AppType>({ baseUrl: apiBase }))
  // This must run before the child providers mount: their first query and the workspace event
  // stream resolve their URLs at render/effect time.
  setApiBaseUrl(apiBase)

  return (
    <CezarCockpit
      client={cezarClient}
      queryClient={queryClient}
      routing={{ mode: 'browser' }}
    />
  )
}
