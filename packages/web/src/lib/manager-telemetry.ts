import { useEffect } from 'react'

import {
  managerMessageLabel,
  type ManagerChatSource,
  type ManagerEntrySurface,
  type ManagerMessageVia,
  type ManagerNotificationKind,
  type ManagerSummary,
} from '@open-mercato/cezar-api-client'

import { isPhone } from '@/lib/phone-app'
import { sendTelemetryEvent } from '@/lib/telemetry'

/**
 * Manager mode's cockpit telemetry (docs/telemetry.md, PR #2038). Labels come only from the
 * contract's closed sets; nothing here takes a name, a text or a path. A click notes WHERE it
 * came from, and the arrival (mode entered, chat mounted) sends it, so a link that is not
 * instrumented still counts, as `other`.
 */

const NOTE_TTL_MS = 5_000
const CHAT_DEBOUNCE_MS = 2_000

let entry: { surface: ManagerEntrySurface; at: number } | undefined
let chatSource: { from: ManagerChatSource; at: number } | undefined
/** Module state, not a ref: the shell remounts (Settings is chromeless), the page load does not. */
let inManagerBefore: boolean | undefined
let lastChat: { id: string; at: number } | undefined

export function noteManagerEntry(surface: ManagerEntrySurface): void {
  entry = { surface, at: Date.now() }
}

/** `ifUnset` keeps a source a click already noted (`/manager` redirecting after the bottom bar). */
export function noteManagerChatSource(from: ManagerChatSource, opts: { ifUnset?: boolean } = {}): void {
  if (opts.ifUnset && chatSource && Date.now() - chatSource.at < NOTE_TTL_MS) return
  chatSource = { from, at: Date.now() }
}

function take<T extends { at: number }>(note: T | undefined, now: number): T | undefined {
  return note && now - note.at < NOTE_TTL_MS ? note : undefined
}

/** Sends `manager_mode_opened` when the cockpit crosses into Manager mode, never inside it. */
export function observeManagerMode(inManager: boolean, now = Date.now()): void {
  const before = inManagerBefore
  inManagerBefore = inManager
  if (!inManager || before === true) return
  const noted = take(entry, now)?.surface
  entry = undefined
  sendTelemetryEvent({ event: 'manager_mode_opened', label: noted ?? (before === undefined ? 'deep_link' : 'other') })
}

export function useManagerModeTelemetry(inManager: boolean): void {
  useEffect(() => observeManagerMode(inManager), [inManager])
}

/** Once per arrival: a re-render, a StrictMode remount or a refetch within 2 s is the same open. */
export function trackManagerChatOpened(id: string, now = Date.now()): void {
  if (lastChat?.id === id && now - lastChat.at < CHAT_DEBOUNCE_MS) return
  lastChat = { id, at: now }
  const from = take(chatSource, now)?.from ?? 'other'
  chatSource = undefined
  sendTelemetryEvent({ event: 'manager_chat_opened', label: from })
}

export function useManagerChatOpened(id: string): void {
  useEffect(() => trackManagerChatOpened(id), [id])
}

/** After the server accepted it, never before. */
export function trackManagerMessageSent(via: ManagerMessageVia, attachments: boolean): void {
  sendTelemetryEvent({ event: 'manager_message_sent', label: managerMessageLabel(via, attachments, isPhone() ? 'phone' : 'desktop') })
}

export function trackManagerQuestionAnswered(via: 'card' | 'typed'): void {
  sendTelemetryEvent({ event: 'manager_question_answered', label: via })
}

/** The same precedence the notification's own text uses (`describeManagerNotification`). */
export function managerNotificationKind(manager: Pick<ManagerSummary, 'pendingActions' | 'pendingQuestions'>): ManagerNotificationKind {
  return manager.pendingActions > 0 ? 'approval' : manager.pendingQuestions > 0 ? 'question' : 'important'
}

export function trackManagerNotificationClicked(kind: ManagerNotificationKind): void {
  sendTelemetryEvent({ event: 'manager_notification_clicked', label: kind })
  noteManagerEntry('notification')
  noteManagerChatSource('notification')
}

export function resetManagerTelemetryForTests(): void {
  entry = undefined
  chatSource = undefined
  inManagerBefore = undefined
  lastChat = undefined
}
