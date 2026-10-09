import { useQuery } from '@tanstack/react-query'
import { Clock3Icon } from 'lucide-react'
import { useState } from 'react'

import { queryScope } from '@open-mercato/cezar-api-client'
import { getAutomationTemplates } from '@/api/client'
import { BranchChip } from '@/components/branch-chip'
import { GithubIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
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
    <section data-slot="template-palette" className="rounded-xl border bg-card p-4 shadow-xs">
      <div className="flex flex-wrap items-center gap-3">
        <div role="tablist" aria-label="Template source" className="inline-flex shrink-0 gap-0.5 rounded-md bg-muted p-[3px]">
          <PaletteTab active={tab === 'builtin'} onClick={() => setTab('builtin')}>Built-in</PaletteTab>
          <PaletteTab active={tab === 'mine'} onClick={() => setTab('mine')}>From your other projects</PaletteTab>
        </div>
        <span className="ml-auto min-w-0 truncate text-xs text-muted-foreground">
          {tab === 'builtin' ? 'Starting points that ship with cezar' : 'Registered in ~/.cezar/config.json'}
        </span>
      </div>
      {tab === 'mine' && others.isPending ? (
        <p className="pt-4 text-[13px] text-muted-foreground">Loading…</p>
      ) : tab === 'mine' && others.isError ? (
        <p role="alert" className="pt-4 text-[13px] text-danger">{others.error.message}</p>
      ) : items.length === 0 ? (
        <p className="pt-4 text-[13px] text-muted-foreground">No automations in your other projects yet.</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-1 pt-3">
          {items.map((item) => (
            <div
              key={item.key}
              data-slot="template-card"
              className="flex flex-col gap-1 rounded-lg px-3 py-2.5 hover:bg-muted/60"
            >
              <div className="flex items-center gap-2 text-[13.5px] font-medium">
                {item.kind === 'github'
                  ? <GithubIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                  : <Clock3Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />}
                <span className="min-w-0 truncate">{item.name}</span>
                {item.project ? <BranchChip className="ml-auto">{item.project}</BranchChip> : null}
              </div>
              <div className="text-xs text-muted-foreground">{item.when}</div>
              <div className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">{item.prompt}</div>
              <Button
                variant="outline"
                size="sm"
                className="mt-1 self-start"
                aria-label={`Use this: ${item.name}`}
                onClick={() => onPick(item)}
              >
                Use this
              </Button>
            </div>
          ))}
        </div>
      )}
    </section>
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
        'flex h-7 items-center rounded-sm px-3 text-[12.5px] font-medium',
        active
          ? 'bg-card font-semibold text-foreground shadow-xs'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}
