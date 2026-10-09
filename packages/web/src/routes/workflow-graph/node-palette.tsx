import { XIcon } from 'lucide-react'
import { useState } from 'react'

import type { WorkflowNodeCatalogResponse } from '@open-mercato/cezar-api-client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import type { GraphNodeType } from '@/lib/workflow-graph'

import { CATEGORY_ORDER, ICONS, TONE } from './graph-node'

export const DRAG_MIME = 'application/x-cezar-node'

interface PaletteSkill {
  name: string
  source: string
  description?: string | null
}

/**
 * The node palette: every node type and every skill in ONE searchable list (spec
 * 2026-09-30-workflow-node-editor). A row is added by a click or Enter, and a node type can also
 * be dragged onto the canvas. A skill is an agent node that applies it.
 *
 * Filtering is ours rather than cmdk's: the skills list is capped at 40 rows AFTER the search —
 * a repo can carry hundreds — which a filter that only hides rendered rows cannot do.
 */
export function NodePalette({
  nodes,
  skills,
  skillsLoading,
  attach,
  onClearAttach,
  onAdd,
}: {
  nodes: WorkflowNodeCatalogResponse['nodes']
  skills: readonly PaletteSkill[]
  skillsLoading: boolean
  /** Set by a port's `+`: the next pick is placed after this port and wired to it. */
  attach: { node: string; port: string } | null
  onClearAttach: () => void
  onAdd: (type: GraphNodeType, skill?: string) => void
}) {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const matches = (...texts: Array<string | null | undefined>) =>
    !needle || texts.some((text) => text?.toLowerCase().includes(needle))
  const shownSkills = skills.filter((skill) => matches(skill.name, skill.description)).slice(0, 40)

  return (
    <Command shouldFilter={false} className="h-full rounded-none bg-transparent">
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder="Search nodes and skills…"
        aria-label="Search nodes and skills"
        autoFocus
      />
      {attach ? (
        <div className="flex items-center gap-1.5 border-b border-border/70 px-3 py-2 text-xs text-muted-foreground">
          <span className="shrink-0">Wires to</span>
          <Badge variant="outline" className="min-w-0 gap-1 font-normal">
            <span className="truncate">{attach.node}</span>
            <span aria-hidden="true">→</span>
            <span style={{ color: TONE.success }}>{attach.port}</span>
          </Badge>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="ml-auto"
            aria-label="Add without wiring"
            title="Add without wiring"
            onClick={onClearAttach}
          >
            <XIcon />
          </Button>
        </div>
      ) : null}
      <CommandList className="max-h-none min-h-0 flex-1">
        <CommandEmpty>Nothing matches “{query.trim()}”.</CommandEmpty>
        {CATEGORY_ORDER.map((category) => {
          const entries = nodes.filter((entry) => entry.category === category.id && matches(entry.label, entry.description, entry.type))
          if (entries.length === 0) return null
          return (
            <CommandGroup key={category.id} heading={category.label}>
              {entries.map((entry) => {
                const Icon = ICONS[entry.type]
                return (
                  <CommandItem
                    key={entry.type}
                    value={`node:${entry.type}`}
                    data-node-type={entry.type}
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData(DRAG_MIME, entry.type)
                      event.dataTransfer.effectAllowed = 'move'
                    }}
                    onSelect={() => onAdd(entry.type)}
                    title={`${entry.description} — drag onto the canvas, or click to add`}
                    className="cursor-grab items-center gap-3 rounded-lg py-1.5 active:cursor-grabbing"
                  >
                    <span
                      className="flex size-8 shrink-0 items-center justify-center rounded-lg"
                      style={{ background: `color-mix(in oklab, ${category.color} 12%, transparent)` }}
                    >
                      <Icon className="size-4" style={{ color: category.color }} strokeWidth={1.75} />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[13px] leading-tight font-medium text-foreground">{entry.label}</span>
                      <span className="block truncate text-xs text-muted-foreground">{entry.description}</span>
                    </span>
                  </CommandItem>
                )
              })}
            </CommandGroup>
          )
        })}
        {skillsLoading ? (
          <CommandGroup heading="Skills">
            <p className="px-2 py-1.5 text-xs text-muted-foreground">Loading skills…</p>
          </CommandGroup>
        ) : shownSkills.length > 0 ? (
          <CommandGroup heading="Skills">
            {shownSkills.map((skill) => (
              <CommandItem
                key={`${skill.source}:${skill.name}`}
                value={`skill:${skill.source}:${skill.name}`}
                onSelect={() => onAdd('agent', skill.name)}
                title={skill.description ?? skill.name}
                className="items-center gap-3 rounded-lg py-1.5"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted font-mono text-xs text-muted-foreground">
                  /
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[13px] leading-tight text-foreground">{skill.name}</span>
                  {skill.description ? (
                    <span className="block truncate text-xs text-muted-foreground">{skill.description}</span>
                  ) : null}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
      </CommandList>
    </Command>
  )
}
