import { useMemo, useState, type ReactNode } from 'react'

import { ContextSidebarContext } from '@/components/context-sidebar'

import { ShellProviders } from './shell-providers'

const noopRegister = () => () => {}

/**
 * Test-only: `ShellProviders` plus a mounted contextual sidebar. A route fills that sidebar by
 * rendering `<ContextSidebar>`, which portals into the node the shell owns (`AppShell`'s
 * `context-sidebar-body`) and renders NOTHING when there is none — so a unit test that asserts on
 * a list, a filter or a tab strip the redesign moved into the sidebar needs this host, or the
 * elements it looks for are never in the document.
 *
 * The body carries the same `data-slot="context-sidebar-body"` the real shell gives it, so a test
 * can scope a query to "what the screen put in its sidebar".
 */
export function ShellWithSidebar({ children, dialog }: { children: ReactNode; dialog?: ReactNode }) {
  const [node, setNode] = useState<HTMLElement | null>(null)
  const value = useMemo(() => ({ node, register: noopRegister }), [node])
  return (
    <ShellProviders dialog={dialog}>
      <ContextSidebarContext.Provider value={value}>
        <div ref={setNode} data-slot="context-sidebar-body" />
        {children}
      </ContextSidebarContext.Provider>
    </ShellProviders>
  )
}
