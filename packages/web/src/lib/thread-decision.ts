import type { ThreadDecision } from '@open-mercato/cezar-api-client'

/** Asked only after the engine refused work. Reading status never opens a dialog or a model. */
export function askThreadDecision(expectedCount: number): Promise<ThreadDecision | null> {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog')
    dialog.className = 'max-w-lg rounded-lg border border-border bg-card p-5 text-foreground shadow-xl backdrop:bg-foreground/50'
    dialog.setAttribute('aria-labelledby', 'thread-hygiene-title')
    dialog.dataset.slot = 'thread-hygiene-decision'
    const title = document.createElement('h2')
    title.id = 'thread-hygiene-title'
    title.className = 'text-lg font-semibold'
    title.textContent = 'This thread has already continued three times'
    const text = document.createElement('p')
    text.className = 'my-3 text-sm'
    text.textContent = 'Choose one more work continuation or prepare a forward-looking handoff with links to useful previous outputs. Neither choice renews budgets or approvals. Preparing a handoff runs the agent; it does not create a successor.'
    dialog.append(title, text)
    const finish = (action: ThreadDecision['action'] | null) => {
      dialog.close()
      dialog.remove()
      resolve(action ? { action, expectedCount } : null)
    }
    for (const [label, action] of [['Continue work', 'continue'], ['Prepare handoff', 'handoff'], ['Cancel', null]] as const) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'm-1 min-h-11 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted'
      button.textContent = label
      button.onclick = () => finish(action)
      dialog.append(button)
    }
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null) })
    document.body.append(dialog)
    dialog.showModal()
  })
}
