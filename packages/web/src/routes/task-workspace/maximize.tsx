import { Minimize2Icon } from 'lucide-react'
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * Full view (the workspace's maximize): the active layout — one view or several columns side by
 * side — takes the whole content panel, over the contextual sidebar, the top bar, the layout
 * strip and the terminal, and gives it back on the same button or Escape.
 *
 * Published as context so a view with a strip of its own (the browser's tabs) can carry the
 * toggle where its other controls are, without knowing how the takeover is done.
 */
export interface WorkspaceMaximize {
  maximized: boolean
  toggle: () => void
}

export const WorkspaceMaximizeContext = createContext<WorkspaceMaximize | null>(null)

export function useWorkspaceMaximize(): WorkspaceMaximize | null {
  return useContext(WorkspaceMaximizeContext)
}

/**
 * Pins an element over the content panel's box while `maximized`.
 *
 * Pinned, not moved: an iframe that changes parent reloads, and a thread or a diff that remounts
 * loses its scroll position — losing your place to see more of it would defeat the point. The box
 * is re-measured whenever the panel resizes, and Escape leaves.
 */
export function usePanelCover<T extends HTMLElement>(maximized: boolean, onExit: () => void) {
  const ref = useRef<T>(null)
  const [box, setBox] = useState<{ top: number; left: number; width: number; height: number } | null>(null)

  useLayoutEffect(() => {
    if (!maximized) {
      setBox(null)
      return
    }
    const panel = ref.current?.closest<HTMLElement>('[data-slot="panel"]')
    if (!panel) return
    const measure = () => {
      const rect = panel.getBoundingClientRect()
      setBox({ top: rect.top, left: rect.left, width: rect.width, height: rect.height })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(panel)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [maximized])

  useEffect(() => {
    if (!maximized) return
    const onKey = (event: KeyboardEvent) => {
      // A dialog, menu or popover that is open owns Escape; this one is for the bare view.
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')) return
      onExit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [maximized, onExit])

  return { ref, covering: maximized && box !== null, style: maximized && box ? box : undefined }
}

/**
 * The way out of full view: a labelled button for the top-right corner of whatever bar the view
 * already has — a column's header, the task's bar. Renders nothing outside full view, so a bar
 * can carry it unconditionally.
 */
export function FullViewExit({ className }: { className?: string }) {
  const maximize = useWorkspaceMaximize()
  if (!maximize?.maximized) return null
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      data-action="exit-full-view"
      title="Exit full view (Esc)"
      onClick={maximize.toggle}
      className={cn('shrink-0 text-foreground', className)}
    >
      <Minimize2Icon aria-hidden="true" />
      Exit full view
    </Button>
  )
}
