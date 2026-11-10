import { afterEach, describe, expect, it } from 'vitest'

import { confirmsReviewPublish, opensReviewPublish } from './review-publish-shortcut'

afterEach(() => {
  document.body.innerHTML = ''
})

const press = (extra: Partial<KeyboardEvent> = {}) =>
  ({
    key: 'Enter',
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    target: document.body,
    ...extra,
  }) as KeyboardEvent

function mount(html: string): HTMLElement {
  document.body.innerHTML = html
  return document.body.firstElementChild as HTMLElement
}

describe('the review gate publish shortcut (#1760)', () => {
  it('⌘↵ and Ctrl+↵ open it when nothing is focused', () => {
    expect(opensReviewPublish(press())).toBe(true)
    expect(opensReviewPublish(press({ metaKey: false, ctrlKey: true }))).toBe(true)
  })

  it('fires from a focused button — the gate’s own controls are not text', () => {
    expect(opensReviewPublish(press({ target: mount('<button>Accept</button>') }))).toBe(true)
  })

  it('never fires from a text field: the review notes, the composer, an input, contenteditable', () => {
    expect(opensReviewPublish(press({ target: mount('<textarea data-slot="review-notes"></textarea>') }))).toBe(false)
    expect(opensReviewPublish(press({ target: mount('<input />') }))).toBe(false)
    const editor = mount('<div contenteditable="true"><span>typed</span></div>')
    expect(opensReviewPublish(press({ target: editor.firstElementChild }))).toBe(false)
  })

  it('never fires from the terminal (its keyboard is xterm’s textarea)', () => {
    const term = mount('<div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div>')
    expect(opensReviewPublish(press({ target: term.firstElementChild }))).toBe(false)
  })

  it('never fires while a dialog, palette or menu owns the keyboard', () => {
    for (const role of ['dialog', 'alertdialog', 'menu']) {
      mount(`<div role="${role}"><button>x</button></div>`)
      expect(opensReviewPublish(press())).toBe(false)
    }
  })

  it('plain Enter, held-key repeats and other chords do nothing', () => {
    expect(opensReviewPublish(press({ metaKey: false }))).toBe(false)
    expect(opensReviewPublish(press({ repeat: true }))).toBe(false)
    expect(opensReviewPublish(press({ shiftKey: true }))).toBe(false)
    expect(opensReviewPublish(press({ altKey: true }))).toBe(false)
    expect(opensReviewPublish(press({ key: 'p' }))).toBe(false)
  })

  it('the second ⌘↵ confirms; Enter alone or a repeat does not', () => {
    expect(confirmsReviewPublish(press())).toBe(true)
    expect(confirmsReviewPublish(press({ metaKey: false, ctrlKey: true }))).toBe(true)
    expect(confirmsReviewPublish(press({ metaKey: false }))).toBe(false)
    expect(confirmsReviewPublish(press({ repeat: true }))).toBe(false)
  })
})
