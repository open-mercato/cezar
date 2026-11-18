import { defineExtension, type ExtensionTaskSummary } from '@open-mercato/cezar-extension-sdk'

type Status = ExtensionTaskSummary['status']
const OPEN: readonly Status[] = ['queued', 'running', 'waiting', 'review']
/** `tasks.get` carries no timestamps, so the lifecycle is read off the status. */
const lifecycle = (status: Status): string =>
  status === 'queued' ? 'not started' : status === 'running' || status === 'waiting' ? 'started' : 'finished'

export default defineExtension({
  async activate(context) {
    let tasks: ExtensionTaskSummary[] = await context.tasks.list()
    const refresh = async () => { tasks = await context.tasks.list() }
    const count = (keep: (status: Status) => boolean) => String(tasks.filter(task => keep(task.status)).length)
    const subscriptions = [
      // Palette command. The Settings panel's action button runs the same declared command.
      context.commands.register('refresh', async () => {
        await refresh()
        return { message: 'Summary refreshed' }
      }),
      // Settings panel (V1 behaviour, unchanged).
      context.panels.register('summary', () => ({
        id: 'summary', title: 'Project summary',
        blocks: [{ type: 'table', columns: ['Task', 'Status'], rows: tasks.map(task => [task.title, task.status]).slice(0, 100) }],
        actions: [{ id: 'refresh', label: 'Refresh summary' }],
      })),
      // Sidebar panel: the compact counts.
      context.panels.register('counts', () => ({
        id: 'counts', title: 'Project summary',
        blocks: [
          { type: 'status', label: 'Open', value: count(status => OPEN.includes(status)) },
          { type: 'status', label: 'Running', value: count(status => status === 'running') },
          { type: 'status', label: 'Waiting', value: count(status => status === 'waiting') },
        ],
      })),
      // Task panel: `runId` is passed by the host only inside a task's Extensions view.
      context.panels.register('task', async taskContext => {
        const task = taskContext?.runId ? await context.tasks.get(taskContext.runId) : null
        if (!task) return { id: 'task', title: 'This task', blocks: [{ type: 'text', text: 'Open a task to see its summary here.' }] }
        return {
          id: 'task', title: 'This task',
          blocks: [
            { type: 'status', label: 'Title', value: task.title.slice(0, 200) },
            { type: 'status', label: 'Status', value: task.status },
            { type: 'status', label: 'Lifecycle', value: lifecycle(task.status) },
          ],
        }
      }),
      // Task command: proposes a follow-up for the task the user is looking at. The proposal is
      // offered in the normal new-task form; nothing launches here.
      context.commands.register('follow-up', async input => {
        const task = typeof input?.runId === 'string' ? await context.tasks.get(input.runId) : null
        if (!task) return { message: 'Run Propose follow-up from a task.' }
        await context.tasks.propose({
          title: `Follow-up: ${task.title}`.slice(0, 500),
          prompt: `Continue the work of task "${task.title}" (run ${task.id}, status ${task.status}): review its result and finish what it left open.`,
        })
        return { message: `Proposed a follow-up to "${task.title}"` }
      }),
      context.taskEvents.subscribe(refresh),
    ]
    return { async dispose() { for (const subscription of subscriptions) await subscription.dispose() } }
  },
})
