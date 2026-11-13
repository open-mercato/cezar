// A dependency-free placements fixture (spec 2026-11-07-extension-placements): one contribution per
// cockpit surface — a sidebar panel, a palette command, a task panel and a task command — so the
// extensions e2e can drive all three surfaces without building an SDK example first. Plain ESM
// with no imports: the worker loads `main` directly, so nothing has to be installed or compiled.
export default {
  activate(context) {
    const subscriptions = [
      context.commands.register('hello', async () => ({ message: 'Hello from the placements fixture' })),
      context.commands.register('summarize', async (input) => ({ message: `Summarized task ${input?.runId ?? 'none'}` })),
      context.panels.register('side', () => ({
        id: 'side', title: 'Fixture sidebar',
        blocks: [{ type: 'text', text: 'Sidebar panel body from the fixture' }],
        actions: [{ id: 'hello', label: 'Say hello from the sidebar' }],
      })),
      context.panels.register('task-notes', async (panelContext) => {
        const task = panelContext?.runId ? await context.tasks.get(panelContext.runId) : null
        return {
          id: 'task-notes', title: 'Fixture task notes',
          blocks: [{ type: 'status', label: 'Task', value: task ? task.title : 'no task context' }],
          actions: [],
        }
      }),
    ]
    return { async dispose() { for (const subscription of subscriptions) await subscription.dispose() } }
  },
}
