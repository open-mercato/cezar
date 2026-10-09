import * as React from 'react'
import { createPortal } from 'react-dom'

/**
 * The contextual sidebar: the collapsible column inside the content panel that belongs to the
 * SCREEN you are on, not to the app. The icon rail says which area you are in; this says what
 * is in it — the task list on Tasks, the file tree on Git, the pull requests on GitHub, the
 * section list in Settings.
 *
 * A screen fills it by rendering `<ContextSidebar>` anywhere in its tree. The children are
 * portalled into the shell's sidebar, so they keep the screen's own React context (queries,
 * router, project scope) while living in the shell's chrome. A screen that renders none gets no
 * sidebar at all, and the top bar's toggle disappears with it.
 *
 * Compose the children from the shadcn sidebar parts — `SidebarHeader`, `SidebarContent`,
 * `SidebarGroup`, `SidebarGroupLabel`, `SidebarMenu`, `SidebarMenuItem`, `SidebarMenuButton`,
 * `SidebarMenuSub`, `SidebarInput`, `SidebarFooter` — they render correctly here.
 */
type ContextSidebarValue = {
  /** Where the children are portalled. Null while the sidebar is not mounted (a closed sheet). */
  node: HTMLElement | null
  /** Called by every mounted `<ContextSidebar>`; the returned function unregisters it. */
  register: () => () => void
}

export const ContextSidebarContext = React.createContext<ContextSidebarValue | null>(null)

export function ContextSidebar({ children }: { children: React.ReactNode }) {
  const context = React.useContext(ContextSidebarContext)
  const register = context?.register
  React.useEffect(() => register?.(), [register])
  if (!context?.node) return null
  return createPortal(children, context.node)
}
