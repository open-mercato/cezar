declare module '#cezar-web-cockpit' {
  import type { QueryClient } from '@tanstack/react-query'
  import type { ApiError, CezarClient } from '@open-mercato/cezar-api-client'
  import type { CezarRuntimeClient } from '@open-mercato/cezar-react'

  export interface CezarCockpitImplementationProps<
    TClient extends CezarRuntimeClient = CezarClient,
  > {
    client: TClient
    queryClient: QueryClient
    rootElement: HTMLElement
    onAuthRequired?: (error: ApiError) => void | Promise<void>
    onError?: (error: ApiError) => void
    className?: string
  }

  export function CezarCockpitImplementation<TClient extends CezarRuntimeClient>(
    props: CezarCockpitImplementationProps<TClient>,
  ): React.JSX.Element
}
