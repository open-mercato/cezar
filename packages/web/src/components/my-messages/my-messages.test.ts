import { describe, expect, it } from 'vitest'

import { countAttachments, mergeMyMessages, myMessageDay, myMessagePreview, myMessageTargets, type MyMessage, type MyMessagePlace } from './my-messages'

const item = (id: string, order: number, extra: Partial<MyMessage> = {}): MyMessage => ({ id, order, text: id, images: 0, files: 0, ...extra })
const viewport = { top: 100, bottom: 600 }
const at = (places: Record<string, MyMessagePlace>) => (message: MyMessage) => places[message.id]!

describe('myMessageTargets', () => {
  const items = [item('a', 1), item('b', 2), item('c', 3), item('d', 4)]

  it('▲ is the nearest message above the top, ▼ the nearest below, and every one on screen is marked', () => {
    const targets = myMessageTargets(items, at({
      a: { top: -300, bottom: -250 },
      b: { top: 60, bottom: 160 },
      c: { top: 300, bottom: 360 },
      d: { top: 900, bottom: 960 },
    }), viewport)
    expect(targets.prev?.id).toBe('b')
    expect(targets.next?.id).toBe('c')
    expect(targets.onScreen).toEqual(['b', 'c'])
  })

  it('a message parked in the jump band counts on neither side, so ▲ walks on', () => {
    const targets = myMessageTargets(items, at({
      a: { top: -300, bottom: -250 },
      b: { top: 124, bottom: 200 },
      c: { top: 300, bottom: 360 },
      d: { top: 900, bottom: 960 },
    }), viewport)
    expect(targets.prev?.id).toBe('a')
    expect(targets.next?.id).toBe('c')
  })

  it('an unloaded older range is above everything, a message off-window below is below', () => {
    const targets = myMessageTargets(items, at({ a: 'above', b: 'above', c: { top: 124, bottom: 180 }, d: 'below' }), viewport)
    expect(targets.prev?.id).toBe('b')
    expect(targets.next?.id).toBe('d')
    expect(targets.onScreen).toEqual(['c'])
  })

  it('has no ▲ above the first message and no ▼ below the last', () => {
    const targets = myMessageTargets(items, at({
      a: { top: 124, bottom: 180 },
      b: { top: 300, bottom: 360 },
      c: { top: 400, bottom: 460 },
      d: { top: 500, bottom: 560 },
    }), viewport)
    expect(targets.prev).toBeUndefined()
    const last = myMessageTargets(items, at({ a: 'above', b: 'above', c: 'above', d: { top: 124, bottom: 140 } }), viewport)
    expect(last.next).toBeUndefined()
    expect(last.prev?.id).toBe('c')
  })

  it('has nothing to offer with no messages', () => {
    expect(myMessageTargets([], () => 'above', viewport)).toEqual({ onScreen: [] })
  })
})

describe('mergeMyMessages', () => {
  it('keeps the index, lets the loaded copy win, and orders by transcript order', () => {
    const merged = mergeMyMessages(
      [item('task', 0, { text: 'cut' }), item('turn-seq-9:user', 9)],
      [item('turn-seq-30:user', 30), item('task', 0, { text: 'full text' }), item('queued:x', 0.5, { pending: 'queued' })],
    )
    expect(merged.map((message) => message.id)).toEqual(['task', 'queued:x', 'turn-seq-9:user', 'turn-seq-30:user'])
    expect(merged[0]!.text).toBe('full text')
  })
})

describe('myMessagePreview', () => {
  it('folds lines and drops markdown marks', () => {
    expect(myMessagePreview('Two things:\n\n1. a **401** must not retry\n- log `one` line\n> quoted')).toBe('Two things: · 1. a 401 must not retry · log one line · quoted')
  })

  it('keeps link text, drops code blocks and empties to an empty string', () => {
    expect(myMessagePreview('See [the PR](https://x/1)\n```ts\nconst a = 1\n```')).toBe('See the PR')
    expect(myMessagePreview('  \n \n')).toBe('')
  })
})

describe('countAttachments', () => {
  it('splits images from files by name', () => {
    const isImage = (name: string) => /\.(png|jpe?g)$/i.test(name)
    expect(countAttachments(['/a/shot.png?x=1', '/a/notes.md', '/a/b.JPG'], isImage)).toEqual({ images: 2, files: 1 })
  })
})

describe('myMessageDay', () => {
  const now = new Date(2026, 10, 17, 12)
  it('names today and yesterday, else a short date', () => {
    expect(myMessageDay(new Date(2026, 10, 17, 9).toISOString(), now)).toBe('Today')
    expect(myMessageDay(new Date(2026, 10, 16, 23).toISOString(), now)).toBe('Yesterday')
    expect(myMessageDay(new Date(2026, 10, 3).toISOString(), now)).not.toMatch(/Today|Yesterday|Earlier/)
    expect(myMessageDay(undefined, now)).toBe('Earlier')
  })
})
