// A renderer: the shell shapes the data (`notch_model.rs`) and owns the pointer (`notch.rs`).
// Everything text here is set with `textContent`, never as markup: it is agent output.

import { COMPANION_COLOR, avatarParts } from './faces.js'
import { computeShapes, tucked } from './shapes.js'

const SVG = 'http://www.w3.org/2000/svg'
const WORDS = { 'needs-you': 'Needs you', error: 'Failed', working: 'Working', idle: 'Idle' }
/** Longer than the spring: only then do the old rects stop catching the pointer. */
const SETTLE_MS = 420

const $ = (id) => document.getElementById(id)
const invoke = (command, args) => window.__TAURI_INTERNALS__?.invoke(command, args)

let layout = null
let housing = null
let model = null
let expanded = false
let gloss = 0
let settle = 0
let measure = null

function node(name, attributes, parent) {
  const element = document.createElementNS(SVG, name)
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value)
  parent?.appendChild(element)
  return element
}

function eyes(parent, x, y, scale) {
  const group = node('g', { class: 'eyes' }, parent)
  for (const cx of [x, x + 4.2 * scale]) {
    node('ellipse', { cx, cy: y, rx: 0.95 * scale, ry: 1.9 * scale, fill: 'white', transform: `rotate(-10 ${cx} ${y})` }, group)
  }
}

function cross(parent, x, y) {
  const group = node('g', { class: 'cross' }, parent)
  for (const cx of [x, x + 4.2]) {
    node('path', { d: `M${cx - 1.4} ${y - 1.4}l2.8 2.8m0 -2.8l-2.8 2.8` }, group)
  }
}

function buildFace(avatar, size) {
  const parts = avatarParts(avatar)
  const id = `gloss-${(gloss += 1)}`
  const svg = node('svg', { class: 'face', viewBox: '0 0 32 32', width: size, height: size, 'aria-hidden': 'true' })
  svg.dataset.avatar = String(avatar)
  const defs = node('defs', {}, svg)
  const gradient = node('radialGradient', { id, cx: '0.35', cy: '0.2', r: '0.9' }, defs)
  node('stop', { offset: '0', 'stop-color': 'white', 'stop-opacity': '0.32' }, gradient)
  node('stop', { offset: '1', 'stop-color': 'white', 'stop-opacity': '0' }, gradient)
  node('circle', { class: 'halo', cx: 16, cy: 16, r: 15 }, svg)
  const body = node('g', { class: 'body' }, svg)
  const skin = node('g', { class: 'skin' }, body)
  node('path', { d: parts.shape, fill: parts.fill }, skin)
  node('path', { d: parts.shape, fill: `url(#${id})` }, skin)
  eyes(body, parts.eyes[0], parts.eyes[1], 1)
  cross(body, parts.eyes[0], parts.eyes[1])
  if (parts.companion) {
    node('path', { d: parts.companion, fill: COMPANION_COLOR, stroke: 'black', 'stroke-width': 1 }, skin)
    node('path', { d: parts.companion, fill: `url(#${id})` }, skin)
    eyes(body, 21, 21, 0.75)
  }
  return svg
}

/** Keeps a live svg when only its state changed: rebuilding restarts the animation. */
function syncFace(slot, avatar, face, size) {
  let svg = slot.firstElementChild
  if (!svg || svg.dataset.avatar !== String(avatar) || Number(svg.getAttribute('width')) !== size) {
    svg = buildFace(avatar, size)
    slot.replaceChildren(svg)
  }
  svg.dataset.face = face
}

function setText(element, text) {
  if (element.textContent !== text) element.textContent = text
}

function syncRow(row, entry) {
  row.dataset.face = entry.face
  syncFace(row.querySelector('.row-face'), entry.avatar, entry.face, layout.expanded.face)
  setText(row.querySelector('.row-name'), entry.name)
  setText(row.querySelector('.row-text'), entry.text)
  setText(row.querySelector('.row-tail'), entry.badge ?? WORDS[entry.face])
  row.querySelector('.row-tail').className = `row-tail ${entry.badge ? 'row-badge' : 'row-word'}`
}

function buildRow(entry) {
  const row = document.createElement('button')
  row.type = 'button'
  row.className = 'row'
  row.dataset.id = entry.id
  row.setAttribute('role', 'listitem')
  const face = document.createElement('span')
  face.className = 'row-face'
  const main = document.createElement('span')
  main.className = 'row-main'
  const name = document.createElement('div')
  name.className = 'row-name'
  const text = document.createElement('div')
  text.className = 'row-text'
  main.append(name, text)
  const tail = document.createElement('span')
  tail.className = 'row-tail'
  row.append(face, main, tail)
  return row
}

function syncRows() {
  const box = $('rows')
  const existing = new Map([...box.children].map((row) => [row.dataset.id, row]))
  const rows = model.active.map((entry) => {
    const row = existing.get(entry.id) ?? buildRow(entry)
    syncRow(row, entry)
    return row
  })
  rows.forEach((row, index) => {
    if (box.children[index] !== row) box.insertBefore(row, box.children[index] ?? null)
  })
  while (box.children.length > rows.length) box.lastElementChild.remove()
}

