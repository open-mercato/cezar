import type { CSSProperties } from 'react'

import { useHealth } from '@/api/queries'
import { useGlobalSettings } from '@/components/global-settings'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from '@/components/ui/sidebar'
import { visibleSettingsSections, type SettingsSectionId } from '@/routes/settings/registry'

/**
 * Global settings as a dialog (the shadcn `sidebar-13` block): cezar's own preferences — the
 * `scope: 'global'` sections of the settings registry — over whatever screen you were on.
 *
 * Left: the section nav, capability-gated by the same `visibleSettingsSections` the routes used.
 * Right: a "Settings › Section" header and the section's component, rendered exactly as the page
 * rendered it. The dialog sits outside every project scope, as the `/settings/global` routes
 * did, so the sections keep reading the workspace routes.
 *
 * Phones get the whole screen, and a Select in the header instead of the nav column.
 *
 * The `SidebarProvider` is here only because the sidebar parts read its context; it is held open
 * with a no-op setter so ⌘B (which every provider listens for) changes nothing in here.
 */
const NOOP = () => {}

export function GlobalSettingsDialog() {
  const { isOpen, close, section, setSection } = useGlobalSettings()
  const capabilities = useHealth().data?.capabilities
  const sections = visibleSettingsSections('global', capabilities)
  // An unknown or capability-hidden id (a stale deep link) falls back to the first section.
  const active = sections.find((entry) => entry.id === section) ?? sections[0]

  return (
    <Dialog open={isOpen} onOpenChange={(next) => (next ? undefined : close())}>
      <DialogContent
        data-slot="global-settings-dialog"
        data-section={active?.id}
        // Focus the dialog itself rather than its first nav row: focus is inside (Escape and the
        // trap work) without a section button lighting up before anything was pressed.
        tabIndex={-1}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          ;(event.currentTarget as HTMLElement).focus()
        }}
        className="flex h-dvh w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:max-w-none md:h-[min(640px,calc(100dvh-4rem))] md:w-[calc(100vw-4rem)] md:max-w-[920px] md:rounded-xl md:border"
      >
        <DialogTitle className="sr-only">Global settings</DialogTitle>
        <DialogDescription className="sr-only">
          Preferences for you and this machine, shared by every project.
        </DialogDescription>
        {active ? (
          <SidebarProvider
            open
            onOpenChange={NOOP}
            className="min-h-0 flex-1 items-stretch"
            style={{ '--sidebar-width': '13.5rem' } as CSSProperties}
          >
            <Sidebar collapsible="none" className="hidden border-r border-border/70 md:flex">
              <SidebarContent>
                <SidebarGroup>
                  <SidebarGroupContent>
                    <SidebarMenu>
                      {sections.map((entry) => (
                        <SidebarMenuItem key={entry.id}>
                          <SidebarMenuButton
                            isActive={entry.id === active.id}
                            data-section={entry.id}
                            aria-current={entry.id === active.id ? 'page' : undefined}
                            onClick={() => setSection(entry.id)}
                          >
                            <entry.icon aria-hidden="true" />
                            <span>{entry.title}</span>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      ))}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
              </SidebarContent>
              <SidebarFooter className="p-4">
                <p className="text-xs text-soft-foreground">Stored in ~/.cezar</p>
              </SidebarFooter>
            </Sidebar>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-card">
              {/* `pr-12` keeps the trail clear of the dialog's close button. */}
              <header className="flex h-14 shrink-0 items-center gap-2 pr-12 pl-4 pt-[env(safe-area-inset-top)] md:pl-6">
                <Breadcrumb className="hidden md:block">
                  <BreadcrumbList>
                    <BreadcrumbItem>Settings</BreadcrumbItem>
                    <BreadcrumbSeparator />
                    <BreadcrumbItem>
                      <BreadcrumbPage>{active.title}</BreadcrumbPage>
                    </BreadcrumbItem>
                  </BreadcrumbList>
                </Breadcrumb>
                <div className="min-w-0 flex-1 md:hidden">
                  <Select value={active.id} onValueChange={(next) => setSection(next as SettingsSectionId)}>
                    <SelectTrigger aria-label="Settings section" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {sections.map((entry) => (
                        <SelectItem key={entry.id} value={entry.id}>
                          {entry.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </header>
              {/* Keyed by section so each one opens scrolled to its top. */}
              <div
                key={active.id}
                data-slot="global-settings-content"
                className="min-h-0 flex-1 overflow-y-auto px-4 pb-[calc(1.5rem+env(safe-area-inset-bottom))] md:px-6"
              >
                <p className="max-w-2xl pb-5 text-sm text-pretty text-muted-foreground">{active.description}</p>
                <active.component />
              </div>
            </div>
          </SidebarProvider>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
