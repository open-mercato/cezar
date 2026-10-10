import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// The picker is the SERVER's (it is what the design proxy injects), but it is a browser script
// and this is the workspace with a DOM to run it in — a test-only reach across packages, by
// relative path on purpose (AGENTS.md § Repository layout names exactly this exception).
import { pickerScript } from '../../../../cezar/src/server/preview/picker-script.ts'

/**
 * The Design Mode picker, run for real in a framed document (spec
 * `.ai/specs/2026-10-09-design-mode.md` §7, stage 1): hovering frames an element in blue;
 * clicking it KEEPS the frame and turns it lime.
 */

const BLUE = 'rgb(79, 140, 255)'
const LIME = 'rgb(163, 230, 53)'

let frame: HTMLIFrameElement
let page: Window & typeof globalThis
/** The framed page's REAL parent. Under vitest the test's own `window` is a wrapper around it and
 *  is not identical to `page.parent` — and the picker, rightly, obeys only its actual parent. */
let host: Window
let HOST: string
let posted: Array<{ type: string; key?: string; element?: { mark?: string; selector?: string; html?: string } }>
const onMessage = (event: MessageEvent) => {
  if ((event.data as { source?: string } | null)?.source === 'cezar-design') posted.push(event.data)
}

/** Let `postMessage` deliver — it is asynchronous in every DOM, jsdom included. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

/** A message from the cockpit, as the browser would deliver it to the framed page. */
function tell(data: Record<string, unknown>) {
  page.dispatchEvent(
    new page.MessageEvent('message', { data: { source: 'cezar-design-host', ...data }, origin: HOST, source: host }),
  )
}

function mouse(type: string, target: Element) {
  target.dispatchEvent(new page.MouseEvent(type, { bubbles: true, cancelable: true }))
}

const hoverBox = () => page.document.querySelector<HTMLElement>('[data-cezar-design=box]')
const marks = () => [...page.document.querySelectorAll<HTMLElement>('[data-cezar-design=mark]')]
const shown = (node: HTMLElement | null) => node !== null && node.style.display !== 'none'

beforeEach(async () => {
  posted = []
  frame = document.createElement('iframe')
  document.body.appendChild(frame)
  page = frame.contentWindow as Window & typeof globalThis
  host = page.parent
  HOST = host.location.origin
  host.addEventListener('message', onMessage)
  page.document.body.innerHTML =
    '<main><h1 id="title">Blue mug</h1><button class="buy" onclick="window.clicked = true">Add to cart</button></main>'
  page.eval(pickerScript({ parentOrigin: HOST, upstreamOrigin: 'http://localhost:5173' }))
  tell({ type: 'set-active', active: true })
  await settle()
})

afterEach(async () => {
  // Let this case's own messages land before the next one starts listening for its own.
  await settle()
  tell({ type: 'set-marks', marks: [] }) // stops the picker's re-place timer
  host.removeEventListener('message', onMessage)
  frame.remove()
})

