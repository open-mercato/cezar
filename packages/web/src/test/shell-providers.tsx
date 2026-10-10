import type { ReactNode } from 'react'

import { GlobalSettingsProvider } from '@/components/global-settings'
import { SidebarProvider } from '@/components/ui/sidebar'

/**
 * Test-only: the two contexts the app shell gives every route — global settings as dialog state
 * (`AppShellContainer`) and the sidebar (`AppShell`). A unit test that renders a route or a
 * shell-level component on its own wraps it in this, so `useGlobalSettings()` and `useSidebar()`
 * resolve the way they do in the running cockpit.
 *
 * `dialog` is what `GlobalSettingsProvider` renders beside the children — pass
 * `<GlobalSettingsDialog />` when the test is about the dialog itself, leave it out otherwise.
 */
export function ShellProviders({ children, dialog }: { children: ReactNode; dialog?: ReactNode }) {
  return (
    <GlobalSettingsProvider dialog={dialog}>
      <SidebarProvider>{children}</SidebarProvider>
    </GlobalSettingsProvider>
  )
}
