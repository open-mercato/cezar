import type { ReactNode } from 'react'
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
} from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable'
import { GripVertical } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { TileId } from './preferences'

const names: Record<TileId, string> = {
  overview: 'Workspace overview',
  portfolio: 'Projects',
  automations: 'Automations',
  fleet: 'Queue & scheduling',
  needsYou: 'Needs you',
  recent: 'Recent results & GitHub',
  usage: 'Usage & cost',
  trends: 'Trends',
}
function Module({ id, children, wide }: { id: TileId; children: ReactNode; wide: boolean }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, isDragging } =
    useSortable({ id })
  return (
    <section
      ref={setNodeRef}
      data-dashboard-module={id}
      className={`min-w-0 ${wide ? 'lg:col-span-2' : ''} ${isDragging ? 'relative z-20 opacity-80' : ''}`}
      style={{
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
      }}
    >
      <div className="flex justify-end">
        <Button
          ref={setActivatorNodeRef}
          variant="ghost"
          className="min-h-11 min-w-11 cursor-grab touch-none active:cursor-grabbing"
          {...attributes}
          {...listeners}
          aria-label={`Move ${names[id]}`}
        >
          <GripVertical className="size-4 text-muted-foreground" aria-hidden="true" />
        </Button>
      </div>
      {children}
    </section>
  )
}
export function DashboardLayout({
  order,
  modules,
  onOrder,
}: {
  order: TileId[]
  modules: Partial<Record<TileId, ReactNode>>
  onOrder: (order: TileId[]) => void
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const visible = order.filter((id) => modules[id])
  const wide = new Set<TileId>(['overview', 'portfolio', 'usage', 'trends'])
  // Pair consecutive compact modules in DOM order. A leftover card fills its row;
  // dense grid packing would make visual order disagree with keyboard/drag order.
  let unpaired: TileId | undefined
  for (const id of visible) {
    if (wide.has(id)) {
      if (unpaired) wide.add(unpaired)
      unpaired = undefined
    } else if (unpaired) unpaired = undefined
    else unpaired = id
  }
  if (unpaired) wide.add(unpaired)
  const describe = (id: string | number) =>
    `${names[id as TileId]}, position ${visible.indexOf(id as TileId) + 1} of ${visible.length}`
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      accessibility={{
        announcements: {
          onDragStart: ({ active }) => `Picked up ${describe(active.id)}.`,
          onDragOver: ({ active, over }) =>
            over
              ? `${names[active.id as TileId]} moved to position ${visible.indexOf(over.id as TileId) + 1} of ${visible.length}.`
              : undefined,
          onDragEnd: ({ active, over }) =>
            over
              ? `${names[active.id as TileId]} dropped at position ${visible.indexOf(over.id as TileId) + 1} of ${visible.length}.`
              : `Order unchanged. ${describe(active.id)}.`,
          onDragCancel: ({ active }) => `Reordering cancelled. ${describe(active.id)}.`,
        },
        screenReaderInstructions: {
          draggable:
            'Press Space to pick up a module, use arrow keys to move, Space to drop, or Escape to cancel.',
        },
      }}
      onDragEnd={({ active, over }) => {
        if (!over || active.id === over.id) return
        onOrder(
          arrayMove(
            order,
            order.indexOf(active.id as TileId),
            order.indexOf(over.id as TileId),
          ),
        )
      }}
    >
      <SortableContext items={visible} strategy={rectSortingStrategy}>
        <div className="grid items-start gap-x-5 gap-y-2 lg:grid-cols-2">
          {visible.map((id) => (
            <Module key={id} id={id} wide={wide.has(id)}>
              {modules[id]}
            </Module>
          ))}
        </div>
      </SortableContext>
    </DndContext>
  )
}