function syncMinis() {
  const box = $('minis')
  const existing = new Map([...box.children].map((mini) => [mini.dataset.id, mini]))
  const minis = model.minis.map((entry) => {
    let mini = existing.get(entry.id)
    if (!mini) {
      mini = document.createElement('button')
      mini.type = 'button'
      mini.className = 'mini'
      mini.dataset.id = entry.id
    }
    mini.title = entry.name
    syncFace(mini, entry.avatar, entry.face, layout.pill2.mini)
    return mini
  })
  box.replaceChildren(...minis)
  const count = $('overflow')
  count.hidden = model.overflow === 0
  setText(count, `+${model.overflow}`)
}

function textWidth(text) {
  measure ??= document.createElement('canvas').getContext('2d')
  measure.font = getComputedStyle(document.body).font
  return Math.ceil(measure.measureText(text).width)
}

function box(element, rect) {
  element.style.left = `${rect.x}px`
  element.style.top = `${rect.y}px`
  element.style.width = `${rect.width}px`
  element.style.height = `${rect.height}px`
}

function applyLayout() {
  const root = document.documentElement.style
  const floating = housing.width === 0
  document.body.toggleAttribute('data-floating', floating)
  root.setProperty('--left-wing', `${layout.pill1.leftWing}px`)
  root.setProperty('--housing', `${housing.width}px`)
  root.setProperty('--text-padding', `${layout.pill1.textPadding}px`)
  root.setProperty('--ear', `${layout.corner.ear}px`)
  root.setProperty('--row-height', `${layout.expanded.rowHeight}px`)
  root.setProperty('--row-face', `${layout.expanded.face}px`)
  root.setProperty('--padding-bottom', `${layout.expanded.paddingBottom}px`)
  root.setProperty('--mini', `${layout.pill2.mini}px`)
  root.setProperty('--mini-gap', `${layout.pill2.miniGap}px`)
  root.setProperty('--count-width', `${layout.pill2.countWidth}px`)
}

function report(rects) {
  invoke('notch_report_shape', { rects })
}

function draw() {
  applyLayout()
  const island = $('island')
  const pill2 = $('pill2')
  const root = document.documentElement.style
  const wasOut = island.dataset.state === 'tucked'
  syncRows()
  syncMinis()
  syncFace($('primary-face'), model.primary.avatar, model.primary.face, Math.min(layout.pill1.face, housing.height - 8))
  setText($('primary-text'), model.primary.text)
  const count = model.active.length
  setText($('sheet-title'), housing.width > 0 ? `${count} active` : '')

  const shapes = computeShapes(layout, housing, {
    expanded,
    rows: count,
    textWidth: textWidth(model.primary.text),
    minis: model.minis.length,
    overflow: model.overflow,
  })
  root.setProperty('--text-width', `${shapes.island.width - layout.pill1.leftWing - housing.width}px`)
  root.setProperty('--header', `${shapes.header}px`)
  const floating = housing.width === 0
  const corner = expanded ? layout.corner.expanded : floating ? shapes.island.height / 2 : layout.corner.notched
  root.setProperty('--corner', `${corner}px`)

  if (wasOut) {
    box(island, tucked(layout, housing))
    void island.offsetWidth
  }
  box(island, shapes.island)
  island.dataset.state = expanded ? 'expanded' : 'compact'
  if (shapes.pill2) {
    pill2.hidden = false
    pill2.removeAttribute('data-gone')
    box(pill2, shapes.pill2)
  } else {
    pill2.toggleAttribute('data-gone', true)
    if (model.minis.length === 0) pill2.hidden = true
  }

  // Growing: the new rects count at once. Shrinking: the old ones stay until the spring ends.
  const rects = [shapes.island, ...(shapes.pill2 ? [shapes.pill2] : [])]
  clearTimeout(settle)
  if (expanded || wasOut) report(rects)
  else settle = setTimeout(() => report(rects), SETTLE_MS)
}

function foldAway() {
  const island = $('island')
  clearTimeout(settle)
  report([])
  // The last frame before it goes is the only place the idle face shows.
  for (const face of document.querySelectorAll('.face')) face.dataset.face = 'idle'
  expanded = false
  $('pill2').toggleAttribute('data-gone', true)
  if (housing) box(island, tucked(layout, housing))
  island.dataset.state = 'tucked'
  setTimeout(() => {
    if (!model) document.body.toggleAttribute('data-asleep', true)
  }, SETTLE_MS)
}

window.__notch = {
  render(next) {
    layout = next.layout
    housing = next.housing
    const leaving = model && !next.model
    model = next.model
    if (model) {
      document.body.removeAttribute('data-asleep')
      draw()
    } else if (leaving) {
      foldAway()
    }
  },
  setExpanded(next) {
    if (expanded === next) return
    expanded = next
    if (!expanded) for (const row of document.querySelectorAll('.row.hot')) row.classList.remove('hot')
    if (model) draw()
  },
  /** WebKit gives a window that is never key no hover, so the shell forwards the pointer. */
  pointer(x, y) {
    const hit = document.elementFromPoint(x, y)?.closest('.row')
    for (const row of document.querySelectorAll('.row.hot')) if (row !== hit) row.classList.remove('hot')
    hit?.classList.add('hot')
  },
}

document.addEventListener('click', (event) => {
  const manager = event.target.closest('[data-id]')
  if (manager) {
    invoke('notch_open_manager', { id: manager.dataset.id })
  } else if (!expanded && event.target.closest('#island, #pill2')) {
    invoke('notch_expand')
  }
})

invoke('notch_ready')
