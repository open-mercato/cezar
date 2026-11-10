import { beforeEach, describe, expect, it } from 'vitest'

// A server-side browser script run in a DOM — the same test-only reach as `design-picker.test.ts`.
import { locationReporterScript } from '../../../../cezar/src/server/preview/location-reporter.ts'

/**
 * The Preview's location reporter, run for real in a page. Its own window on a real address, not an
 * `about:blank` iframe — jsdom cannot `replaceState` one — with a stand-in parent to report to.
 */

const COCKPIT = 'http://127.0.0.1:4321'

let page: Window & typeof globalThis
let posted: Array<{ message: { source: string; url: string; how: string }; origin: string }>

function boot() {
  page.eval(locationReporterScript(COCKPIT))
}

// jsdom ships no types and this workspace keeps none for it; the constructor is all that is used.
type JsdomCtor = new (html: string, options: { url: string; runScripts: string }) => { window: unknown }
const jsdomModule = 'jsdom'
const { JSDOM } = (await import(/* @vite-ignore */ jsdomModule)) as { JSDOM: JsdomCtor }

beforeEach(() => {
  posted = []
  page = new JSDOM('<p>orders</p>', { url: 'http://localhost:5173/orders#status=open', runScripts: 'outside-only' }).window as unknown as Window &
    typeof globalThis
  const parent = { postMessage: (message: never, origin: string) => posted.push({ message, origin }) }
  Object.defineProperty(page, 'parent', { value: parent, configurable: true })
  boot()
})

const reports = () => posted.map(({ message }) => [message.url, message.how])

describe('location reporter', () => {
  it('reports the address it starts on, to the cockpit origin only', () => {
    expect(posted).toEqual([
      { message: { source: 'cezar-preview', type: 'location', url: 'http://localhost:5173/orders#status=open', how: 'load' }, origin: COCKPIT },
    ])
  })

  it('reports replaceState, pushState and hash changes as they happen', async () => {
    page.history.replaceState(null, '', '#status=shipped')
    page.history.pushState(null, '', '/orders/42?tab=items')
    page.location.hash = '#notes'
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(reports()).toEqual([
      ['http://localhost:5173/orders#status=open', 'load'],
      ['http://localhost:5173/orders#status=shipped', 'replace'],
      ['http://localhost:5173/orders/42?tab=items', 'push'],
      ['http://localhost:5173/orders/42?tab=items#notes', 'push'],
    ])
  })

  it('stays quiet for a state-only push, and runs once per document', () => {
    page.history.pushState({ step: 1 }, '')
    boot()
    expect(posted).toHaveLength(1)
  })
})
