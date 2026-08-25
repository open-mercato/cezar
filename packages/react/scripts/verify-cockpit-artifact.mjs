import { JSDOM } from 'jsdom'

const dom = new JSDOM('', { url: 'https://cezar.example' })
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  localStorage: dom.window.localStorage,
})

const cockpit = await import(new URL('../dist/cockpit.js', import.meta.url).href)
const root = await import(new URL('../dist/index.js', import.meta.url).href)

if (typeof cockpit.CezarCockpit !== 'function') {
  throw new Error('dist/cockpit.js must export CezarCockpit as a function')
}

if (typeof root.CezarCockpit !== 'function') {
  throw new Error('dist/index.js must export CezarCockpit as a function')
}

console.log('verified CezarCockpit exports from dist/cockpit.js and dist/index.js')
