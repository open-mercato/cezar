import {
  createProjectTerminal,
  createRunTerminal,
  getProjectTerminal,
  getProjectTerminalCommands,
  getRunTerminal,
  getRunTerminalCommands,
  readProjectTerminal,
  readRunTerminal,
  resizeProjectTerminal,
  resizeRunTerminal,
  stopProjectTerminal,
  stopRunTerminal,
  writeProjectTerminal,
  writeRunTerminal,
} from '@/api/client'
import type {
  DiscoveredCommandsResponse,
  TerminalCreateInput,
  TerminalSession,
  TerminalState,
} from '@open-mercato/cezar-api-client'

import type { TerminalIo } from './terminal-pane'

/**
 * Whose shells a terminal drawer shows: a task's (in its worktree) or the project's own (in its
 * root, #1526). The drawer, its panes and its command picker speak only this, so both owners get
 * the same tabs, close warning and Run menu over their own routes.
 */
export interface TerminalScope {
  /** Identity — the drawer reattaches when it changes. */
  key: string
  /** Detected addresses are a task's (they open in its Preview); only a task scope carries a run id. */
  runId: string | null
  state(): Promise<TerminalState>
  create(body: TerminalCreateInput): Promise<TerminalSession>
  stop(sessionId: string): Promise<void>
  write(sessionId: string, data: string): Promise<void>
  io(sessionId: string): TerminalIo
  commands(): Promise<DiscoveredCommandsResponse>
}

export function taskTerminalScope(runId: string): TerminalScope {
  return {
    key: `run:${runId}`,
    runId,
    state: () => getRunTerminal(runId),
    create: (body) => createRunTerminal(runId, body),
    stop: (sessionId) => stopRunTerminal(runId, sessionId),
    write: (sessionId, data) => writeRunTerminal(runId, sessionId, data),
    io: (sessionId) => ({
      read: (cursor) => readRunTerminal(runId, sessionId, cursor),
      write: (data) => writeRunTerminal(runId, sessionId, data),
      resize: (cols, rows) => resizeRunTerminal(runId, sessionId, cols, rows),
    }),
    commands: () => getRunTerminalCommands(runId),
  }
}

/** The active project's own terminal. `projectId` is identity only — the calls go to the scope
 *  the cockpit is in, which is the project the page was opened under. */
export function projectTerminalScope(projectId: string): TerminalScope {
  return {
    key: `project:${projectId}`,
    runId: null,
    state: () => getProjectTerminal(),
    create: (body) => createProjectTerminal(body),
    stop: (sessionId) => stopProjectTerminal(sessionId),
    write: (sessionId, data) => writeProjectTerminal(sessionId, data),
    io: (sessionId) => ({
      read: (cursor) => readProjectTerminal(sessionId, cursor),
      write: (data) => writeProjectTerminal(sessionId, data),
      resize: (cols, rows) => resizeProjectTerminal(sessionId, cols, rows),
    }),
    commands: () => getProjectTerminalCommands(),
  }
}
