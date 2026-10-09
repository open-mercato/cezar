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
import { GripHorizontal } from 'lucide-react'
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
      className={`group/module relative min-w-0 ${wide ? '@3xl:col-span-2' : ''} ${isDragging ? 'z-20 opacity-80' : ''}`}
      style={{
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
      }}
    >
      {/* The handle straddles the module's top edge instead of owning a row of its own. The
          button keeps its 44px target; only the pill inside it is visible. */}
      <Button
        ref={setActivatorNodeRef}
        variant="ghost"
        className="absolute -top-[22px] left-1/2 z-10 h-11 min-w-11 -translate-x-1/2 cursor-grab touch-none p-0 opacity-0 transition-opacity hover:bg-transparent focus-visible:opacity-100 active:cursor-grabbing group-hover/module:opacity-100 no-hover:opacity-100"
        {...attributes}
        {...listeners}
        aria-label={`Move ${names[id]}`}
      >
        <span className="flex h-4 w-8 items-center justify-center rounded-full border bg-card text-soft-foreground shadow-xs">
          <GripHorizontal className="size-3.5" aria-hidden="true" />
        </span>
      </Button>
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
        {/* Container, not viewport, breakpoints: the sidebar takes its share of the window. */}
        <div className="@container">
          <div className="grid items-start gap-6 @3xl:grid-cols-2">
            {visible.map((id) => (
              <Module key={id} id={id} wide={wide.has(id)}>
                {modules[id]}
              </Module>
            ))}
          </div>
        </div>
      </SortableContext>
    </DndContext>
  )
}
