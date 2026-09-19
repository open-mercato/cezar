import { useQuery } from '@tanstack/react-query'
import { Clock3Icon } from 'lucide-react'
import { useState } from 'react'

import { queryScope } from '@open-mercato/cezar-api-client'
import { getAutomationTemplates } from '@/api/client'
import { BranchChip } from '@/components/branch-chip'
import { GithubIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { BUILTIN_AUTOMATION_TEMPLATES } from '@/lib/automation-templates'
import { triggerLabel } from '@/lib/automation-format'
import { useActiveProjectId } from '@/lib/project-router'
import { cn } from '@/lib/utils'

import { templatePick, type TemplatePick } from './editor-draft'

type Tab = 'builtin' | 'mine'

interface PaletteItem extends TemplatePick {
  key: string
  when: string
  project?: string
}

export const automationTemplatesQueryKey = (exclude: string | null) =>
  [queryScope(), 'automation-templates', exclude ?? ''] as const

/**
 * The editor's starting points (spec 2026-09-14-automations-redesign § UI/UX 4.1): the built-in
 * templates, and — loaded only when the tab is opened — the other registered projects'
 * automations. "Use this" hands the whole definition to the form and the palette closes.
 */
export function TemplatePalette({ onPick }: { onPick: (template: TemplatePick) => void }) {
  const [tab, setTab] = useState<Tab>('builtin')
  const projectId = useActiveProjectId()
  const others = useQuery({
    queryKey: automationTemplatesQueryKey(projectId),
    queryFn: ({ signal }) => getAutomationTemplates(projectId, { signal }),
    enabled: tab === 'mine',
  })

  const items: PaletteItem[] = tab === 'builtin'
    ? BUILTIN_AUTOMATION_TEMPLATES.map((template) => ({ ...template, key: template.name }))
    : (others.data?.templates ?? []).map((template) => ({
        ...templatePick(template),
        key: `${template.project.id}:${template.id}`,
        when: triggerLabel(template),
        project: template.project.name,
      }))

  return (
    <Card flush data-slot="template-palette" className="pb-3">
      <div className="flex items-end gap-3 border-b border-border px-4 pt-2.5">
        <div role="tablist" aria-label="Template source" className="flex shrink-0">
          <PaletteTab active={tab === 'builtin'} onClick={() => setTab('builtin')}>Built-in</PaletteTab>
          <PaletteTab active={tab === 'mine'} onClick={() => setTab('mine')}>From your other projects</PaletteTab>
        </div>
        <span className="ml-auto min-w-0 overflow-hidden pb-2 text-xs text-ellipsis whitespace-nowrap text-soft-foreground">
          {tab === 'builtin' ? 'Ship with cezar' : 'Registered in ~/.cezar/config.json'}
        </span>
      </div>
      {tab === 'mine' && others.isPending ? (
        <p className="px-4 pt-3 text-xs text-soft-foreground">Loading…</p>
      ) : tab === 'mine' && others.isError ? (
        <p role="alert" className="px-4 pt-3 text-xs text-danger">{others.error.message}</p>
      ) : items.length === 0 ? (
        <p className="px-4 pt-3 text-xs text-soft-foreground">No automations in your other projects yet.</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2.5 px-4 pt-3">
          {items.map((item) => (
            <div
              key={item.key}
              data-slot="template-card"
              className="flex flex-col gap-1.5 rounded-[10px] border border-border bg-card-2 px-3 py-2.5"
            >
              <div className="flex items-center gap-2 text-[13px] font-semibold">
                {item.kind === 'github'
                  ? <GithubIcon aria-hidden="true" className="size-[13px] shrink-0 text-soft-foreground" />
                  : <Clock3Icon aria-hidden="true" className="size-[13px] shrink-0 text-soft-foreground" />}
                <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{item.name}</span>
                {item.project ? <BranchChip className="ml-auto">{item.project}</BranchChip> : null}
              </div>
              <div className="font-mono text-[11.5px] text-muted-foreground">{item.when}</div>
              <div className="line-clamp-2 text-xs leading-[1.45] text-soft-foreground">{item.prompt}</div>
              <Button
                variant="outline"
                size="sm"
                className="mt-0.5 self-start"
                aria-label={`Use this: ${item.name}`}
                onClick={() => onPick(item)}
              >
                Use this
              </Button>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

/** The `TabLink` grammar without a URL: the palette's tabs switch a panel, not a route. */
function PaletteTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        '-mb-px flex h-8 items-center rounded-t-md border-b-2 px-3 text-[13px] font-medium',
        active
          ? 'border-foreground font-semibold text-foreground'
          : 'border-transparent text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}
