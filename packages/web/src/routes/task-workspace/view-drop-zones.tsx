import { useState } from 'react'

import { cn } from '@/lib/utils'

import { VIEW_DRAG_TYPE } from './layout-cards'
import { isViewId, MAX_COLUMNS, viewLabel, type ViewId, type WorkspaceColumn } from './layout-state'

type Zone = { key: string; at: number; mode: 'insert' | 'replace'; label: string; hint?: string }

/**
 * The targets a dragged view tab can land on, laid over the workspace while the drag lasts: the
 * left and right edge of each column put the view beside it, the middle replaces it. A full
 * layout offers only the middle; an empty one, the whole stage.
 */
export function ViewDropZones({
  view,
  columns,
  onDrop,
}: {
  view: ViewId
  columns: readonly WorkspaceColumn[]
  onDrop: (view: ViewId, at: number, mode: 'insert' | 'replace') => void
}) {
  const [hot, setHot] = useState<string | null>(null)
  const full = columns.length >= MAX_COLUMNS
  const cells =
    columns.length === 0
      ? [{ width: 100, zones: [{ key: 'only', at: 0, mode: 'insert', label: `Open ${viewLabel(view)} here` } satisfies Zone] }]
      : columns.map((column, index) => {
          const replace: Zone = {
            key: `replace:${index}`,
            at: index,
            mode: 'replace',
            label: column.view === view ? viewLabel(view) : `Replace ${viewLabel(column.view)}`,
            hint: full ? `${MAX_COLUMNS} columns is the limit` : undefined,
          }
          const zones: Zone[] = full
            ? [replace]
            : [
                { key: `insert:${index}`, at: index, mode: 'insert', label: 'Beside', hint: 'left' },
                replace,
                { key: `insert:${index + 1}:${index}`, at: index + 1, mode: 'insert', label: 'Beside', hint: 'right' },
              ]
          return { width: column.width, zones }
        })

  return (
    <div
      data-slot="view-drop-zones"
      className="absolute inset-0 z-30 flex gap-px bg-background/40 backdrop-blur-[1px]"
    >
      {cells.map((cell, index) => (
        <div
          key={index}
          style={{ flexBasis: `${cell.width}%` }}
          className={cn('grid min-w-0 grow gap-1.5 p-2.5', cell.zones.length === 3 ? 'grid-cols-[26%_1fr_26%]' : 'grid-cols-1')}
        >
          {cell.zones.map((zone) => (
            <div
              key={zone.key}
              data-drop-zone={zone.mode}
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes(VIEW_DRAG_TYPE)) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                setHot(zone.key)
              }}
              onDragLeave={() => setHot((current) => (current === zone.key ? null : current))}
              onDrop={(event) => {
                const dropped = event.dataTransfer.getData(VIEW_DRAG_TYPE)
                if (!isViewId(dropped)) return
                event.preventDefault()
                onDrop(dropped, zone.at, zone.mode)
              }}
              className={cn(
                'flex flex-col items-center justify-center rounded-lg border-[1.5px] border-dashed border-border bg-background/80 p-2 text-center text-xs font-medium text-muted-foreground transition-colors',
                hot === zone.key && 'border-foreground/60 bg-muted text-foreground',
              )}
            >
              {zone.label}
              {zone.hint ? <span className="text-[11px] font-normal opacity-80">{zone.hint}</span> : null}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
