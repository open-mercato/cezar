import { useCallback, useMemo, type ReactNode } from 'react'
import { matchPath, useLocation, useNavigate } from 'react-router'

import {
  CezarProvider,
  type CezarLocation,
  type CezarNavigationAdapter,
  type CezarRuntimeClient,
} from '@open-mercato/cezar-react'
import type { QueryClient } from '@tanstack/react-query'

import { useAppearance } from './appearance-provider'
import { useTheme } from './theme-provider'

export interface ReferenceCezarProviderProps {
  client: CezarRuntimeClient
  queryClient: QueryClient
  rootElement: HTMLElement
  children: ReactNode
  onAuthRequired?: (error: import('@open-mercato/cezar-api-client').ApiError) => void | Promise<void>
  onError?: (error: import('@open-mercato/cezar-api-client').ApiError) => void
  className?: string
}

function segment(value: string): string {
  return encodeURIComponent(value)
}

function decodeProjectSegment(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function projectPath(projectId: string | null, path: string): string {
  return projectId === null ? path : `/p/${segment(projectId)}${path}`
}

/** Map the public semantic contract onto the reference cockpit's current URL scheme. */
export function referenceCezarHref(
  projectId: string | null,
  target: CezarLocation,
): string {
  switch (target.area) {
    case 'tasks':
      return projectId === null ? '/' : projectPath(projectId, '/')
    case 'new-task': {
      const path = projectPath(projectId, '/new')
      return target.template === undefined
        ? path
        : `${path}?template=${segment(target.template)}`
    }
    case 'task': {
      const tab = target.tab === undefined || target.tab === 'session' ? '' : `/${target.tab}`
      return projectPath(projectId, `/tasks/${segment(target.runId)}${tab}`)
    }
    case 'repository': {
      const section = target.section === undefined || target.section === 'changes'
        ? ''
        : `/${target.section}`
      return projectPath(projectId, `/git${section}`)
    }
    case 'github': {
      const base = target.kind === undefined || target.kind === 'issue'
        ? target.number === undefined ? '/github' : '/github/issues'
        : '/github/prs'
      return projectPath(
        projectId,
        target.number === undefined ? base : `${base}/${target.number}`,
      )
    }
    case 'workflows':
      return projectPath(
        projectId,
        target.workflowId === undefined ? '/workflows' : `/workflows/${segment(target.workflowId)}`,
      )
    case 'skills': {
      const path = projectPath(projectId, '/skills')
      return target.skillId === undefined ? path : `${path}?skill=${segment(target.skillId)}`
    }
    case 'inbox':
      return projectPath(projectId, '/inbox')
    case 'settings': {
      const base = target.scope === 'global'
        ? '/settings/global'
        : projectPath(projectId, '/settings')
      return target.section === undefined ? base : `${base}/${segment(target.section)}`
    }
  }
}

/** The private cockpit adapter: existing router, existing cache, existing mount node. */
export function ReferenceCezarProvider({
  client,
  queryClient,
  rootElement,
  children,
  onAuthRequired,
  onError,
  className,
}: ReferenceCezarProviderProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const projectMatch = matchPath('/p/:projectId/*', location.pathname)
  const encodedProjectId = projectMatch?.params.projectId
  const projectId = encodedProjectId === undefined ? null : decodeProjectSegment(encodedProjectId)
  const href = useCallback(
    (target: CezarLocation) => referenceCezarHref(projectId, target),
    [projectId],
  )
  const navigation = useMemo<CezarNavigationAdapter>(
    () => ({
      href,
      navigate: (target, options) => navigate(href(target), options),
    }),
    [href, navigate],
  )
  const { theme } = useTheme()
  const { accent, density, width } = useAppearance()

  return (
    <CezarProvider
      client={client}
      projectId={projectId}
      queryClient={queryClient}
      navigation={navigation}
      rootElement={rootElement}
      theme={theme}
      accent={accent}
      density={density}
      width={width}
      className={className}
      onAuthRequired={onAuthRequired}
      onError={onError}
    >
      {children}
    </CezarProvider>
  )
}
