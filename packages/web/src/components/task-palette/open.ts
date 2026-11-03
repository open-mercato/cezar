/** The programmatic-open seam for ⌘P, like `openCommandPalette` for ⌘K: a window event, so ⌘K
 *  can hand a task over without the two palettes sharing state. */
export const OPEN_TASK_PALETTE_EVENT = 'cezar:open-task-palette'

export interface TaskPaletteSubject {
  runId: string
  /** The task's project, as the palette task row carries it; null for the project on screen. */
  projectId: string | null
}

export function openTaskPalette(subject?: TaskPaletteSubject): void {
  window.dispatchEvent(new CustomEvent<TaskPaletteSubject | undefined>(OPEN_TASK_PALETTE_EVENT, { detail: subject }))
}
