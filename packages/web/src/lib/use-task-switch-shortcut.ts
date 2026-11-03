import * as React from 'react'
import { useLocation } from 'react-router'

import { useHealth, useProjects, useRunsForProject } from '@/api/queries'
import { taskIdFromPath } from '@/components/task-palette/task-palette'

import { shortcutsBlocked } from './keybindings'
import { useActiveProjectId, useNavigate } from './project-router'
import { stepTaskRing, taskRing, type RingDirection } from './task-ring'
import { trackTaskSwitched } from './telemetry'

/** The ring an ⌥-arrow keydown walks, or null when it is not one. ⇧ picks the Needs-you ring. */
export function taskSwitchFromEvent(
  event: Pick<KeyboardEvent, 'key' | 'altKey' | 'shiftKey' | 'metaKey' | 'ctrlKey' | 'repeat'>,
): { direction: RingDirection; needsYouOnly: boolean } | null {
  if (!event.altKey || event.metaKey || event.ctrlKey || event.repeat) return null
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return null
  return { direction: event.key === 'ArrowUp' ? 'previous' : 'next', needsYouOnly: event.shiftKey }
}

/** The desktop shell's global ⌃⌥↑/⌃⌥↓ (packages/desktop, `register_task_switch_shortcuts`)
 *  lands here with `detail` `'previous'` | `'next'`: the Needs-you ring, from any app. */
export const SWITCH_TASK_EVENT = 'cezar:switch-task'

/**
 * ⌥↑/⌥↓ and ⌥⇧↑/⌥⇧↓ — previous/next task, and previous/next task that needs you — on every
 * page of the project on screen. Fires while typing too (Slack's ⌥↑/↓ does, and a text field's
 * paragraph jump is the only thing it displaces), but not in the terminal, where ⌥ sequences
 * are the shell's, and not under a dialog or menu.
 */
export function useTaskSwitchShortcut(): void {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const activeProjectId = useActiveProjectId()
  const projects = useProjects()
  const health = useHealth()
  const bootProjectId = projects.data?.bootProject ?? health.data?.bootProject ?? null
  const runs = useRunsForProject(activeProjectId, bootProjectId)
  const state = React.useRef({ pathname, runs: runs.data, navigate })
  state.current = { pathname, runs: runs.data, navigate }

  React.useEffect(() => {
    // False when there was nowhere to go — the caller decides what that means for its event.
    const step = (direction: RingDirection, needsYouOnly: boolean): boolean => {
      const now = state.current
      const target = stepTaskRing(taskRing(now.runs ?? [], needsYouOnly), taskIdFromPath(now.pathname), direction)
      if (target === null) return false
      trackTaskSwitched('arrow')
      now.navigate(`/tasks/${target}`)
      return true
    }
    const onKeyDown = (event: KeyboardEvent) => {
      const chord = taskSwitchFromEvent(event)
      if (!chord || event.defaultPrevented) return
      if (event.target instanceof HTMLElement && event.target.closest('.xterm')) return
      if (shortcutsBlocked()) return
      event.preventDefault()
      step(chord.direction, chord.needsYouOnly)
    }
    // From the shell the window was just raised: a dialog on screen is what the user came back
    // to, so it keeps the keyboard and the press does nothing, as for the in-window chord.
    const onSwitch = (event: Event) => {
      const direction = (event as CustomEvent<unknown>).detail
      if ((direction !== 'previous' && direction !== 'next') || shortcutsBlocked()) return
      step(direction, true)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener(SWITCH_TASK_EVENT, onSwitch)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener(SWITCH_TASK_EVENT, onSwitch)
    }
  }, [])
}

/** The hook as global chrome, mounted beside the palettes in `AppShellContainer`. */
export function TaskSwitchShortcut(): null {
  useTaskSwitchShortcut()
  return null
}
