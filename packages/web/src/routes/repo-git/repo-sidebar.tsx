import { PanelLeftIcon } from 'lucide-react'
import { useContext, type ReactNode } from 'react'

import type { RepoInfo } from '@open-mercato/cezar-api-client'
import { ContextSidebarContext } from '@/components/context-sidebar'
import { Button } from '@/components/ui/button'
import { SidebarHeader, useSidebar } from '@/components/ui/sidebar'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Link } from '@/lib/project-router'

import { BranchChip } from '../task-git/diff-controls'

export type RepoTab = 'changes' | 'commits' | 'branches'

const TABS: { value: RepoTab; to: string; label: string }[] = [
  { value: 'changes', to: '/git', label: 'Changes' },
  { value: 'commits', to: '/git/commits', label: 'Commits' },
  { value: 'branches', to: '/git/branches', label: 'Branches' },
]

/**
 * The Git screen's sidebar header: the title, the checked-out branch, and the
 * Changes | Commits | Branches switch. Each item is a link, so every section stays a URL
 * (`/git`, `/git/commits[/:sha]`, `/git/branches`). `children` is the section's own filter row.
 */
export function RepoSidebarHeader({ info, tab, children }: { info?: RepoInfo; tab: RepoTab; children?: ReactNode }) {
  return (
    <SidebarHeader data-slot="repo-header" className="gap-3 p-3">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <h2 className="px-1 text-[15px] font-semibold text-foreground">Git</h2>
        {info ? <BranchChip branch={info.branch} /> : null}
      </div>
      {info?.remote ? (
        <p data-slot="repo-remote" title={info.remote} className="-mt-1.5 truncate px-1 text-xs text-muted-foreground">
          {info.remote}
        </p>
      ) : null}
      <Tabs value={tab}>
        <TabsList data-slot="repo-tabs" className="w-full">
          {TABS.map((entry) => (
            <TabsTrigger key={entry.value} value={entry.value} asChild>
              <Link to={entry.to} aria-current={tab === entry.value ? 'page' : undefined}>
                {entry.label}
              </Link>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {children}
    </SidebarHeader>
  )
}

/** Closes the phone sheet after a pick that is not a navigation (a file, a branch). Call only
 *  from inside `<ContextSidebar>`, which renders only under the shell's sidebar provider. */
export function useCloseSidebarSheet(): () => void {
  const { isMobile, setOpenMobile } = useSidebar()
  return () => {
    if (isMobile) setOpenMobile(false)
  }
}

/**
 * "Open the list" for a main area with nothing selected: the sheet on a phone, the collapsed
 * column on desktop. Renders nothing outside the shell, and nothing while the list is on screen.
 */
export function OpenSidebarButton({ children }: { children: ReactNode }) {
  return useContext(ContextSidebarContext) ? <OpenSidebarButtonInner>{children}</OpenSidebarButtonInner> : null
}

function OpenSidebarButtonInner({ children }: { children: ReactNode }) {
  const { isMobile, open, setOpen, setOpenMobile } = useSidebar()
  if (!isMobile && open) return null
  return (
    <Button variant="outline" size="sm" onClick={() => (isMobile ? setOpenMobile(true) : setOpen(true))}>
      <PanelLeftIcon aria-hidden="true" />
      {children}
    </Button>
  )
}
