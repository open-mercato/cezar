import { useQueryClient } from '@tanstack/react-query'
import * as React from 'react'

import { putWorkspaceUiState } from '@/api/client'
import { useWorkspaceUiState, workspaceQueryKeys } from '@/api/queries'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'
import {
  normalizeNotifications,
  notificationSupport,
  type NotificationSupport,
} from '@/lib/notifications'

/**
 * Settings → Notifications (R6 Step 1.7, spec §"Cross-cutting").
 *
 * A GLOBAL section since the multi-project split (step 3.5): the browser doing the notifying
 * is one browser whichever project you are looking at, so the answer belongs to the user, not
 * to a repo. It persists in `~/.cezar/ui-state.json` via `PUT /api/workspace/ui-state`
 * (Migration 001 carried the pre-existing per-repo value up).
 *
 * One real knob: the browser-notification toggle, OFF by default. Two contracts it keeps:
 *
 *  - the preference persists via the same PUT-then-reconcile pattern as Appearance (1.3):
 *    flip locally for immediacy, PUT the full object, and on a failed write fall back to the
 *    server's truth rather than keep showing a choice the file never got. No localStorage
 *    mirror — nothing here affects first paint.
 *  - `Notification.requestPermission()` runs on ENABLE only, and only when the browser hasn't
 *    answered yet. A denial still persists the preference (it follows the user; permission is
 *    per-browser) — the section then says plainly that this browser is blocking delivery.
 */
export function NotificationsSection() {
  const queryClient = useQueryClient()
  const uiState = useWorkspaceUiState()

  const [enabled, setEnabled] = React.useState(false)
  const [permission, setPermission] = React.useState<NotificationSupport>(notificationSupport)

  // The server's word wins — including "no notifications key" meaning the off default, so
  // wiping ui-state.json honestly resets every browser that visits.
  const serverState = uiState.data
  React.useEffect(() => {
    if (serverState === undefined) return
    setEnabled(normalizeNotifications(serverState.notifications).enabled)
  }, [serverState])

  const save = React.useCallback(
    (next: boolean) => {
      setEnabled(next)
      putWorkspaceUiState({ notifications: { enabled: next } })
        .then((merged) => queryClient.setQueryData(workspaceQueryKeys.uiState, merged))
        .catch((error: unknown) => {
          toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
          void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.uiState })
        })
    },
    [queryClient],
  )

  const onToggle = React.useCallback(
    (next: boolean) => {
      if (!next) {
        save(false)
        return
      }
      // Permission is requested HERE and nowhere else (spec: "permission requested on enable
      // only") — and only when the browser has never been asked. `granted`/`denied` are final
      // answers Chrome would ignore a re-request for anyway.
      if (notificationSupport() !== 'default') {
        save(true)
        return
      }
      // Persist first, then ask: the preference is not conditional on the answer, and an
      // `await` before the write would let a closed permission prompt strand the toggle.
      save(true)
      Notification.requestPermission()
        .then((answer) => setPermission(answer))
        .catch(() => setPermission(notificationSupport()))
    },
    [save],
  )

  const unsupported = permission === 'unsupported'

  return (
    <div
      data-slot="notifications-section"
      className="mx-auto flex w-full max-w-2xl flex-col gap-7 p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-6 md:pb-6"
    >
      <section className="flex flex-col gap-2">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              <label htmlFor="notifications-enabled">Notify when an agent needs you</label>
            </h2>
            <p className="text-[13px] text-muted-foreground">
              A browser notification when a task starts waiting, asks for review, or fails —
              only while this tab is in the background. Off by default.
            </p>
          </div>
          <Switch
            id="notifications-enabled"
            data-slot="notifications-toggle"
            checked={enabled}
            disabled={unsupported}
            onCheckedChange={onToggle}
          />
        </div>

        {unsupported ? (
          <p data-slot="notifications-unsupported" className="text-[13px] text-muted-foreground">
            This browser does not support notifications, so the toggle is unavailable here.
          </p>
        ) : null}

        {!unsupported && enabled && permission === 'denied' ? (
          <p data-slot="notifications-denied" className="text-[13px] text-danger">
            This browser is blocking notifications for the cockpit. The preference is saved, but
            nothing will be delivered here until you allow notifications in the browser&apos;s
            site settings.
          </p>
        ) : null}
      </section>
    </div>
  )
}
