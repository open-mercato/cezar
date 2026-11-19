import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { telemetryEventInputSchema } from '@open-mercato/cezar-api-client'

import {
  managerNotificationKind,
  noteManagerChatSource,
  noteManagerEntry,
  observeManagerMode,
  resetManagerTelemetryForTests,
  trackManagerChatOpened,
  trackManagerMessageSent,
  trackManagerNotificationClicked,
  trackManagerQuestionAnswered,
  useManagerChatOpened,
} from './manager-telemetry'
import { isPhone } from './phone-app'
import { sendTelemetryEvent } from './telemetry'

vi.mock('./telemetry', () => ({ sendTelemetryEvent: vi.fn() }))
vi.mock('./phone-app', () => ({ isPhone: vi.fn(() => false) }))

const sent = () => vi.mocked(sendTelemetryEvent).mock.calls.map(([body]) => body)

describe('manager telemetry', () => {
  beforeEach(() => {
    resetManagerTelemetryForTests()
    vi.mocked(sendTelemetryEvent).mockClear()
    vi.mocked(isPhone).mockReturnValue(false)
  })
  afterEach(() => vi.useRealTimers())

  it('counts entering Manager mode once, by the surface that led there', () => {
    observeManagerMode(false)
    noteManagerEntry('sidebar')
    observeManagerMode(true)
    observeManagerMode(true)
    observeManagerMode(false)
    noteManagerEntry('bottom_bar')
    observeManagerMode(true)
    observeManagerMode(false)
    observeManagerMode(true)
    expect(sent()).toEqual([
      { event: 'manager_mode_opened', label: 'sidebar' },
      { event: 'manager_mode_opened', label: 'bottom_bar' },
      { event: 'manager_mode_opened', label: 'other' },
    ])
  })

  it('a page load that starts in Manager is a deep link, a phone landing is phone_default', () => {
    observeManagerMode(true)
    resetManagerTelemetryForTests()
    noteManagerEntry('phone_default')
    observeManagerMode(false)
    observeManagerMode(true)
    expect(sent().map((body) => body.label)).toEqual(['deep_link', 'phone_default'])
  })

  it('a stale note does not label a later entry', () => {
    observeManagerMode(false)
    noteManagerEntry('palette')
    observeManagerMode(true, Date.now() + 60_000)
    expect(sent()).toEqual([{ event: 'manager_mode_opened', label: 'other' }])
  })

  it('opens a chat once however often it re-renders or remounts', () => {
    noteManagerChatSource('sidebar')
    const { rerender, unmount } = renderHook(({ id }) => useManagerChatOpened(id), { initialProps: { id: 'a' } })
    rerender({ id: 'a' })
    rerender({ id: 'a' })
    unmount()
    const again = renderHook(({ id }) => useManagerChatOpened(id), { initialProps: { id: 'a' } })
    expect(sent()).toEqual([{ event: 'manager_chat_opened', label: 'sidebar' }])
    noteManagerChatSource('list')
    again.rerender({ id: 'b' })
    expect(sent().at(-1)).toEqual({ event: 'manager_chat_opened', label: 'list' })
  })

  it('opening the same chat again later is a new open; unknown origins are other', () => {
    const now = Date.now()
    trackManagerChatOpened('a', now)
    trackManagerChatOpened('a', now + 3_000)
    expect(sent().map((body) => body.label)).toEqual(['other', 'other'])
  })

  it('auto never overrides a source a click already noted', () => {
    noteManagerChatSource('task_card')
    noteManagerChatSource('auto', { ifUnset: true })
    trackManagerChatOpened('a')
    noteManagerChatSource('auto', { ifUnset: true })
    trackManagerChatOpened('b')
    expect(sent().map((body) => body.label)).toEqual(['task_card', 'auto'])
  })

  it('labels a sent message by via, attachments and device', () => {
    trackManagerMessageSent('composer', false)
    trackManagerMessageSent('chip', false)
    vi.mocked(isPhone).mockReturnValue(true)
    trackManagerMessageSent('composer', true)
    trackManagerMessageSent('question_card', false)
    trackManagerQuestionAnswered('card')
    expect(sent()).toEqual([
      { event: 'manager_message_sent', label: 'composer:no:desktop' },
      { event: 'manager_message_sent', label: 'chip:no:desktop' },
      { event: 'manager_message_sent', label: 'composer:yes:phone' },
      { event: 'manager_message_sent', label: 'question_card:no:phone' },
      { event: 'manager_question_answered', label: 'card' },
    ])
  })

  it('a notification click is counted by kind and labels the mode and chat it opens', () => {
    expect(managerNotificationKind({ pendingActions: 1, pendingQuestions: 1 })).toBe('approval')
    expect(managerNotificationKind({ pendingActions: 0, pendingQuestions: 2 })).toBe('question')
    expect(managerNotificationKind({ pendingActions: 0, pendingQuestions: 0 })).toBe('important')
    observeManagerMode(false)
    trackManagerNotificationClicked('question')
    observeManagerMode(true)
    trackManagerChatOpened('a')
    expect(sent()).toEqual([
      { event: 'manager_notification_clicked', label: 'question' },
      { event: 'manager_mode_opened', label: 'notification' },
      { event: 'manager_chat_opened', label: 'notification' },
    ])
  })

  it('everything it sends is a body the server relay accepts, so no free text can ride along', () => {
    observeManagerMode(true)
    noteManagerChatSource('list')
    trackManagerChatOpened('Acme secret manager')
    trackManagerMessageSent('chip', true)
    trackManagerQuestionAnswered('typed')
    trackManagerNotificationClicked('important')
    expect(sent()).toHaveLength(5)
    for (const body of sent()) {
      expect(telemetryEventInputSchema.safeParse(body).success).toBe(true)
      expect(JSON.stringify(body)).not.toMatch(/acme|secret/i)
    }
  })
})
