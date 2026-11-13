import {
  CopyIcon,
  EyeIcon,
  EllipsisIcon,
  ListXIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PowerIcon,
  ScrollTextIcon,
  TerminalIcon,
  Trash2Icon,
} from 'lucide-react'
import { useState, type SyntheticEvent } from 'react'
import type { AutomationListEntry, AutomationWork } from '@open-mercato/cezar-api-client'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button, buttonVariants } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { IconTooltip } from '@/components/ui/icon-tooltip'
import { useNavigate } from '@/lib/project-router'

import { hasPendingWork, PendingWorkDialog } from './pending-work-dialog'
import type { AutomationActions } from './use-automations'

/**
 * The actions cell of one list row (spec 2026-09-14-automations-redesign § UI/UX 1, column 9):
 * Run now · Pause|Enable · More (Edit · View log · Duplicate · Copy as CLI · Delete). Every
 * click in here stops at the cell — the row itself opens the editor, and a pause must never
 * also navigate. The menu and the confirm are portaled, so they stop propagation on their own
 * content too: React bubbles synthetic events through portals to the row.
 *
 * The icon buttons wear the one `Tooltip` instead of a native `title` (redesign 2026-11); the
 * `aria-label` stays their accessible name.
 */
export function RowActions({ automation, actions }: { automation: AutomationListEntry; actions: AutomationActions }) {
  const navigate = useNavigate()
  const [confirming, setConfirming] = useState(false)
  // #1980: a pause discloses the queued and running work it leaves behind before it lands.
  const [work, setWork] = useState<{ work: AutomationWork; pausing: boolean }>()
  const togglePause = async () => {
    if (!automation.enabled) return actions.toggleEnabled(automation)
    const pending = await actions.loadWork(automation)
    // A failed read (already toasted) never blocks the pause — pausing is the safe direction.
    if (pending && hasPendingWork(pending)) setWork({ work: pending, pausing: true })
    else await actions.toggleEnabled(automation)
  }
  const showPending = async () => {
    const pending = await actions.loadWork(automation)
    if (pending) setWork({ work: pending, pausing: false })
  }
  const confirmPending = async (cancelQueued: boolean) => {
    const pausing = work?.pausing ?? false
    setWork(undefined)
    if (pausing) await actions.toggleEnabled(automation)
    if (cancelQueued) await actions.cancelQueued(automation)
  }
  const stop = (event: SyntheticEvent) => event.stopPropagation()
  const editorPath = `/automations/${encodeURIComponent(automation.id)}`
  const pauseLabel = automation.enabled ? 'Pause' : 'Enable'

  return (
    <span data-slot="row-actions" className="inline-flex gap-0.5" onClick={stop}>
      {automation.kind !== 'schedule' ? (
        <IconTooltip label="Preview matches">
          <Button variant="ghost" size="icon-sm" aria-label="Preview matches" disabled={actions.busy} onClick={() => void actions.preview(automation)}>
            <EyeIcon className="size-[13px]" />
          </Button>
        </IconTooltip>
      ) : null}
      <IconTooltip label="Run now">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Run now"
          disabled={actions.busy}
          onClick={() => void actions.runNow(automation)}
        >
          <PlayIcon className="size-[13px]" />
        </Button>
      </IconTooltip>
      <IconTooltip label={pauseLabel}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={pauseLabel}
          disabled={actions.busy}
          onClick={() => void togglePause()}
        >
          {automation.enabled ? <PauseIcon className="size-[13px]" /> : <PowerIcon className="size-[13px]" />}
        </Button>
      </IconTooltip>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="More">
            <EllipsisIcon className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[200px]" onClick={stop}>
          <DropdownMenuItem onSelect={() => navigate(editorPath)}>
            <PencilIcon />
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => navigate(`${editorPath}/log`)}>
            <ScrollTextIcon />
            View log
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void actions.duplicate(automation)}>
            <CopyIcon />
            Duplicate
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void actions.copyCli(automation)}>
            <TerminalIcon />
            Copy as CLI
          </DropdownMenuItem>
          {!automation.enabled ? (
            <DropdownMenuItem onSelect={() => void showPending()}>
              <ListXIcon />
              Pending tasks…
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
            <Trash2Icon />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <PendingWorkDialog
        automation={automation}
        work={work?.work}
        pausing={work?.pausing ?? false}
        onOpenChange={(open) => { if (!open) setWork(undefined) }}
        onConfirm={(cancelQueued) => void confirmPending(cancelQueued)}
      />
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent onClick={stop}>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{automation.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The automation is deleted and cannot be undone. Tasks it already launched and its execution log stay.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-variant="destructive"
              className={buttonVariants({ variant: 'destructive' })}
              onClick={() => void actions.remove(automation)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </span>
  )
}
