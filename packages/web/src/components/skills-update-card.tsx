import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2Icon, RefreshCwIcon } from 'lucide-react'
import { useRef, useState } from 'react'

import { ApiError, applySkillsUpdate, checkSkillsUpdate, createRun, getSkillsUpdate } from '@/api/client'
import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { toast } from '@/components/ui/toaster'
import { useNavigate } from '@/lib/project-router'
import { cn } from '@/lib/utils'
import { startedRunPath } from '@/routes/new-task-form'
import type { SkillsUpdateDropOutcome, SkillsUpdateState } from '@open-mercato/cezar-api-client'
import { trackMessageSent, trackSkillsUpdateApplyDropped } from '@/lib/telemetry'

type UpdateRequest =
  | { action: 'check'; seq: number }
  | { action: 'apply'; seq: number; previousUpdatedAt: string | null }

const SETTLE_POLL_MS = 2_000
const SETTLE_LIMIT_MS = 5 * 60_000

/**
 * Apply, and survive losing the request. An apply runs `npx` for up to minutes, so a dropped
 * connection (status 0) or a 409 against an apply already running says nothing about the update
 * itself: follow the server's `updating` state to its end instead (telemetry edd8c83e). The
 * original error stands only when the server shows no apply finished.
 */
export async function applySkillsUpdateSettled(
  projectId: string,
  previousUpdatedAt: string | null,
  deps: {
    apply?: typeof applySkillsUpdate
    read?: typeof getSkillsUpdate
    wait?: (ms: number) => Promise<void>
    now?: () => number
    onDropped?: (outcome: SkillsUpdateDropOutcome) => void
  } = {},
): Promise<SkillsUpdateState> {
  const {
    apply = applySkillsUpdate,
    read = getSkillsUpdate,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
    onDropped = trackSkillsUpdateApplyDropped,
  } = deps
  try {
    return await apply(projectId)
  } catch (error) {
    if (!(error instanceof ApiError) || (error.status !== 0 && error.status !== 409)) throw error
    // Only a lost request is counted; a 409 is ordinary contention, not a transport fault.
    const settle = (outcome: SkillsUpdateDropOutcome) => {
      if (error.status === 0) onDropped(outcome)
    }
    const deadline = now() + SETTLE_LIMIT_MS
    for (;;) {
      let state: SkillsUpdateState
      try {
        state = await read(projectId)
      } catch {
        settle('unreachable')
        throw error
      }
      if (state.status !== 'updating') {
        if (state.updatedAt && state.updatedAt !== previousUpdatedAt) {
          settle('recovered')
          return state
        }
        settle('not_applied')
        throw error
      }
      if (now() >= deadline) {
        settle('timed_out')
        throw error
      }
      await wait(SETTLE_POLL_MS)
    }
  }
}

function scopeLabel(scope: SkillsUpdateState['scopes'][number]['scope']) {
  return scope === 'project' ? 'Project installation' : 'Global installation'
}

