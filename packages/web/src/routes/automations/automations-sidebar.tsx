import { CalendarClockIcon, CalendarDaysIcon, CalendarRangeIcon, ListIcon, PlusIcon } from 'lucide-react'
import type { AutomationsResponse } from '@open-mercato/cezar-api-client'

import { ContextSidebar } from '@/components/context-sidebar'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import { triggerLabel } from '@/lib/automation-format'
import { Link } from '@/lib/project-router'

import type { AutomationsView } from './automations-route'

const VIEWS = [
  { value: 'list', label: 'List', to: '/automations', icon: ListIcon },
  { value: 'week', label: 'Week', to: '/automations?view=week', icon: CalendarRangeIcon },
  { value: 'day', label: 'Day', to: '/automations?view=day', icon: CalendarDaysIcon },
] as const

/**
 * The Automations area's contextual sidebar, the same on the list, the editor and the log: the
 * views of the overview (`?view=`, as before), the "Next runs" sheet, and every automation as a
 * link to its editor — so you move from one automation to the next without going back.
 */
export function AutomationsSidebar({
  data,
  view,
  activeId,
  upcomingCount,
  onNextRuns,
}: {
  data: AutomationsResponse | undefined
  /** The overview's current view; null on the editor and the log, where none is selected. */
  view: AutomationsView | null
  activeId: string | undefined
  upcomingCount: number
  onNextRuns: () => void
}) {
  return (
    <ContextSidebar>
      <SidebarHeader className="gap-3 p-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="px-1 text-[15px] font-semibold text-foreground">Automations</h2>
          <Button asChild size="sm" variant="outline" className="gap-1.5">
            <Link to="/automations/new" aria-label="New automation">
              <PlusIcon aria-hidden="true" />
              New
            </Link>
          </Button>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="pt-0">
          <SidebarGroupContent>
            <SidebarMenu data-slot="automations-views">
              {VIEWS.map((option) => (
                <SidebarMenuItem key={option.value}>
                  <SidebarMenuButton asChild isActive={view === option.value}>
                    <Link to={option.to} data-value={option.value} aria-current={view === option.value ? 'page' : undefined}>
                      <option.icon aria-hidden="true" />
                      <span>{option.label}</span>
                    </Link>
                  </SidebarMenuButton>
                  {option.value === 'list' && data ? (
                    <SidebarMenuBadge className="text-muted-foreground">{data.automations.length}</SidebarMenuBadge>
                  ) : null}
                </SidebarMenuItem>
              ))}
              <SidebarMenuItem>
                <SidebarMenuButton onClick={onNextRuns} disabled={!data}>
                  <CalendarClockIcon aria-hidden="true" />
                  <span>Next runs</span>
                </SidebarMenuButton>
                {data ? <SidebarMenuBadge className="text-muted-foreground">{upcomingCount}</SidebarMenuBadge> : null}
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>All automations</SidebarGroupLabel>
          <SidebarGroupContent>
            {!data ? (
              <p className="px-2 py-1 text-xs text-muted-foreground">Loading automations…</p>
            ) : data.automations.length === 0 ? (
              <p className="px-2 py-1 text-xs text-muted-foreground">No automations yet.</p>
            ) : (
              <SidebarMenu data-slot="automations-nav">
                {data.automations.map((automation) => {
                  const trigger = triggerLabel(automation)
                  return (
                    <SidebarMenuItem key={automation.id}>
                      <SidebarMenuButton asChild isActive={automation.id === activeId} className="h-auto items-start py-2">
                        <Link
                          to={`/automations/${encodeURIComponent(automation.id)}`}
                          title={`${automation.name} — ${trigger}`}
                          aria-current={automation.id === activeId ? 'page' : undefined}
                        >
                          <span className="flex h-5 w-4 shrink-0 items-center justify-center">
                            <StatusDot tone={automation.enabled ? 'success' : 'neutral'} />
                            <span className="sr-only">{automation.enabled ? 'Enabled' : 'Paused'}</span>
                          </span>
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate">{automation.name}</span>
                            <span className="truncate text-xs font-normal text-muted-foreground">{trigger}</span>
                          </span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            )}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </ContextSidebar>
  )
}
