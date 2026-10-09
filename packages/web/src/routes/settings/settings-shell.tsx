import { ChevronRightIcon, Settings2Icon, SlidersHorizontalIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Capabilities } from '@open-mercato/cezar-api-client'
import { useProjects } from '@/api/queries'
import { ContextSidebar } from '@/components/context-sidebar'
import { useGlobalSettings } from '@/components/global-settings'
import { Page, PageBody, PageHeader } from '@/components/page'
import { Card } from '@/components/ui/card'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemSeparator, ItemTitle } from '@/components/ui/item'
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from '@/components/ui/sidebar'
import { Link, useActiveProjectId } from '@/lib/project-router'
import { ProjectGeneral } from './project-general'
import { ProjectLocationNav } from './project-location'
import { Button } from '@/components/ui/button'
import { visibleSettingsSections, type SettingsScope, type SettingsSection } from './registry'

/**
 * The registry-driven PROJECT settings screen (R6 Step 1.3, spec §"Settings").
 *
 * The section list lives in the shell's contextual sidebar (`<ContextSidebar>`): "General" (the
 * area index — folder, facts, limits, danger zone), then every visible `scope: 'project'`
 * section of the registry, then the door to Global settings. The main area is the selected
 * section alone, in one comfortable column. On phones the sidebar is a sheet; the index also
 * lists the sections in the page itself, so the bare `/settings` is never a dead end there.
 *
 * Global settings are no longer a page: they are `GlobalSettingsDialog`, opened through
 * `useGlobalSettings().open(section)`. `/settings/global/<id>` stays a deep link that opens it
 * (see `routes.tsx`).
 *
 * Every section is its own URL, so the h1 is the SECTION title. Hidden registry entries are not
 * routed, so their URLs are honest 404s until the section ships.
 */

/** A section's URL: project-relative for project sections, the dialog's deep link for global. */
export function settingsSectionPath(scope: SettingsScope, id: SettingsSection['id']): string {
  return scope === 'global' ? `/settings/global/${id}` : `/settings/${id}`
}

type Caps = Partial<Pick<Capabilities, 'singleProject'>>

/** Sections whose content is a work surface (an editor) rather than a form. */
const WIDE_SECTIONS: ReadonlySet<SettingsSection['id']> = new Set(['agent-config'])

/** The contextual sidebar of project settings: which project, its sections, the global door. */
function ProjectSettingsSidebar({
  activeId,
  capabilities,
}: {
  activeId: SettingsSection['id'] | null
  capabilities?: Caps
}) {
  const globalSettings = useGlobalSettings()
  const projectId = useActiveProjectId()
  const project = useProjects().data?.projects.find((entry) => entry.id === projectId)
  return (
    <ContextSidebar>
      <SidebarHeader className="gap-0.5 p-3">
        <h2 className="text-[15px] font-semibold text-foreground">Project settings</h2>
        {project ? <p className="truncate text-xs text-muted-foreground">{project.name}</p> : null}
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu data-slot="settings-nav" aria-label="Settings sections">
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={activeId === null}>
                  <Link
                    to="/settings"
                    data-slot="settings-nav-index"
                    aria-current={activeId === null ? 'page' : undefined}
                  >
                    <SlidersHorizontalIcon aria-hidden="true" />
                    <span>General</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {visibleSettingsSections('project', capabilities).map((section) => (
                <SidebarMenuItem key={section.id}>
                  <SidebarMenuButton asChild isActive={section.id === activeId}>
                    <Link
                      to={settingsSectionPath('project', section.id)}
                      data-section={section.id}
                      aria-current={section.id === activeId ? 'page' : undefined}
                    >
                      <section.icon aria-hidden="true" />
                      <span>{section.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarSeparator className="mx-3" />
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                {/* Appearance, notifications, resources, accounts, the registry: cezar's own,
                    a dialog over this screen rather than another page. */}
                <SidebarMenuButton data-slot="settings-global-link" onClick={() => globalSettings.open()}>
                  <Settings2Icon aria-hidden="true" />
                  <span>Global settings…</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      {/* "What am I editing?" — WHICH repo, by its absolute path on disk. */}
      <SidebarFooter className="p-3 empty:hidden">
        <ProjectLocationNav />
      </SidebarFooter>
    </ContextSidebar>
  )
}

/** The frame both routes share: the sidebar nav, and one column for the content. */
function SettingsFrame({
  route,
  activeId,
  capabilities,
  title,
  description,
  wide = false,
  children,
}: {
  route: string
  activeId: SettingsSection['id'] | null
  capabilities?: Caps
  title: ReactNode
  description: ReactNode
  wide?: boolean
  children: ReactNode
}) {
  return (
    <Page data-route={route} width={wide ? 'wide' : 'narrow'}>
      <ProjectSettingsSidebar activeId={activeId} capabilities={capabilities} />
      <PageHeader title={title} description={description} />
      <PageBody className="pb-[calc(2.5rem+env(safe-area-inset-bottom))]">{children}</PageBody>
    </Page>
  )
}

/** One registered project section — `/p/<id>/settings/<section>`. */
export function SettingsSectionRoute({
  section,
  capabilities,
}: {
  section: SettingsSection
  capabilities?: Caps
}) {
  const Body = section.component
  return (
    <SettingsFrame
      route={`settings-${section.id}`}
      activeId={section.id}
      capabilities={capabilities}
      title={section.title}
      description={section.description}
      wide={WIDE_SECTIONS.has(section.id)}
    >
      <Body />
    </SettingsFrame>
  )
}

/** The area's index: the General page (folder, facts, limits, danger zone). Below `md` it also
 *  lists the sections — the sidebar is a closed sheet there, and this is the way in. */
export function SettingsIndexRoute({ capabilities }: { capabilities?: Caps }) {
  const globalSettings = useGlobalSettings()
  const sections = visibleSettingsSections('project', capabilities)
  return (
    <SettingsFrame
      route="settings"
      activeId={null}
      capabilities={capabilities}
      title="General"
      description="What this project is, where it lives and how hard it may push the machine."
    >
      <div className="flex flex-col gap-8">
        {/* `capabilities` travels because the registry half of that page is exactly what
            single-project mode disables, the same gate `visibleSettingsSections` applies. */}
        <ProjectGeneral capabilities={capabilities} />
        <Card flush data-slot="settings-index" className="md:hidden">
          <ItemGroup>
            {sections.map((section, index) => (
              <div key={section.id}>
                {index > 0 ? <ItemSeparator /> : null}
                <Item asChild size="sm" className="rounded-none">
                  <Link to={settingsSectionPath('project', section.id)} data-section={section.id}>
                    <ItemMedia variant="icon">
                      <section.icon aria-hidden="true" />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>{section.title}</ItemTitle>
                      <ItemDescription>{section.description}</ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <ChevronRightIcon aria-hidden="true" className="size-4 text-soft-foreground" />
                    </ItemActions>
                  </Link>
                </Item>
              </div>
            ))}
          </ItemGroup>
        </Card>
        {/* The cross-link to the other half: the split is only discoverable if this one says
            where the rest is. */}
        <p className="text-[13px] text-muted-foreground">
          Appearance, notifications, host resources and the project registry live in{' '}
          <Button
            type="button"
            variant="link"
            data-slot="settings-global-link"
            onClick={() => globalSettings.open()}
            className="inline h-auto p-0 text-[length:inherit] whitespace-normal font-medium underline decoration-border hover:decoration-foreground"
          >
            Global settings
          </Button>
          .
        </p>
      </div>
    </SettingsFrame>
  )
}
