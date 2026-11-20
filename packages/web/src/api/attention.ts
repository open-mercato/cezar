import {
  attentionResponseSchema,
  phoneNotificationsResponseSchema,
  type AttentionResponse,
  type PhoneNotificationPrefs,
} from '@open-mercato/cezar-api-client'
import { useQuery, type QueryClient } from '@tanstack/react-query'

import { ApiError, cez, unwrap } from './client'

/**
 * The attention list (spec `.ai/specs/2026-11-20-phone-notifications-inbox.md`, variant D): what
 * Now's Needs you shows and its tab badge counts. Kept fresh by the events that can change it.
 */

export const attentionKeys = {
  all: ['workspace', 'attention'] as const,
  phone: ['workspace', 'phone', 'notifications'] as const,
}

const checked = <T>(schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } }, path: string, body: unknown): T => {
  const result = schema.safeParse(body)
  if (!result.success) throw new ApiError(200, `the cezar server answered ${path} with an unexpected body`)
  return result.data
}

export async function getAttention(opts?: { signal?: AbortSignal }): Promise<AttentionResponse> {
  const path = '/workspace/attention'
  return checked(attentionResponseSchema, path, await unwrap(await cez.api.v1.workspace.attention.$get({}, opts?.signal ? { init: { signal: opts.signal } } : undefined), path))
}

export function useAttention(enabled = true) {
  return useQuery({ queryKey: attentionKeys.all, queryFn: ({ signal }) => getAttention({ signal }), enabled })
}

const SETTLE_MS = 600
let timer: ReturnType<typeof setTimeout> | undefined

/** A run, manager or question frame may have changed the list: one re-read per burst, and only when someone reads it. */
export function noteAttentionMaybeChanged(queryClient: QueryClient): void {
  if (queryClient.getQueryData(attentionKeys.all) === undefined || timer !== undefined) return
  timer = setTimeout(() => {
    timer = undefined
    void queryClient.invalidateQueries({ queryKey: attentionKeys.all })
  }, SETTLE_MS)
}

/** The calling phone's own settings: answers only inside its relay session. */
export async function getMyPhoneNotifications(signal?: AbortSignal): Promise<PhoneNotificationPrefs> {
  const path = '/workspace/phone/notifications'
  return checked(phoneNotificationsResponseSchema, path, await unwrap(await cez.api.v1.workspace.phone.notifications.$get({}, signal ? { init: { signal } } : undefined), path)).notifications
}

export async function setMyPhoneNotifications(notifications: PhoneNotificationPrefs): Promise<PhoneNotificationPrefs> {
  const path = '/workspace/phone/notifications'
  return checked(phoneNotificationsResponseSchema, path, await unwrap(await cez.api.v1.workspace.phone.notifications.$put({ json: notifications }), path)).notifications
}

/** From the computer: a paired phone's settings. */
export async function setPhoneNotifications(deviceId: string, notifications: PhoneNotificationPrefs): Promise<PhoneNotificationPrefs> {
  const path = '/workspace/phones/:deviceId/notifications'
  return checked(phoneNotificationsResponseSchema, path, await unwrap(await cez.api.v1.workspace.phones[':deviceId'].notifications.$put({ param: { deviceId }, json: notifications }), path)).notifications
}
