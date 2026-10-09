import { PlusIcon } from 'lucide-react'
import { useState, type MouseEvent } from 'react'

import { useWorkflows } from '@/api/queries'
import { ContextSidebar } from '@/components/context-sidebar'
import { Button } from '@/components/ui/button'
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import { Link } from '@/lib/project-router'

/**
 * The Workflows area's contextual sidebar: every workflow the editor can open — the repo's own
 * files and the built-in templates — each a link to its canvas. It replaces the picker the
 * editor's toolbar used to carry.
 *
 * `onOpen` lets the editor guard a navigation: it returns false to take the click over (the
 * discard-unsaved-changes confirm) and the link then does nothing on its own.
 */
export function WorkflowsSidebar({
  activeName,
  onOpen,
}: {
  /** The workflow on the canvas; undefined on the blank canvas at `/workflows`. */
  activeName: string | undefined
  onOpen: (to: string) => boolean
}) {
  const workflows = useWorkflows()
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const all = workflows.data?.workflows ?? []
  const matching = needle ? all.filter((w) => w.name.toLowerCase().includes(needle)) : all
  const groups = [
    { label: 'This repo', items: matching.filter((w) => w.source === 'file') },
    { label: 'Built-in templates', items: matching.filter((w) => w.source === 'built-in') },
  ]
  const guard = (to: string) => (event: MouseEvent) => {
    // A modified click opens another tab, which loses nothing here.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
    if (!onOpen(to)) event.preventDefault()
  }

  return (
    <ContextSidebar>
      <SidebarHeader className="gap-3 p-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="px-1 text-[15px] font-semibold text-foreground">Workflows</h2>
          <Button asChild size="sm" variant="outline" className="gap-1.5">
            <Link to="/workflows" onClick={guard('/workflows')} aria-label="New workflow">
              <PlusIcon aria-hidden="true" />
              New
            </Link>
          </Button>
        </div>
        <SidebarInput
          type="search"
          aria-label="Search workflows"
          placeholder="Search workflows"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </SidebarHeader>
      <SidebarContent data-slot="workflows-list">
        {workflows.isPending ? (
          <p className="px-4 py-2 text-xs text-muted-foreground">Loading workflows…</p>
        ) : workflows.isError ? (
          <p className="px-4 py-2 text-xs text-muted-foreground">The workflows did not load.</p>
        ) : matching.length === 0 ? (
          <p className="px-4 py-2 text-xs text-muted-foreground">
            {needle ? 'No workflow matches the search.' : 'No workflows yet.'}
          </p>
        ) : (
          groups.map((group) =>
            group.items.length === 0 ? null : (
              <SidebarGroup key={group.label} className="pt-0">
                <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {group.items.map((w) => {
                      const to = `/workflows/${encodeURIComponent(w.name)}`
                      // A v1 file (steps, no graph) still opens as a graph; the badge says which it is.
                      const v1 = w.source === 'file' && !w.graph
                      return (
                        <SidebarMenuItem key={w.name}>
                          <SidebarMenuButton asChild isActive={w.name === activeName} title={w.name}>
                            <Link to={to} onClick={guard(to)} aria-current={w.name === activeName ? 'page' : undefined}>
                              <span className="truncate">{w.name}</span>
                            </Link>
                          </SidebarMenuButton>
                          {v1 ? <SidebarMenuBadge className="text-muted-foreground">v1</SidebarMenuBadge> : null}
                        </SidebarMenuItem>
                      )
                    })}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            ),
          )
        )}
      </SidebarContent>
    </ContextSidebar>
  )
}
