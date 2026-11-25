import {
  attentionOverridesResponseSchema,
  attentionResponseSchema,
  phonePushPrefsSchema,
  type AttentionCounts,
  type AttentionItem,
  type AttentionOverride,
  type AttentionOverrideInput,
  type AttentionResponse,
  type PhonePushPrefs,
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

/** Dismiss, snooze or keep an item (spec 2026-11-23-needs-you-triage). */
export async function setAttentionOverride(input: AttentionOverrideInput): Promise<AttentionOverride[]> {
  const path = '/workspace/attention/overrides'
  return checked(attentionOverridesResponseSchema, path, await unwrap(await cez.api.v1.workspace.attention.overrides.$post({ json: input }), path)).overrides
}

/** Undo, or "Still needs me" on a dismissed item. */
export async function clearAttentionOverride(key: string): Promise<AttentionOverride[]> {
  const path = '/workspace/attention/overrides/clear'
  return checked(attentionOverridesResponseSchema, path, await unwrap(await cez.api.v1.workspace.attention.overrides.clear.$post({ json: { key } }), path)).overrides
}

/** The click shows at once: the item leaves the list (or its Probably done mark) before the server answers. */
/** The server's counts (`attention/list.ts` `countAttention`): settled items are in none. */
export function countAttentionItems(items: readonly AttentionItem[]): AttentionCounts {
  const counts: AttentionCounts = { total: 0, question: 0, approval: 0, task: 0, review: 0, failed: 0, message: 0 }
  for (const item of items) {
    if (item.settled) continue
    counts[item.kind] += 1
    if (item.counted) counts.total += 1
  }
  return counts
}

/** The click shows at once, the tab badge included: the item leaves the list (or its Probably done
 *  mark) before the server answers. An undone dismissal comes back with the refetch. */
export function applyOverrideLocally(
  queryClient: QueryClient,
  override: { key: string; mode: 'dismiss' | 'keep' | 'clear'; projectId?: string; runId?: string },
): void {
  queryClient.setQueryData<AttentionResponse>(attentionKeys.all, (data) => {
    if (!data) return data
    const rest = data.overrides.filter((entry) => entry.key !== override.key)
    if (override.mode === 'clear') return { ...data, overrides: rest }
    const entry: AttentionOverride = {
      key: override.key,
      mode: override.mode,
      at: new Date().toISOString(),
      ...(override.mode === 'dismiss' && override.projectId && override.runId ? { projectId: override.projectId, runId: override.runId } : {}),
    }
    const items = override.mode === 'dismiss'
      ? data.items.filter((item) => item.key !== override.key)
      // `counted` already says whether it counts once live (a muted manager's stays false).
      : data.items.map((item) => {
        if (item.key !== override.key || !item.settled) return item
        const { settled: _settled, ...kept } = item
        return kept
      })
    return { ...data, items, counts: countAttentionItems(items), overrides: [...rest, entry] }
  })
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

/** The calling phone's own prefs: answers only inside its relay session. */
export async function getMyPushPrefs(signal?: AbortSignal): Promise<PhonePushPrefs> {
  const path = '/workspace/phone/push/prefs'
  return checked(phonePushPrefsSchema, path, await unwrap(await cez.api.v1.workspace.phone.push.prefs.$get({}, signal ? { init: { signal } } : undefined), path))
}

export async function setMyPushPrefs(prefs: PhonePushPrefs): Promise<PhonePushPrefs> {
  const path = '/workspace/phone/push/prefs'
  return checked(phonePushPrefsSchema, path, await unwrap(await cez.api.v1.workspace.phone.push.prefs.$put({ json: prefs }), path))
}

/** From the computer: a paired phone's settings. What its app understands stays the phone's to say. */
export async function setPhoneSettings(deviceId: string, { understands: _understands, ...settings }: PhonePushPrefs): Promise<PhonePushPrefs> {
  const path = '/workspace/phones/:deviceId/prefs'
  return checked(phonePushPrefsSchema, path, await unwrap(await cez.api.v1.workspace.phones[':deviceId'].prefs.$put({ param: { deviceId }, json: settings }), path))
}
