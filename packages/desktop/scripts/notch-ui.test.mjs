import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { COLORS, COMPANION_COLOR, PERSONAS, avatarParts } from '../ui/notch/faces.js'
import { computeShapes, tucked } from '../ui/notch/shapes.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const read = (relative) => readFileSync(path.resolve(here, relative), 'utf8')
const layout = JSON.parse(read('../ui/notch/layout.json'))
const centre = layout.window.width / 2
const notched = { width: 200, height: 37, top: 0, centre }
const floating = { width: 0, height: 32, top: 31, centre }
const compact = { expanded: false, rows: 1, textWidth: 100, minis: 0, overflow: 0 }
const inside = (rect) =>
  rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= layout.window.width && rect.y + rect.height <= layout.window.height

describe('faces', () => {
  const avatar = read('../../web/src/routes/manager/manager-avatar.tsx')

  it('draws the same characters as the cockpit', () => {
    const shapes = [...avatar.matchAll(/shape: '([^']+)'/g)].map((match) => match[1])
    expect(PERSONAS.map((persona) => persona.shape)).toEqual(shapes)
    const eyes = [...avatar.matchAll(/eyes: \[([\d.]+), ([\d.]+)\]/g)].map((match) => [Number(match[1]), Number(match[2])])
    expect(PERSONAS.map((persona) => persona.eyes)).toEqual(eyes)
    expect(avatar).toContain(PERSONAS[3].companion)
    expect([...avatar.matchAll(/^ {2}'(oklch[^']+)',$/gm)].map((match) => match[1])).toEqual(COLORS)
    expect(avatar).toContain(`COMPANION_COLOR = '${COMPANION_COLOR}'`)
  })

  it('picks a character the way the cockpit does', () => {
    expect(avatarParts(0).fill).toBe(COLORS[0])
    // Past nine, a character changes colour.
    expect(avatarParts(9).shape).toBe(PERSONAS[0].shape)
    expect(avatarParts(9).fill).toBe(COLORS[1])
    expect(avatarParts(63).shape).toBe(PERSONAS[0].shape)
  })

  it('moves no face under Reduce Motion', () => {
    const css = read('../ui/notch/notch.css')
    expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]*\.face \*[\s\S]*animation: none !important/)
  })
})

describe('shapes', () => {
  it('keeps the camera centred however wide the text is', () => {
    for (const textWidth of [10, 100, 900]) {
      const { island } = computeShapes(layout, notched, { ...compact, textWidth })
      const cameraLeft = island.x + layout.pill1.leftWing
      expect(cameraLeft + notched.width / 2).toBe(centre)
    }
  })

  it('centres a floating capsule on itself', () => {
    const { island } = computeShapes(layout, floating, compact)
    expect(island.x + island.width / 2).toBe(centre)
    expect(island.y).toBe(floating.top)
  })

  it('has no pill 2 for one manager and sizes it by what it holds', () => {
    expect(computeShapes(layout, notched, compact).pill2).toBeNull()
    const four = computeShapes(layout, notched, { ...compact, minis: 4 }).pill2
    const counted = computeShapes(layout, notched, { ...compact, minis: 4, overflow: 3 }).pill2
    expect(counted.width).toBe(four.width + layout.pill2.countWidth + layout.pill2.miniGap)
  })

  it('caps the open list at its row limit', () => {
    const six = computeShapes(layout, notched, { ...compact, expanded: true, rows: layout.expanded.maxRows }).island
    const many = computeShapes(layout, notched, { ...compact, expanded: true, rows: 40 }).island
    expect(many.height).toBe(six.height)
  })

  it('stays inside the panel in the largest state, notched or floating', () => {
    const widest = { ...compact, textWidth: 900, minis: 4, overflow: 9 }
    for (const housing of [notched, { width: 260, height: 54, top: 0, centre }, floating]) {
      const { island, pill2 } = computeShapes(layout, housing, widest)
      expect(inside(island)).toBe(true)
      expect(inside(pill2)).toBe(true)
      expect(inside(computeShapes(layout, housing, { ...widest, expanded: true, rows: 40 }).island)).toBe(true)
    }
  })

  it('follows the shell off the panel\'s middle on a narrow screen', () => {
    const { island } = computeShapes(layout, { ...floating, centre: 200 }, compact)
    expect(island.x + island.width / 2).toBe(200)
  })

  it('tucks behind the camera', () => {
    expect(tucked(layout, notched)).toEqual({ x: centre - 100, y: 0, width: 200, height: 37 })
  })
})

describe('the page', () => {
  it('never parses manager text as markup', () => {
    expect(read('../ui/notch/notch.js')).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/)
    expect(read('../ui/notch/index.html')).toContain("script-src 'self'")
  })

  it('has no approve control', () => {
    expect(read('../ui/notch/notch.js')).not.toMatch(/decision|\/actions\//)
  })

  it('talks to the shell and to nothing else', () => {
    expect(read('../ui/notch/notch.js')).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket|EventSource|https?:\/\/(?!www\.w3\.org)/)
  })
})

describe('the panel', () => {
  it('stays when the app is hidden', () => {
    expect(read('../src-tauri/src/notch.rs')).toContain('panel.setCanHide(false)')
  })

  it('reloads every crashed webview, because its hook replaces the default for all of them', () => {
    const hook = read('../src-tauri/src/notch.rs').match(/pub fn on_page_crashed[\s\S]*?webview\.reload\(\)/)[0]
    expect(hook).not.toContain('return')
  })
})

describe('the capability', () => {
  it('stays on macOS and off the network', () => {
    const capability = JSON.parse(read('../src-tauri/capabilities/notch.json'))
    expect(capability.windows).toEqual(['notch'])
    expect(capability.platforms).toEqual(['macOS'])
    expect(capability.remote).toBeUndefined()
  })
})
