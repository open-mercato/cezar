import { createContext, useContext } from 'react'
import type { QueryClient } from '@tanstack/react-query'

import type { CezarClient, CezarProjectClient } from '@open-mercato/cezar-api-client'

import type { CezarNotifications } from './notifications.js'
import type { CezarStorage } from './storage.js'

/** Generic-independent API-client surface shared by every typed Cezar client. */
export type CezarRuntimeClient = Pick<
  CezarClient,
  'identity' | 'baseUrl' | 'events' | 'forProject'
>

export interface CezarRuntime {
  client: CezarRuntimeClient
  projectId: string | null
  projectClient: CezarProjectClient
  queryClient: QueryClient
  storage: CezarStorage
  notifications: CezarNotifications
}

export const CezarRuntimeContext = createContext<CezarRuntime | null>(null)

export function useCezarRuntime(): CezarRuntime {
  const runtime = useContext(CezarRuntimeContext)
  if (runtime === null) {
    throw new Error('cezar: useCezarRuntime() must be called inside <CezarProvider>')
  }
  return runtime
}
