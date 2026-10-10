import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Trash2Icon } from 'lucide-react'
import { useState } from 'react'

import { checkEnvNameIssue } from '@open-mercato/cezar-api-client'
import { queryScope } from '@open-mercato/cezar-api-client'
import { removeCheckEnv, saveCheckEnv } from '@/api/client'
import { queryKeys, useCheckEnvNames } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'

/** Project check credentials: names only. A stored value is never fetched, shown or copyable. */
export function CheckEnvSection() {
  const names = useCheckEnvNames()
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const nameIssue = name === '' ? null : checkEnvNameIssue(name)

  const refresh = (projectId: string) => queryClient.invalidateQueries({ queryKey: queryKeys.checkEnv.allFor(projectId) })
  const save = useMutation({
    mutationFn: async () => { const projectId = queryScope(); await saveCheckEnv(name, value); return { projectId, saved: name } },
    onSuccess: async ({ projectId, saved }) => {
      if (queryScope() === projectId) { setName(''); setValue(''); setError(null) }
      await refresh(projectId)
      toast(`${saved} saved`)
    },
    // Keep the value on failure: it is already in component state either way, and clearing it
    // makes a transient 409 cost the user a re-paste of a 100-character key.
    onError: (e: Error) => setError(e.message),
  })
  const remove = useMutation({
    mutationFn: async (target: string) => { const projectId = queryScope(); await removeCheckEnv(target); return { projectId, removed: target } },
    onSuccess: async ({ projectId, removed }) => { await refresh(projectId); toast(`${removed} removed`) },
    onError: (e: Error) => toast(e.message, { tone: 'danger' }),
  })

  const submit = () => {
    const issue = checkEnvNameIssue(name)
    if (issue) { setError(issue); return }
    setError(null)
    save.mutate()
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4 md:p-6" data-slot="check-env-settings">
      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">Check credentials</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          These values go to this project's check steps only (for example an e2e runner's model key) and never to agent sessions.
        </p>
        {names.isPending ? <p className="mt-4 text-sm text-muted-foreground">Loading…</p> : null}
        {names.isError ? <p role="alert" className="mt-4 text-sm text-danger">{names.error.message}</p> : null}
        {names.data && names.data.names.length === 0 ? <p className="mt-4 text-sm text-muted-foreground">No check credentials stored.</p> : null}
        {names.data && names.data.names.length > 0 ? (
          <ul className="mt-4 divide-y divide-border rounded-md border border-border" aria-label="Stored check credentials">
            {names.data.names.map((stored) => (
              <li key={stored} className="flex items-center justify-between gap-3 px-3 py-2">
                <code className="text-sm">{stored}</code>
                <Button variant="outline" aria-label={`Delete ${stored}`} disabled={remove.isPending} onClick={() => remove.mutate(stored)}>
                  <Trash2Icon className="size-3.5" /> Delete
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <form className="rounded-lg border border-border bg-card p-4" autoComplete="off" onSubmit={(event) => { event.preventDefault(); submit() }}>
        <h2 className="text-sm font-semibold">Add or replace a credential</h2>
        <label className="mt-3 block text-sm">Name
          <input aria-label="Name" value={name} onChange={(event) => { setName(event.target.value.toUpperCase()); setError(null) }}
            autoComplete="off" spellCheck={false} placeholder="ANTHROPIC_API_KEY" aria-invalid={nameIssue ? true : undefined}
            className="mt-1 block w-full rounded border border-border bg-background p-2 font-mono" />
        </label>
        {nameIssue ? <p className="mt-1 text-xs text-danger">{nameIssue}</p> : null}
        <label className="mt-3 block text-sm">Value
          <input aria-label="Value" type="password" autoComplete="off" required value={value} onChange={(event) => setValue(event.target.value)}
            className="mt-1 block w-full rounded border border-border bg-background p-2" />
        </label>
        {error && error !== nameIssue ? <p role="alert" className="mt-2 text-sm text-danger">{error}</p> : null}
        <div className="mt-3">
          <Button type="submit" disabled={save.isPending || name === '' || value === '' || !!nameIssue}>Save credential</Button>
        </div>
      </form>
    </div>
  )
}
