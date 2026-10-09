import {
  CopyIcon,
  EyeIcon,
  EllipsisIcon,
  PencilIcon,
  PlayIcon,
  ScrollTextIcon,
  TerminalIcon,
  Trash2Icon,
} from 'lucide-react'
import { useState, type SyntheticEvent } from 'react'
import type { AutomationListEntry } from '@open-mercato/cezar-api-client'

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
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useNavigate } from '@/lib/project-router'

import type { AutomationActions } from './use-automations'

/**
 * The actions cell of one list row (spec 2026-09-14-automations-redesign § UI/UX 1): one menu —
 * Run now · Preview matches · Edit · View log · Duplicate · Copy as CLI · Delete. Pause/Enable is
 * the row's switch. Every click in here stops at the cell — the row itself opens the editor. The
 * menu and the confirm are portaled, so they stop propagation on their own content too: React
 * bubbles synthetic events through portals to the row.
 */
export function RowActions({ automation, actions }: { automation: AutomationListEntry; actions: AutomationActions }) {
  const navigate = useNavigate()
  const [confirming, setConfirming] = useState(false)
  const stop = (event: SyntheticEvent) => event.stopPropagation()
  const editorPath = `/automations/${encodeURIComponent(automation.id)}`

  return (
    <span data-slot="row-actions" className="inline-flex gap-0.5" onClick={stop}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="More" title={`Actions for ${automation.name}`}>
            <EllipsisIcon aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[200px]" onClick={stop}>
          <DropdownMenuItem disabled={actions.busy} onSelect={() => void actions.runNow(automation)}>
            <PlayIcon />
            Run now
          </DropdownMenuItem>
          {automation.kind !== 'schedule' ? (
            <DropdownMenuItem disabled={actions.busy} onSelect={() => void actions.preview(automation)}>
              <EyeIcon />
              Preview matches
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
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
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
            <Trash2Icon />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent onClick={stop}>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{automation.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The automation is removed for good. Tasks it already launched and its execution log stay.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-danger text-danger-foreground hover:brightness-[0.96]"
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
