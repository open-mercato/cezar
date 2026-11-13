import { TerminalDrawer } from '@/routes/task-workspace/terminal-drawer'

/**
 * The project terminal: shells in the project's root, owned by the project rather than a task.
 * It is the task drawer with no `runId`, filling the page — same tabs, shell picker and
 * close-while-busy warning, and the same cursor-over-HTTP transport.
 */
export function TerminalRoute() {
  return (
    <div data-slot="project-terminal" className="flex h-full min-h-0 flex-col">
      <TerminalDrawer fill height={0} onHeightChange={() => {}} />
    </div>
  )
}
