import { useRef, useState, type DragEvent } from 'react'

/**
 * Whether an accepted drag is over an element — counted by enter/leave, not by `relatedTarget`.
 * Crossing into a child fires `dragleave` on the parent, and Safari and Firefox report no
 * `relatedTarget`, so a plain "leave = off" handler flashed the highlight off and on at every
 * child edge (#1556). `reset` clears it on drop, which fires no `dragleave`.
 */
export function useDragHover(accepts: (event: DragEvent) => boolean) {
  const depth = useRef(0)
  const [over, setOver] = useState(false)
  const reset = () => {
    depth.current = 0
    setOver(false)
  }
  return {
    over,
    reset,
    handlers: {
      onDragEnter: (event: DragEvent) => {
        if (!accepts(event)) return
        depth.current += 1
        setOver(true)
      },
      onDragLeave: (event: DragEvent) => {
        if (!accepts(event)) return
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) setOver(false)
      },
    },
  }
}