describe('selecting an element', () => {
  it('frames the hovered element in blue', () => {
    mouse('mousemove', page.document.querySelector('.buy')!)
    expect(shown(hoverBox())).toBe(true)
    expect(hoverBox()!.style.borderColor).toBe(BLUE)
    expect(marks()).toHaveLength(0)
  })

  it('keeps the frame on click and turns it lime — at once, before the cockpit answers', async () => {
    const button = page.document.querySelector('.buy')!
    mouse('mousemove', button)
    mouse('click', button)

    // Synchronously: the lime frame is there, and the blue hover frame is not drawn over it.
    expect(marks()).toHaveLength(1)
    expect(marks()[0]!.style.borderColor).toBe(LIME)
    expect(shown(marks()[0]!)).toBe(true)
    expect(shown(hoverBox())).toBe(false)
    // The click was the selection and nothing else: the app's own handler never ran.
    expect((page as unknown as { clicked?: boolean }).clicked).toBeUndefined()

    await settle()
    const picked = posted.find((message) => message.type === 'picked')!
    expect(picked.element?.selector).toBe('body > main > button.buy')
    expect(picked.element?.mark).toMatch(/^[a-z0-9]+-1$/)
    // What is reported is the element itself — the frame is not part of its markup.
    expect(picked.element?.html).not.toContain('data-cezar-design')
  })

  it('stays lime when the pointer leaves, and while another element is hovered', () => {
    const button = page.document.querySelector('.buy')!
    const title = page.document.querySelector('#title')!
    mouse('mousemove', button)
    mouse('click', button)
    mouse('mousemove', title)
    expect(marks()).toHaveLength(1)
    expect(shown(marks()[0]!)).toBe(true)
    // The other element gets the ordinary blue hover frame.
    expect(shown(hoverBox())).toBe(true)
    // Back over the selected one: lime only.
    mouse('mousemove', button)
    expect(shown(hoverBox())).toBe(false)
  })

  it('selects several elements, each with its own lime frame', () => {
    mouse('click', page.document.querySelector('.buy')!)
    mouse('click', page.document.querySelector('#title')!)
    expect(marks()).toHaveLength(2)
  })

  it('opens the element\'s note again on a second click — it is neither picked twice nor deselected', async () => {
    const button = page.document.querySelector('.buy')!
    mouse('click', button)
    await settle()
    const key = posted.find((message) => message.type === 'picked')!.element!.mark!
    mouse('click', button)
    expect(marks()).toHaveLength(1)
    await settle()
    expect(posted.filter((message) => message.type === 'picked')).toHaveLength(1)
    expect(posted.at(-1)).toMatchObject({ type: 'mark-clicked', key })
  })

  it('leaves Esc to the cockpit: it is reported, and the picker keeps selecting', async () => {
    const button = page.document.querySelector('.buy')!
    page.document.dispatchEvent(new page.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await settle()
    expect(posted.at(-1)).toMatchObject({ type: 'cancel' })
    mouse('click', button)
    expect(marks()).toHaveLength(1)
  })
})

describe('sent notes and drafts that outlive the page', () => {
  it('numbers the frame of a sent note and leaves a draft\'s frame plain', async () => {
    mouse('click', page.document.querySelector('.buy')!)
    mouse('click', page.document.querySelector('#title')!)
    await settle()
    const [first, second] = posted.filter((message) => message.type === 'picked').map((message) => message.element!.mark!)
    tell({ type: 'set-marks', marks: [{ key: first, n: 3 }, { key: second }] })
    const badges = marks().map((mark) => mark.textContent)
    expect(badges).toEqual(['3', ''])
    // Sent, then the number changes with a withdrawal ahead of it; a draft never grows one.
    tell({ type: 'set-marks', marks: [{ key: first, n: 2 }, { key: second }] })
    expect(marks().map((mark) => mark.textContent)).toEqual(['2', ''])
  })

  it('frames a draft\'s element again from its selector — in a document that never saw the click', () => {
    tell({ type: 'set-marks', marks: [{ key: 'old-7', selector: 'body > main > button.buy', path: page.location.pathname }] })
    expect(marks()).toHaveLength(1)
    // And it is that element: hovering it shows no blue frame, as for any selected element.
    mouse('mousemove', page.document.querySelector('.buy')!)
    expect(shown(hoverBox())).toBe(false)
  })

  it.each([
    ['names no element', 'body > main > a.gone', undefined],
    ['names more than one element', 'main > *', undefined],
    ['is not a selector at all', 'main >>> ???', undefined],
    ['belongs to another page', 'body > main > button.buy', '/some/other/page'],
  ])('does not guess when the selector %s', (_label, selector, path) => {
    tell({ type: 'set-marks', marks: [{ key: 'old-7', selector, path: path ?? page.location.pathname }] })
    expect(marks()).toHaveLength(0)
  })
})

describe('the cockpit is the authority on what is selected', () => {
  it('keeps a frame the cockpit lists and drops one it does not', async () => {
    mouse('click', page.document.querySelector('.buy')!)
    mouse('click', page.document.querySelector('#title')!)
    await settle()
    const [first] = posted.filter((message) => message.type === 'picked').map((message) => message.element!.mark!)
    tell({ type: 'set-marks', marks: [{ key: first, n: 1 }] })
    expect(marks()).toHaveLength(1)
    // Everything sent, or a pick the cockpit refused: no frame is left behind.
    tell({ type: 'set-marks', marks: [] })
    expect(marks()).toHaveLength(0)
  })

  it('keeps the frames when selecting is switched off', () => {
    mouse('click', page.document.querySelector('.buy')!)
    tell({ type: 'set-active', active: false })
    expect(marks()).toHaveLength(1)
    expect(shown(hoverBox())).toBe(false)
  })

  it('obeys only the cockpit: another origin cannot clear or draw frames', () => {
    mouse('click', page.document.querySelector('.buy')!)
    page.dispatchEvent(
      new page.MessageEvent('message', {
        data: { source: 'cezar-design-host', type: 'set-marks', marks: [] },
        origin: 'https://evil.example',
        source: host,
      }),
    )
    expect(marks()).toHaveLength(1)
  })
})
