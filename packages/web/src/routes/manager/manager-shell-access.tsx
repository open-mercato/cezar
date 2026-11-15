import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { toast } from '@/components/ui/toaster'
import type { ManagerSummary, UpdateManagerInput } from '@open-mercato/cezar-api-client'

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The shell commands the manager was refused, and the read-only `gh` patterns the user allowed
 *  from them; each change applies from the next turn. */
export function ShellAccessDialog({
  manager,
  open,
  onOpenChange,
  onUpdate,
  onCloseAutoFocus,
}: {
  manager: ManagerSummary
  open: boolean
  onOpenChange: (open: boolean) => void
  onUpdate: (patch: UpdateManagerInput) => Promise<unknown>
  onCloseAutoFocus?: (event: Event) => void
}) {
  const [busy, setBusy] = useState(false)
  const allowed = manager.bashAllow ?? []
  const denials = manager.bashDenials ?? []
  const apply = (patch: UpdateManagerInput) => {
    setBusy(true)
    void onUpdate(patch).catch((error: unknown) => toast(errorMessage(error), { tone: 'danger' })).finally(() => setBusy(false))
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid max-h-[85dvh] grid-rows-[auto_minmax(0,1fr)] sm:max-w-xl" {...(onCloseAutoFocus ? { onCloseAutoFocus } : {})}>
        <DialogHeader>
          <DialogTitle>Shell access</DialogTitle>
          <DialogDescription>
            The manager runs cez-manager and read-only gh. Commands it was refused show here; a read-only gh one can be allowed.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
          <section className="flex flex-col gap-1.5" aria-label="Refused commands">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">Refused commands</h3>
              {denials.length > 0 ? (
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => apply({ clearBashDenials: true })}>Clear</Button>
              ) : null}
            </div>
            {denials.length === 0 ? <p className="text-sm text-muted-foreground">Nothing refused lately.</p> : null}
            {denials.map((denial) => (
              <div key={denial.command} className="flex flex-col gap-1 rounded-md border p-2" data-slot="bash-denial">
                <code className="text-meta break-all">{denial.command}</code>
                <p className="text-meta text-muted-foreground">
                  {denial.reason}{denial.count > 1 ? ` · ${denial.count} times` : ''}
                </p>
                {denial.suggestion ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="self-start"
                    disabled={busy}
                    onClick={() => apply({ bashAllow: [...allowed, denial.suggestion!] })}
                  >
                    Allow {denial.suggestion} (read-only)
                  </Button>
                ) : null}
              </div>
            ))}
          </section>
          <section className="flex flex-col gap-1.5" aria-label="Allowed patterns">
            <h3 className="text-sm font-medium">Allowed by you</h3>
            {allowed.length === 0 ? <p className="text-sm text-muted-foreground">Only the built-in read-only commands.</p> : null}
            {allowed.map((pattern) => (
              <div key={pattern} className="flex items-center justify-between gap-2">
                <code className="text-meta">{pattern}</code>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${pattern}`}
                  disabled={busy}
                  onClick={() => apply({ bashAllow: allowed.filter((other) => other !== pattern) })}
                >
                  Remove
                </Button>
              </div>
            ))}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}
