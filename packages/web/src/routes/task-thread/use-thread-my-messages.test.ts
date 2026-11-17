import { describe, expect, it } from 'vitest'

import { mergeMyMessages } from '@/components/my-messages/my-messages'

import type { TranscriptSection } from './session-transcript'
import { indexedThreadMessages, loadedThreadMessages, userRowKey, userRowOrder } from './use-thread-my-messages'

describe('thread "your messages" mapping', () => {
  it('keys an indexed message by the row its user-message line opens', () => {
    expect(userRowKey(0)).toBe('task')
    expect(userRowKey(42)).toBe('turn-seq-42:user')
    expect(userRowOrder('turn-seq-42:user')).toBe(42)
    expect(userRowOrder('task')).toBe(0)
    expect(userRowOrder('turn-fallback-3:user')).toBeUndefined()
  })

  it('drops an empty opening task, keeps attachment-only messages', () => {
    const items = indexedThreadMessages([
      { seq: 0, text: '', images: 0, files: 0 },
      { seq: 7, text: '', images: 1, files: 0 },
    ])
    expect(items.map((item) => item.id)).toEqual(['turn-seq-7:user'])
  })

  it('reads loaded sections: the queued stack sits under the task, attachments split by name', () => {
    const sections: TranscriptSection[] = [
      { id: 'task', userMessageKey: 'task', userMessage: { text: 'Do it', images: ['/a/shot.png', '/a/notes.md'] }, entries: [] },
      { id: 'queued:q1', userMessageKey: 'queued:q1', userMessage: { text: 'Later' }, entries: [] },
      { id: 'turn-seq-12', userMessageKey: 'turn-seq-12:user', userMessage: { text: 'Old image', imageCount: 2 }, entries: [] },
      { id: 'turn-seq-30', userMessageKey: 'turn-seq-30:user', entries: [] },
    ]
    const items = loadedThreadMessages(sections)
    expect(items.map((item) => [item.id, item.images, item.files, item.pending])).toEqual([
      ['task', 1, 1, undefined],
      ['queued:q1', 0, 0, 'queued'],
      ['turn-seq-12:user', 2, 0, undefined],
    ])
    // The index covers what is not loaded; loaded rows replace their indexed copies.
    const merged = mergeMyMessages(indexedThreadMessages([{ seq: 0, text: 'Do', images: 0, files: 0 }, { seq: 5, text: 'older', images: 0, files: 0 }]), items)
    expect(merged.map((item) => item.id)).toEqual(['task', 'queued:q1', 'turn-seq-5:user', 'turn-seq-12:user'])
    expect(merged[0]!.text).toBe('Do it')
  })
})