/** Manual check and apply controls for Open Mercato skill installations. */
export function SkillsUpdateCard({
  projectId,
  state,
  loadError,
}: {
  projectId: string
  state?: SkillsUpdateState
  loadError: Error | null
}) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const latestAction = useRef(0)
  const [showUpgradeNotesPrompt, setShowUpgradeNotesPrompt] = useState(false)
  const startUpgradeNotes = useMutation({
    mutationFn: () =>
      createRun({
        task: 'Apply the upgrade notes after updating the installed Open Mercato skills.',
        steps: [
          {
            id: 'apply-upgrade-notes',
            name: 'Apply upgrade notes',
            skill: 'om-apply-upgrade-notes',
            prompt: '{{task}}',
          },
        ],
      }),
    onSuccess: (created) => {
      trackMessageSent('skills_import')
      setShowUpgradeNotesPrompt(false)
      void navigate(startedRunPath(created))
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  const accept = (result: SkillsUpdateState, request: UpdateRequest) => {
    // A forced check may finish after an apply. Only the newest user intent owns the cache.
    if (request.seq !== latestAction.current) return
    queryClient.setQueryData(workspaceQueryKeys.skillsUpdate(projectId), result)
    if (request.action === 'apply' && result.updatedAt && result.updatedAt !== request.previousUpdatedAt) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.skills })
      toast(result.status === 'error' ? 'Some skill updates failed.' : 'Open Mercato skills updated.')
      setShowUpgradeNotesPrompt(true)
    }
  }
  const reject = (error: Error, request: UpdateRequest) => {
    if (request.seq === latestAction.current) toast(error.message, { tone: 'danger' })
  }
  const checkMutation = useMutation({
    mutationFn: (request: Extract<UpdateRequest, { action: 'check' }>) =>
      checkSkillsUpdate(projectId).then((result) => ({ result, request })),
    onSuccess: ({ result, request }) => accept(result, request),
    onError: (error: Error, request) => reject(error, request),
  })
  const applyMutation = useMutation({
    mutationFn: (request: Extract<UpdateRequest, { action: 'apply' }>) =>
      applySkillsUpdateSettled(projectId, request.previousUpdatedAt).then((result) => ({ result, request })),
    onSuccess: ({ result, request }) => accept(result, request),
    onError: (error: Error, request) => reject(error, request),
  })
  const run = (action: 'check' | 'apply') => {
    const seq = ++latestAction.current
    if (action === 'apply') applyMutation.mutate({ action, seq, previousUpdatedAt: state?.updatedAt ?? null })
    else checkMutation.mutate({ action, seq })
  }

  const scopes = state?.scopes ?? []
  const trackedScopes = scopes.filter((scope) => scope.skills.length > 0)
  const tracked = trackedScopes.length > 0
  const retryable = state?.status === 'error'
  const canApply = tracked && (state?.available || retryable)
  const pending = applyMutation.isPending || state?.status === 'updating'
  const failed = scopes.filter((scope) => scope.status === 'error' || scope.status === 'unavailable')
  const succeeded = scopes.filter((scope) => scope.updatedAt && !failed.includes(scope))

  let message = 'Checking installed Open Mercato skills…'
  if (loadError) message = 'Update status is unavailable right now.'
  else if (state?.status === 'available') message = 'An update is available for your installed Open Mercato skills.'
  else if (state?.status === 'updating') message = 'Updating installed Open Mercato skills…'
  else if (state?.status === 'current' && !tracked) {
    message = state.needsUpgradeNotes ? 'Skill files were updated.' : 'No installed Open Mercato skills are tracked for updates.'
  }
  else if (state?.status === 'current') message = 'Installed Open Mercato skills are up to date.'
  else if (state?.status === 'unavailable') {
    message = state.scopes.find((scope) => scope.reason)?.reason ?? 'Automatic updates are unavailable.'
  } else if (state?.status === 'error') message = 'The update did not finish for every installation.'

  return (
    <>
      <section
        data-slot="skills-update-card"
        aria-live="polite"
        className="rounded-lg border border-border bg-muted/30 p-3"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-foreground">{message}</p>
            {state?.checkedAt ? (
              <p className="mt-1 text-xs text-soft-foreground">
                Last checked {new Date(state.checkedAt).toLocaleString()}.
              </p>
            ) : null}
            {trackedScopes.length > 0 ? (
              <ul className="mt-1 text-xs text-soft-foreground">
                {trackedScopes.map((scope) => (
                  <li key={scope.scope}>
                    {scopeLabel(scope.scope)} · {scope.skills.length} tracked
                  </li>
                ))}
              </ul>
            ) : null}
            {failed.length > 0 ? (
              <p className="mt-1 text-xs text-destructive">
                Failed: {failed.map((scope) => scopeLabel(scope.scope)).join(', ')}
                {succeeded.length
                  ? '; updated: ' + succeeded.map((scope) => scopeLabel(scope.scope)).join(', ')
                  : ''}
                .
              </p>
            ) : null}
          </div>
          {canApply ? (
            <Button data-action="skills-update-apply" size="sm" disabled={pending} onClick={() => run('apply')}>
              <RefreshCwIcon
                aria-hidden="true"
                className={cn('size-3.5', pending && 'motion-safe:animate-spin')}
              />
              {pending ? 'Updating…' : retryable ? 'Retry' : 'Update now'}
            </Button>
          ) : state?.status === 'current' ? (
            <Button
              data-action="skills-update-check"
              variant="outline"
              size="sm"
              disabled={checkMutation.isPending}
              onClick={() => run('check')}
            >
              Check again
            </Button>
          ) : state?.status === 'unavailable' || loadError ? (
            <Button
              data-action="skills-update-check"
              variant="outline"
              size="sm"
              disabled={checkMutation.isPending}
              onClick={() => run('check')}
            >
              Retry check
            </Button>
          ) : null}
        </div>
        {state?.status === 'unavailable' || loadError ? (
          <div className="mt-2 text-xs text-soft-foreground">
            Manual examples: <code>npx skills update -p</code> · <code>npx skills update -g</code>. These broad
            commands may update other tracked sources.
          </div>
        ) : null}
        {state?.needsUpgradeNotes ? (
          <div
            data-slot="skills-upgrade-notes"
            className="mt-3 flex gap-2 rounded-md border border-primary/30 bg-background p-2.5 text-xs text-foreground"
          >
            <CheckCircle2Icon
              aria-hidden="true"
              className="mt-0.5 size-3.5 shrink-0 text-primary"
            />
            <span>
              Skill files were updated. Run <code>/om-apply-upgrade-notes</code> in each configured repository to
              apply descriptor migrations while preserving local edits.
            </span>
          </div>
        ) : null}
      </section>
      <Dialog
        open={showUpgradeNotesPrompt}
        onOpenChange={(open) => (startUpgradeNotes.isPending ? undefined : setShowUpgradeNotesPrompt(open))}
      >
        <DialogContent data-slot="skills-upgrade-notes-dialog" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Apply the upgrade notes now?</DialogTitle>
            <DialogDescription>
              The skill files were updated successfully. Start a new session with{' '}
              <code>/om-apply-upgrade-notes</code> to sync repository descriptors while preserving local edits?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={startUpgradeNotes.isPending}
              onClick={() => setShowUpgradeNotesPrompt(false)}
            >
              No
            </Button>
            <Button
              type="button"
              disabled={startUpgradeNotes.isPending}
              onClick={() => startUpgradeNotes.mutate()}
            >
              {startUpgradeNotes.isPending ? 'Starting…' : 'Yes, start session'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
