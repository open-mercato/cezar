import {
  createContext,
  useContext,
  type AnchorHTMLAttributes,
  type HTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from 'react'

export type CezarLocation =
  | { area: 'tasks' }
  | { area: 'new-task'; template?: string }
  | { area: 'task'; runId: string; tab?: 'session' | 'changes' | 'files' | 'commits' }
  | { area: 'repository'; section?: 'changes' | 'branches' | 'commits' }
  | { area: 'github'; kind?: 'issue' | 'pr'; number?: number }
  | { area: 'workflows'; workflowId?: string }
  | { area: 'skills'; skillId?: string }
  | { area: 'inbox' }
  | { area: 'settings'; scope: 'project' | 'global'; section?: string }

export interface CezarNavigationAdapter {
  href(target: CezarLocation): string | undefined
  navigate(target: CezarLocation, options?: { replace?: boolean }): void
}

export const defaultCezarNavigation: CezarNavigationAdapter = {
  href: () => undefined,
  navigate: () => undefined,
}

export const CezarNavigationContext = createContext<CezarNavigationAdapter | null>(null)

export function useCezarNavigation(): CezarNavigationAdapter {
  const navigation = useContext(CezarNavigationContext)
  if (navigation === null) {
    throw new Error('cezar: useCezarNavigation() must be called inside <CezarProvider>')
  }
  return navigation
}

export interface CezarLinkProps extends HTMLAttributes<HTMLElement> {
  to: CezarLocation
  replace?: boolean
  children?: ReactNode
  download?: AnchorHTMLAttributes<HTMLAnchorElement>['download']
  hrefLang?: string
  media?: string
  ping?: string
  referrerPolicy?: AnchorHTMLAttributes<HTMLAnchorElement>['referrerPolicy']
  rel?: string
  target?: string
  type?: string
}

/** Preserve true-link semantics whenever the host can produce an href. */
export function CezarLink({ to, replace, onClick, children, ...props }: CezarLinkProps) {
  const navigation = useCezarNavigation()
  const href = navigation.href(to)
  if (href !== undefined) {
    return <a {...props} href={href} onClick={onClick}>{children}</a>
  }

  const {
    download: _download,
    hrefLang: _hrefLang,
    media: _media,
    ping: _ping,
    referrerPolicy: _referrerPolicy,
    rel: _rel,
    target: _target,
    type: _anchorType,
    ...buttonProps
  } = props
  const navigate = (event: MouseEvent<HTMLButtonElement>) => {
    onClick?.(event)
    if (!event.defaultPrevented) {
      navigation.navigate(to, replace === undefined ? undefined : { replace })
    }
  }
  return (
    <button {...buttonProps} type="button" onClick={navigate}>
      {children}
    </button>
  )
}
