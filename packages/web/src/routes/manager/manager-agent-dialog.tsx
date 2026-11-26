import { useRef } from 'react'

import type { ManagerSummary } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

import { AgentChainSection } from './manager-agent-chain'
import { type ManagerPatch } from './manager-pickers'
import { TaskRoutingSection } from './manager-task-routing'

export function ManagerAgentDialog({ manager, onPatch, onClose, onCloseAutoFocus, focusAccount = false }: {
  manager: ManagerSummary
  onPatch: (patch: ManagerPatch) => void
  onClose: () => void
  onCloseAutoFocus: (event: Event) => void
  focusAccount?: boolean
}) {
  const account = useRef<HTMLDivElement>(null)
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent
        data-slot="manager-agent-dialog"
        className="grid max-h-[85dvh] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-xl"
        onCloseAutoFocus={onCloseAutoFocus}
        onOpenAutoFocus={(event) => {
          if (!focusAccount) return
          event.preventDefault()
          // The primary row opens on its editor: its Account picker is what a failed check points at.
          account.current?.querySelector<HTMLButtonElement>('[data-slot="manager-account-picker"]')?.focus()
        }}
      >
        <DialogHeader className="text-left">
          <DialogTitle>Manager agent</DialogTitle>
          <DialogDescription>Choose who replies in this chat and which agents can start new tasks.</DialogDescription>
        </DialogHeader>
        <div className="-mx-1 flex min-h-0 flex-col gap-4 overflow-y-auto overscroll-contain px-1 py-1">
          <div ref={account}>
            <AgentChainSection manager={manager} onPatch={onPatch} {...(focusAccount ? { initialEditing: 0 } : {})} />
          </div>
          <TaskRoutingSection manager={manager} onPatch={onPatch} />
        </div>
        <DialogFooter className="items-center gap-3">
          <p className="text-xs text-muted-foreground sm:mr-auto">Changes are saved as you choose.</p>
          <Button className="max-sm:w-full pointer-coarse:h-11" onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
